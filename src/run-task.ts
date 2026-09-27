import { Notice, Plugin, requestUrl } from "obsidian";

/**
 * Life-canvas node → headless task. A canvas card containing a link like
 * `[▶ Run grocery](obsidian://po-run?slug=grocery)` becomes a tappable button
 * that POSTs {slug} to the broker's /po/run (same authenticated wss front the
 * ask-loop and terminal use: Caddy :7890/po → loopback :7893). po-run.sh is the
 * security boundary — it allowlists the slug by charset AND an authored orders
 * file, so this can only launch a task we wrote. The headless session's
 * questions surface back as native ask-modals via the proven P1 loop.
 *
 * Reliability (0.4.12): the CLICK path is an `obsidian://po-run` protocol
 * handler — Obsidian's own link handling fires it regardless of whether our
 * markdown post-processor has run, so a cold Canvas reopen can never leave a
 * dead button (worst case it's an unstyled but working link). The post-processor
 * is now only cosmetic — it styles the anchor into a `.po-run-button` and also
 * catches the legacy `po-run:` scheme + inline-code `` `po-run:<slug>` `` tokens,
 * re-scanning on canvas layout events since cards paint before plugins load.
 */

const LEGACY_LINK_PREFIX = "po-run:";
const PROTO_PREFIX = "obsidian://po-run";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const UPGRADED = "poRunUpgraded"; // dataset marker, guards against double-processing

/** POST {slug} to the broker's /po/run and surface the one-word result as a Notice. */
export async function runTask(brokerBase: string, slug: string): Promise<void> {
  const base = brokerBase.replace(/\/$/, "");
  if (!base) {
    new Notice("PocketOracle: broker not configured (set wsUrl or brokerUrl).");
    return;
  }
  if (!SLUG_RE.test(slug)) {
    new Notice(`PocketOracle: bad task slug "${slug}".`);
    return;
  }
  new Notice(`PocketOracle: running "${slug}"…`);
  try {
    const res = await requestUrl({
      url: `${base}/run`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
      throw: false,
    });
    const result: string =
      (res.json?.result as string) ?? (res.status === 200 ? "launched" : "error");
    new Notice(runResultMessage(slug, result));
  } catch {
    new Notice(`PocketOracle: "${slug}" — network error reaching the broker.`);
  }
}

function runResultMessage(slug: string, result: string): string {
  switch (result) {
    case "launched":
    case "already-running":
      return `PocketOracle: "${slug}" started — watch for the modal.`;
    case "no-device":
      return `PocketOracle: "${slug}" not started — no device watching. Open the Oracle pane and tap again.`;
    case "no-orders":
      return `PocketOracle: no orders file for "${slug}".`;
    case "bad-slug":
      return `PocketOracle: "${slug}" rejected (bad slug).`;
    default:
      return `PocketOracle: "${slug}" → ${result}.`;
  }
}

/** Pull a slug from `po-run:<slug>`, `obsidian://po-run?slug=<slug>`, or a bare-slug line. */
export function extractSlug(text: string): string | null {
  const proto = text.match(/obsidian:\/\/po-run\?slug=([a-z0-9][a-z0-9-]{0,40})/i);
  if (proto) return proto[1].toLowerCase();
  const link = text.match(/po-run:([a-z0-9][a-z0-9-]{0,40})/i);
  if (link) return link[1].toLowerCase();
  const bare = text.trim().match(/^([a-z0-9][a-z0-9-]{0,40})$/i);
  return bare ? bare[1].toLowerCase() : null;
}

/**
 * The reliable click path: register `obsidian://po-run?slug=<slug>` as a protocol
 * handler. Obsidian fires this on any tap of such a link — in a note, a Canvas
 * card, anywhere — with no dependency on our markdown post-processor having run.
 * This is what makes a cold Canvas reopen safe: even an unstyled link still works.
 */
export function registerRunProtocol(plugin: Plugin, getBase: () => string): void {
  plugin.registerObsidianProtocolHandler("po-run", (params) => {
    const slug = (params.slug || "").toLowerCase();
    if (!slug) {
      new Notice("PocketOracle: po-run link had no slug.");
      return;
    }
    void runTask(getBase(), slug);
  });
}

