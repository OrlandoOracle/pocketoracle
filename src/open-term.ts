import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { SLUG_CHARS, SLUG_RE, slugCapture } from "./slug";
import { PoTermView, VIEW_TYPE_PO_TERM } from "./node-terminal-view";

/**
 * Canvas node → per-project tmux terminal. Clones the `run-task.ts` `po-run:`
 * trigger pattern precisely (protocol handler as the reliable click path, a
 * markdown post-processor + DOM click intercept as the cosmetic/legacy path)
 * but opens a live `po-term` ItemView instead of POSTing to the broker.
 *
 * A canvas card containing `[▶ Open LookingGlass](obsidian://po-open?slug=LookingGlass)`
 * or the inline-code token `` `po-open:LookingGlass` `` becomes a tappable button
 * that opens/reveals the node terminal for that slug.
 *
 * Source: ~/Deborah/03-Resources/Research/pocketoracle-node-terminals-research-2026-09-27.md
 * §(d) (link intercept is the mobile-robust trigger; canvas internals are fragile),
 * §Footguns 14. ~/Deborah/01-Projects/project-gallery/NODE-TERMINALS-BUILD.md (U4).
 */

const LEGACY_LINK_PREFIX = "po-open:";
const PROTO_PREFIX = "obsidian://po-open";
const UPGRADED = "poOpenUpgraded"; // dataset marker, guards against double-processing
const FULLSCREEN_BODY_CLASS = "po-term-fullscreen";

/** Pull a slug from `po-open:<slug>`, `obsidian://po-open?slug=<slug>`, or a bare-slug line.
 *  Case-preserving — mixed-case project slugs (`LookingGlass`, `AFHC-AI-Training`)
 *  are valid on the shell side, so this must not normalize case. */
export function extractSlug(text: string): string | null {
  const proto = text.match(slugCapture("obsidian://po-open\\?slug="));
  if (proto) return proto[1];
  const link = text.match(slugCapture(LEGACY_LINK_PREFIX));
  if (link) return link[1];
  const bare = text.trim().match(new RegExp(`^(${SLUG_CHARS})$`));
  return bare ? bare[1] : null;
}

function isCanvasLeaf(leaf: WorkspaceLeaf | null | undefined): boolean {
  return !!leaf && leaf.view?.getViewType?.() === "canvas";
}

/** Best-effort collapse of the side drawers so the node terminal owns the
 *  whole screen on iPad — NOT openPopoutLeaf/moveLeafToPopout, which throw on
 *  mobile. Guarded because a desktop layout may not have a drawer. */
function collapseSideDrawers(plugin: Plugin): void {
  try {
    plugin.app.workspace.leftSplit?.collapse();
  } catch {
    /* no left split in this layout */
  }
  try {
    plugin.app.workspace.rightSplit?.collapse();
  } catch {
    /* no right split in this layout */
  }
}

/**
 * Toggle a body class that hides the tab header chrome while a `po-term` view
 * is the active leaf, and restores it otherwise. Registered once at plugin
 * load; safe to call multiple times (idempotent, auto-torn-down via
 * `registerEvent`).
 */
export function registerFullScreenSync(plugin: Plugin): void {
  const sync = (): void => {
    const active = plugin.app.workspace.getActiveViewOfType(PoTermView);
    document.body.classList.toggle(FULLSCREEN_BODY_CLASS, !!active);
  };
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", sync));
  plugin.app.workspace.onLayoutReady(sync);
}

/**
 * Open (or reveal, if already open) the `po-term` view for `slug`. Dedup scans
 * every live `po-term` leaf by `getState().slug` before creating a new one —
 * one canvas node, one tmux session, one terminal leaf; re-tapping a node
 * that's already open must reveal, never duplicate (a second live WS would
 * mean a second `psession`/ttyd child for the same tmux target).
 */
