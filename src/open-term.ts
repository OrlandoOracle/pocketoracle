import { Notice, Plugin, SuggestModal, TFolder, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { SLUG_CHARS, SLUG_RE, slugCapture } from "./slug";
import { PoTermView, VIEW_TYPE_PO_TERM } from "./node-terminal-view";
import { runTask, extractSlug as extractRunSlug } from "./run-task";

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
const RUN_LEGACY_LINK_PREFIX = "po-run:";
const RUN_PROTO_PREFIX = "obsidian://po-run";
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
 * Rides on POINTER events, not `click`: on iOS the canvas swallows the synthetic
 * `click` before it reaches a document listener (this is why the command-driven
 * picker exists as a fallback), but the lower-level `pointerup` propagates. Per
 * the 2026-09-29 decision "canvas whole-card TAP -> same launch, via pointerup
 * not the iOS-swallowed click", this is the path that makes the springboard work
 * on the iPad, not just the desktop.
 *
 * Robust by construction, per the research §(d)/footgun-14 ruling: it touches NO
 * canvas runtime internals (`canvas.nodes`, monkey-patched onDoubleClick) —
 * those break on Obsidian updates and turn double-click into double-tap on
 * touch. It is a pair of capturing `document` pointer listeners that reason
 * purely over the rendered DOM:
 *
 *   - A clean TAP (pointerdown then pointerup at ~the same spot within a short
 *     window) is the "open" intent. Dragging a card to move it, or a text
 *     drag-select, travels past the tolerance and is left to the canvas
 *     untouched — so tap-to-open and drag-to-move never collide, and there's no
 *     double-tap gesture to fight the canvas's own double-click-to-edit.
 *   - The slug comes from the tapped `.canvas-node`'s rendered text via the same
 *     `extractSlug` the link path uses, so a bare `po-open:<slug>` line, an
 *     inline-code token, or a full markdown link all work identically.
 *   - BOTH card kinds launch (2026-09-29 decision "any card tappable"): a
 *     `po-open:<slug>` card opens a per-project terminal; a `po-run:<slug>` card
 *     fires its headless task (the grocery-style modal loop) via the broker. A
 *     card carrying a po-open marker wins if it somehow has both.
 *   - Cards with neither token are left completely alone (returns null), so
 *     mixed canvases (Life.canvas) keep normal select/drag behaviour.
 *
 * Guards: never fires while the node is being text-edited (an open editor would
 * mean the user is typing, not launching), and yields to the per-link
 * `.po-open-button` / `.po-run-button` handlers so a tap that lands on an actual
 * upgraded link isn't double-dispatched.
 */
export function registerCanvasNodeTap(plugin: Plugin, getBase: () => string): void {
  const TAP_MOVE_TOL = 10; // px of travel still counts as a tap, not a drag
  const TAP_TIME_TOL = 700; // ms; a longer press is a long-press/context, not a launch
  const starts = new Map<number, { x: number; y: number; t: number }>();

  plugin.registerDomEvent(
    document,
    "pointerdown",
    (ev: PointerEvent) => {
      starts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, t: ev.timeStamp });
    },
    { capture: true },
  );

  // iOS scroll/gesture takeover fires pointercancel — drop the pending start so
  // a later pointerup can't be mistaken for a tap.
  plugin.registerDomEvent(
    document,
    "pointercancel",
    (ev: PointerEvent) => {
      starts.delete(ev.pointerId);
    },
    { capture: true },
  );

  plugin.registerDomEvent(
    document,
    "pointerup",
    (ev: PointerEvent) => {
      const start = starts.get(ev.pointerId);
      starts.delete(ev.pointerId);
      if (!start) return;

      // Drag-to-move / drag-select / long-press → not a launch; leave native
      // canvas behaviour intact.
      if (
        Math.abs(ev.clientX - start.x) > TAP_MOVE_TOL ||
        Math.abs(ev.clientY - start.y) > TAP_MOVE_TOL ||
        ev.timeStamp - start.t > TAP_TIME_TOL
      ) {
        return;
      }

      const target = ev.target as HTMLElement | null;
      if (!target) return;

      // Yield to any interactive element inside the card — a po-open button, a
      // po-run task link, or any other anchor/button. Those own their own tap
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

      const openSlug = slugFromCard(card);
      if (openSlug) {
        ev.preventDefault();
        ev.stopPropagation();
        void openTerminalForSlug(plugin, openSlug);
        return;
      }

      const runSlug = runSlugFromCard(card);
      if (runSlug) {
        ev.preventDefault();
        ev.stopPropagation();
        void runTask(getBase(), runSlug);
        return;
      }

      // Neither a po-open nor a po-run tile — leave native select/drag intact.
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

/** Pull a po-run slug out of a rendered canvas card — same strategy as
 *  `slugFromCard`, but for the headless-task trigger (`po-run:<slug>` /
 *  `obsidian://po-run?slug=`). Used by the whole-card tap so a grocery-style task
 *  card fires on a body tap too, not just its `[▶ Run]` link. Case-preserving. */
function runSlugFromCard(card: HTMLElement): string | null {
  const link = card.querySelector<HTMLAnchorElement>(
    `a[href^="${RUN_PROTO_PREFIX}"], a[href^="${RUN_LEGACY_LINK_PREFIX}"]`,
  );
  if (link) {
    const s = extractRunSlug(link.getAttribute("href") || "");
    if (s) return s;
  }
  for (const code of Array.from(card.querySelectorAll<HTMLElement>("code"))) {
    const s = extractRunSlug((code.textContent || "").trim());
    if (s) return s;
  }
  // Whole-card text fallback, but ONLY when an explicit po-run marker is present
  // — never the bare-slug branch, which would turn any title card into a task tile.
  const text = (card.textContent || "").trim();
  if (text.includes(RUN_LEGACY_LINK_PREFIX) || text.includes(RUN_PROTO_PREFIX)) {
    return extractRunSlug(text);
  }
  return null;
}

/** Extract every distinct po-open slug from a `.canvas` file's node texts by
 *  reading the file JSON directly — NOT the canvas runtime. This is the whole
 *  point: on mobile `view.canvas.selection` is empty and the canvas node API is
 *  unavailable, so the desktop selection path (below) silently yields nothing.
 *  The on-disk `.canvas` is plain JSON and reads identically on every platform.
 *  Order-preserving, deduped. */
async function slugsInCanvasFile(app: App, file: TFile): Promise<string[]> {
  let raw: string;
  try {
    raw = await app.vault.read(file);
  } catch {
    return [];
  }
  let data: { nodes?: Array<{ text?: unknown }> };
  try {
    data = JSON.parse(raw) as { nodes?: Array<{ text?: unknown }> };
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of data.nodes ?? []) {
    const text = typeof node?.text === "string" ? node.text : "";
    if (!text) continue;
    const slug = extractSlug(text);
    if (slug && SLUG_RE.test(slug) && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

/** A tap-picker of project slugs — the mobile-robust launch path. Command-driven,
 *  so it never depends on a canvas click reaching the plugin (iOS canvas swallows
 *  the synthetic click) nor on `canvas.selection` (empty on mobile). */
class PoSlugSuggestModal extends SuggestModal<string> {
  constructor(
    app: App,
    private slugs: string[],
    private onChoose: (slug: string) => void,
  ) {
    super(app);
    this.setPlaceholder("Open which project terminal?");
  }
  getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    return q ? this.slugs.filter((s) => s.toLowerCase().includes(q)) : this.slugs;
  }
  renderSuggestion(slug: string, el: HTMLElement): void {
    el.createEl("div", { text: slug });
  }
  onChooseSuggestion(slug: string): void {
    this.onChoose(slug);
  }
}

/** Every `01-Projects/<slug>` folder name that is a valid slug — the reliable,
 *  canvas-INDEPENDENT project list. Reads the loaded file tree, which is present
 *  identically on mobile and desktop, so it never comes up empty on iPad the way
 *  a canvas read does: the canvas file may not even be synced to the device (the
 *  iPad's LiveSync vault had no Life.canvas at all — 2026-09-29). Sorted. */
function projectFolderSlugs(app: App): string[] {
  const out: string[] = [];
  for (const f of app.vault.getAllLoadedFiles()) {
    if (
      f instanceof TFolder &&
      f.parent &&
      f.parent.path.toLowerCase() === "01-projects" &&
      SLUG_RE.test(f.name)
    ) {
      out.push(f.name);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Command: open a per-project node terminal. Mobile-proof — prefers a genuine
 *  desktop canvas selection when one exists, but otherwise builds a tap-picker
 *  from the vault's 01-Projects/<slug> folders (always readable on mobile) merged
 *  with any po-open nodes in the active canvas. Decoupled from canvas content on
 *  purpose: the whole-card tap never reaches the plugin on iOS, the selection API
 *  is empty on mobile, AND the canvas file itself may not be synced to the device
 *  — so the folder list is the one source that is always present. */
export async function openActiveCanvasNodeTerminal(plugin: Plugin): Promise<void> {
  // Fast path — desktop: a genuinely selected canvas node carrying a po-open slug.
  const view = (plugin.app.workspace as { activeLeaf?: { view?: unknown } }).activeLeaf?.view as
    | { getViewType?: () => string; canvas?: { selection?: Set<unknown> } }
    | undefined;
  const sel = view?.getViewType?.() === "canvas" ? view?.canvas?.selection : undefined;
  if (sel && sel.size > 0) {
    for (const node of sel) {
      const n = node as { text?: unknown; getData?: () => { text?: unknown } };
      const t =
        typeof n.text === "string"
          ? n.text
          : typeof n.getData === "function" && typeof n.getData()?.text === "string"
            ? (n.getData()!.text as string)
            : "";
      const slug = t ? extractSlug(t) : null;
      if (slug) {
        void openTerminalForSlug(plugin, slug);
        return;
      }
    }
  }

  // Mobile / no-selection path. Merge TWO slug sources so it never dead-ends:
  //   1. the active canvas file's po-open nodes (best-effort — may be empty, or
  //      the canvas may not even be synced to this device);
  //   2. the vault's 01-Projects/<slug> folders — ALWAYS present on mobile.
  // Source 2 is the fix for the iPad, where a canvas-only read found nothing.
  const slugs = new Set<string>();
  const file = plugin.app.workspace.getActiveFile();
  if (file && file.extension === "canvas") {
    for (const s of await slugsInCanvasFile(plugin.app, file)) slugs.add(s);
  }
  for (const s of projectFolderSlugs(plugin.app)) slugs.add(s);

  const list = [...slugs];
  if (list.length === 0) {
    new Notice("PocketOracle: no projects found under 01-Projects/ to open.");
    return;
  }
  if (list.length === 1) {
    void openTerminalForSlug(plugin, list[0]);
    return;
  }
  new PoSlugSuggestModal(plugin.app, list, (slug) => void openTerminalForSlug(plugin, slug)).open();
}