/** Style one anchor/element into a button. Idempotent via the UPGRADED marker. */
function upgradeElement(el: HTMLElement, slug: string, getBase: () => string, plugin: Plugin): void {
  if (el.dataset[UPGRADED]) return;
  el.dataset[UPGRADED] = "1";
  el.dataset.poRunSlug = slug;
  el.addClass("po-run-button");
  el.setAttribute("role", "button");
  // For a legacy `po-run:` or code-span element there is no native handler, so we
  // must attach one. For an `obsidian://po-run` anchor the protocol handler ALSO
  // fires; we keep the href so the native path still works if this listener is torn
  // down, and preventDefault only the double-dispatch on our own click.
  const href = el.getAttribute("href") || "";
  const isProto = href.startsWith(PROTO_PREFIX);
  if (!isProto) el.removeAttribute("href"); // legacy/code span: no navigation target
  plugin.registerDomEvent(el, "click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void runTask(getBase(), slug);
  });
}

/** Scan a rendered DOM subtree and style every po-run link/token into a button. */
function scan(root: ParentNode, getBase: () => string, plugin: Plugin): void {
  // 1. obsidian://po-run anchors (the primary, reliable form).
  root
    .querySelectorAll<HTMLAnchorElement>(`a[href^="${PROTO_PREFIX}"]`)
    .forEach((a) => {
      const slug = extractSlug(a.getAttribute("href") || "");
      if (slug) upgradeElement(a, slug, getBase, plugin);
    });
  // 2. Legacy po-run: scheme anchors.
  root
    .querySelectorAll<HTMLAnchorElement>(`a[href^="${LEGACY_LINK_PREFIX}"]`)
    .forEach((a) => {
      const slug = (a.getAttribute("href") || "").slice(LEGACY_LINK_PREFIX.length).trim();
      if (SLUG_RE.test(slug)) upgradeElement(a, slug, getBase, plugin);
    });
  // 3. Inline-code `po-run:<slug>` — code spans render reliably on Canvas cards
  //    even when unknown-scheme links get flattened to plain text.
  root.querySelectorAll<HTMLElement>("code").forEach((c) => {
    const txt = (c.textContent || "").trim();
    if (!txt.startsWith(LEGACY_LINK_PREFIX)) return;
    const slug = txt.slice(LEGACY_LINK_PREFIX.length).trim();
    if (SLUG_RE.test(slug)) upgradeElement(c, slug, getBase, plugin);
  });
}

/**
 * Cosmetic styling pass. The markdown post-processor handles freshly-rendered
 * markdown; the workspace-event re-scans handle Canvas cards that painted before
 * the plugin loaded (cold reopen) or re-render on navigation. The click itself is
 * guaranteed by registerRunProtocol — this only makes the link LOOK like a button.
 */
export function registerRunLinks(plugin: Plugin, getBase: () => string): void {
  plugin.registerMarkdownPostProcessor((el) => scan(el, getBase, plugin));

  // Canvas cards can paint before onload finishes registering the post-processor,
  // so re-scan the whole document after layout settles and on navigation. The
  // UPGRADED marker makes repeated scans cheap and idempotent.
  const rescan = () => window.setTimeout(() => scan(document.body, getBase, plugin), 60);
  plugin.app.workspace.onLayoutReady(rescan);
  plugin.registerEvent(plugin.app.workspace.on("layout-change", rescan));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", rescan));
  plugin.registerEvent(plugin.app.workspace.on("file-open", rescan));
}

/**
 * Fallback command: fire the task for the currently-selected Canvas node, in case
 * the node's text isn't rendered as a clickable link (e.g. a bare-slug node). The
 * Canvas view internals are semi-private, so everything here is typeof-guarded and
 * fails soft with a Notice.
 */
export function runActiveCanvasNode(plugin: Plugin, getBase: () => string): void {
  // activeLeaf is deprecated in the typings but is the reliable way to reach the
  // focused Canvas view; cast through any and guard by view type.
  const view = (plugin.app.workspace as { activeLeaf?: { view?: unknown } }).activeLeaf?.view as
    | { getViewType?: () => string; canvas?: { selection?: Set<unknown> } }
    | undefined;
  if (!view || view.getViewType?.() !== "canvas") {
    new Notice("PocketOracle: open a Canvas and select a node first.");
    return;
  }
  const sel = view.canvas?.selection;
  if (!sel || sel.size === 0) {
    new Notice("PocketOracle: select a canvas node with a po-run:<slug> link.");
    return;
  }
  let text = "";
  for (const node of sel) {
    const n = node as { text?: unknown; getData?: () => { text?: unknown } };
    const t =
      typeof n.text === "string"
        ? n.text
        : typeof n.getData === "function" && typeof n.getData()?.text === "string"
          ? (n.getData()!.text as string)
          : "";
    if (t) {
      text = t;
      break;
    }
  }
  const slug = extractSlug(text);
  if (!slug) {
    new Notice("PocketOracle: no po-run:<slug> found in the selected node.");
    return;
  }
  void runTask(getBase(), slug);
}
