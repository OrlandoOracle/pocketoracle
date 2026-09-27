import { Notice, Plugin, requestUrl } from "obsidian";

/**
 * Life-canvas node → headless task. A canvas card containing a link like
 * `[▶ Run grocery](po-run:grocery)` becomes a tappable button that POSTs
 * {slug} to the broker's /po/run (same authenticated wss front the ask-loop
 * and terminal use: Caddy :7890/po → loopback :7893). po-run.sh is the
 * security boundary — it allowlists the slug by charset AND an authored
 * orders file, so this can only launch a task we wrote. The headless session's
 * questions surface back as native ask-modals via the proven P1 loop.
 */

const RUN_LINK_PREFIX = "po-run:";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

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

/** Pull a slug from `po-run:<slug>` anywhere in the text, or a bare-slug line. */
export function extractSlug(text: string): string | null {
  const link = text.match(/po-run:([a-z0-9][a-z0-9-]{0,40})/i);
  if (link) return link[1].toLowerCase();
  const bare = text.trim().match(/^([a-z0-9][a-z0-9-]{0,40})$/i);
  return bare ? bare[1].toLowerCase() : null;
}

/**
 * Turn every rendered `po-run:<slug>` link into a tappable button. Runs on all
 * rendered markdown including Canvas card nodes, so this is the primary path.
 */
export function registerRunLinks(plugin: Plugin, getBase: () => string): void {
  plugin.registerMarkdownPostProcessor((el) => {
    const links = el.querySelectorAll<HTMLAnchorElement>(`a[href^="${RUN_LINK_PREFIX}"]`);
    links.forEach((a) => {
      const slug = (a.getAttribute("href") || "").slice(RUN_LINK_PREFIX.length).trim();
      a.addClass("po-run-button");
      // Kill navigation — this is a button, not a link. Keep the slug for the handler.
      a.removeAttribute("href");
      a.setAttribute("role", "button");
      a.dataset.poRunSlug = slug;
      plugin.registerDomEvent(a, "click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void runTask(getBase(), slug);
      });
    });
  });
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