export async function openTerminalForSlug(plugin: Plugin, slug: string): Promise<void> {
  if (!SLUG_RE.test(slug)) {
    new Notice(`PocketOracle: bad terminal slug "${slug}".`);
    return;
  }
  const workspace = plugin.app.workspace;

  // Best-effort: remember the canvas we tapped from, for the in-pane "back" action.
  const active = workspace.getMostRecentLeaf?.() ?? workspace.activeLeaf ?? null;
  const originLeaf = isCanvasLeaf(active) ? active : null;

  for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_PO_TERM)) {
    await leaf.loadIfDeferred();
    const view = leaf.view;
    if (view instanceof PoTermView && (view.getState().slug as string | undefined) === slug) {
      workspace.setActiveLeaf(leaf, { focus: true });
      await workspace.revealLeaf(leaf);
      collapseSideDrawers(plugin);
      view.setOriginLeaf(originLeaf);
      return;
    }
  }

  const leaf = workspace.getLeaf("tab");
  await leaf.setViewState({ type: VIEW_TYPE_PO_TERM, state: { slug }, active: true });
  await workspace.revealLeaf(leaf);
  collapseSideDrawers(plugin);
  await leaf.loadIfDeferred();
  const view = leaf.view;
  if (view instanceof PoTermView) view.setOriginLeaf(originLeaf);
}

/** The reliable click path — mirrors registerRunProtocol in run-task.ts. */
export function registerOpenProtocol(plugin: Plugin): void {
  plugin.registerObsidianProtocolHandler("po-open", (params) => {
    const slug = params.slug || "";
    if (!slug) {
      new Notice("PocketOracle: po-open link had no slug.");
      return;
    }
    void openTerminalForSlug(plugin, slug);
  });
}

/** Style one anchor/element into a button. Idempotent via the UPGRADED marker. */
function upgradeElement(el: HTMLElement, slug: string, plugin: Plugin): void {
  if (el.dataset[UPGRADED]) return;
  el.dataset[UPGRADED] = "1";
  el.dataset.poOpenSlug = slug;
  el.addClass("po-open-button");
  el.setAttribute("role", "button");
  const href = el.getAttribute("href") || "";
  const isProto = href.startsWith(PROTO_PREFIX);
  if (!isProto) el.removeAttribute("href"); // legacy/code span: no navigation target
  plugin.registerDomEvent(el, "click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void openTerminalForSlug(plugin, slug);
  });
}

/** Scan a rendered DOM subtree and style every po-open link/token into a button. */
function scan(root: ParentNode, plugin: Plugin): void {
  root
    .querySelectorAll<HTMLAnchorElement>(`a[href^="${PROTO_PREFIX}"]`)
    .forEach((a) => {
      const slug = extractSlug(a.getAttribute("href") || "");
      if (slug) upgradeElement(a, slug, plugin);
    });
  root
    .querySelectorAll<HTMLAnchorElement>(`a[href^="${LEGACY_LINK_PREFIX}"]`)
    .forEach((a) => {
      const slug = (a.getAttribute("href") || "").slice(LEGACY_LINK_PREFIX.length).trim();
      if (SLUG_RE.test(slug)) upgradeElement(a, slug, plugin);
    });
  root.querySelectorAll<HTMLElement>("code").forEach((c) => {
    const txt = (c.textContent || "").trim();
    if (!txt.startsWith(LEGACY_LINK_PREFIX)) return;
    const slug = txt.slice(LEGACY_LINK_PREFIX.length).trim();
    if (SLUG_RE.test(slug)) upgradeElement(c, slug, plugin);
  });
}

/** Cosmetic styling pass — mirrors registerRunLinks in run-task.ts. */
export function registerOpenLinks(plugin: Plugin): void {
  plugin.registerMarkdownPostProcessor((el) => scan(el, plugin));

  const rescan = () => window.setTimeout(() => scan(document.body, plugin), 60);
  plugin.app.workspace.onLayoutReady(rescan);
  plugin.registerEvent(plugin.app.workspace.on("layout-change", rescan));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", rescan));
  plugin.registerEvent(plugin.app.workspace.on("file-open", rescan));
}

/**
 * Slice-2 — whole-card tap-to-launch. Makes the ENTIRE canvas node a launch
 * target (springboard feel), not just a link rendered inside it.
 *
 * Robust by construction, per the research §(d)/footgun-14 ruling: this touches
 * NO canvas runtime internals (`canvas.nodes`, monkey-patched onDoubleClick) —
 * those break on Obsidian updates and turn double-click into double-tap on
 * touch. It is a single capturing `document` click listener that reasons purely
 * over the rendered DOM:
 *
 *   - A clean click (press+release, no drag) is the "open" intent. Dragging a
 *     card to move it fires pointer/drag events, NOT click — so tap-to-open and
 *     drag-to-move never collide, and there's no double-tap gesture to fight the
 *     canvas's own double-click-to-edit.
 *   - The slug comes from the tapped `.canvas-node`'s rendered text via the same
 *     `extractSlug` the link path uses, so a bare `po-open:<slug>` line, an
 *     inline-code token, or a full markdown link all work identically.
 *   - Cards with no `po-open:` token are left completely alone (returns null),
 *     so mixed canvases (Life.canvas) keep normal select/drag behaviour.
 *
 * Guards: never fires while the node is being text-edited (an open editor would
 * mean the user is typing, not launching), and yields to the per-link
 * `.po-open-button` handler so a click that lands on an actual upgraded link
 * isn't double-dispatched.
 */
export function registerCanvasNodeTap(plugin: Plugin): void {
  plugin.registerDomEvent(
    document,
    "click",
    (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;

      // Yield to any interactive element inside the card — a po-open button, a
      // po-run task link, or any other anchor/button. Those own their own click
      // (e.g. nMeals' `[▶ Run grocery]` po-run link), so a tap on them must NOT
      // also whole-card-launch a terminal. Only a tap on the card BODY launches.
      if (target.closest("a, button, .po-open-button, .po-run-button")) return;

      const card = target.closest<HTMLElement>(".canvas-node");
      if (!card) return;

      // Don't launch while the card is in text-edit mode — the user is typing,
      // not opening. Obsidian marks the editing node and mounts an editor.
      if (
        card.classList.contains("is-editing") ||
        card.querySelector(".is-editing, textarea, [contenteditable='true']")
      ) {
        return;
      }

      // A drag-select of text inside the card shouldn't launch either.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && card.contains(selection.anchorNode)) {
        return;
      }

      const slug = slugFromCard(card);
      if (!slug) return; // not a launch tile — leave native select/drag intact

      ev.preventDefault();
      ev.stopPropagation();
      void openTerminalForSlug(plugin, slug);
    },
    { capture: true },
  );
}

/** Pull a po-open slug out of a rendered canvas card: prefer an explicit link's
 *  href (protocol or legacy), then any `po-open:` code token, then the card's
 *  whole text (a bare `po-open:<slug>` / bare-slug line). Case-preserving. */
function slugFromCard(card: HTMLElement): string | null {
  const link = card.querySelector<HTMLAnchorElement>(
    `a[href^="${PROTO_PREFIX}"], a[href^="${LEGACY_LINK_PREFIX}"]`,
  );
  if (link) {
    const s = extractSlug(link.getAttribute("href") || "");
    if (s) return s;
  }
  for (const code of Array.from(card.querySelectorAll<HTMLElement>("code"))) {
    const s = extractSlug((code.textContent || "").trim());
    if (s) return s;
  }
  // Whole-card text fallback, but ONLY when an explicit `po-open:` marker is
  // present — never the bare-slug branch of extractSlug, which would turn any
  // single-word title card into an accidental launch tile.
  const text = (card.textContent || "").trim();
  if (text.includes(LEGACY_LINK_PREFIX)) return extractSlug(text);
  return null;
}

/** Fallback command: open the terminal for the currently-selected Canvas node,
 *  mirroring `runActiveCanvasNode` in run-task.ts. */
export function openActiveCanvasNodeTerminal(plugin: Plugin): void {
  const view = (plugin.app.workspace as { activeLeaf?: { view?: unknown } }).activeLeaf?.view as
    | { getViewType?: () => string; canvas?: { selection?: Set<unknown> } }
    | undefined;
  if (!view || view.getViewType?.() !== "canvas") {
    new Notice("PocketOracle: open a Canvas and select a node first.");
    return;
  }
  const sel = view.canvas?.selection;
  if (!sel || sel.size === 0) {
    new Notice("PocketOracle: select a canvas node with a po-open:<slug> link.");
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
    new Notice("PocketOracle: no po-open:<slug> found in the selected node.");
    return;
  }
  void openTerminalForSlug(plugin, slug);
}
