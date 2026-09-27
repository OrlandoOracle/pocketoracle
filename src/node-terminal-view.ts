import { ItemView, Notice, Platform, type WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { TtydClient } from "./ttyd-client";
import { ensureXtermCss } from "./terminal-view";
import type { PocketOracleSettings } from "./settings";

/**
 * Per-project tmux terminal ("node terminal" — U4 of the node-terminals build).
 * One `po-term` ItemView TYPE, many instances, each keyed by `state.slug`. A
 * canvas node tap (`po-open:<slug>`, see open-term.ts) opens/reveals the leaf
 * whose slug matches; the socket targets ttyd's `-a`/`--url-arg` per-connection
 * routing (`wss://<host>:7890/node/ws?arg=<slug>`, subprotocol `tty`), which
 * spawns `po-node <slug>` → `psession <slug>` server-side — same tmux session
 * `p/<slug>` the Mac and every other PocketOracle surface use.
 *
 * Deferred-view safe: all socket/terminal setup happens in onOpen/setState via
 * `maybeConnect()`, never the constructor, so Obsidian's since-1.7.2 deferred
 * view gives "restore on tap" for free — a leaf sitting in a background tab
 * costs nothing until it's actually shown.
 *
 * Source: ~/Deborah/03-Resources/Research/pocketoracle-node-terminals-research-2026-09-27.md
 * §(a) (ttyd per-connection targeting), §(d) (Obsidian plugin API: deferred
 * views, full-screen, cleanup).
 */
export const VIEW_TYPE_PO_TERM = "po-term";

// Reuse the same Oracle-dark palette as the main terminal view — a node
// terminal should read as the same surface, not a second product.
const ORACLE_THEME = {
  background: "#120e19",
  foreground: "#f4f1fb",
  cursor: "#c8a2ff",
  cursorAccent: "#120e19",
  selectionBackground: "#42346a",
  black: "#2a2140",
  red: "#ff7d99",
  green: "#9ce6ad",
  yellow: "#f2d59a",
  blue: "#9cc0ff",
  magenta: "#d3b0ff",
  cyan: "#93e2ec",
  white: "#e8e3f2",
  brightBlack: "#6b6090",
  brightRed: "#ff97b1",
  brightGreen: "#b6f0c4",
  brightYellow: "#f9e3b2",
  brightBlue: "#bcd4ff",
  brightMagenta: "#e3c8ff",
  brightCyan: "#aef0f7",
  brightWhite: "#ffffff",
};

const RECONNECT_FLOOR_MS = 1000;
const RECONNECT_CAP_MS = 15000;
const HEARTBEAT_MS = 12000;

const KEY_BAR: ReadonlyArray<{ label: string; seq: string }> = [
  { label: "Esc", seq: "\x1b" },
  { label: "^C", seq: "\x03" },
  { label: "Tab", seq: "\t" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
];

/**
 * Derive the node ttyd endpoint from the SAME wsUrl setting the main terminal
 * uses — no separate host config. `wss://host:7890/ws` → `wss://host:7890/node/ws?arg=<slug>`.
 * Reuses whatever host/port the user already pointed PocketOracle at (the
 * Caddy `/node/*` route lives on the same :7890 front, per U3).
 */
export function deriveNodeWsUrl(wsUrl: string, slug: string): string {
  try {
    const u = new URL(wsUrl);
    u.pathname = "/node/ws";
    u.search = `?arg=${encodeURIComponent(slug)}`;
    return u.toString();
  } catch {
    return "";
  }
}

export class PoTermView extends ItemView {
  private slug = "";
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private client: TtydClient | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private reconnectTimer: number | null = null;
  private resizeDebounce: number | null = null;
  private heartbeatTimer: number | null = null;
  private keyBarEl: HTMLElement | null = null;
  private hostEl: HTMLElement | null = null;
  private disposed = false;
  private backoffMs = RECONNECT_FLOOR_MS;
  private lastBuffered = 0;
  /** The leaf (usually a Canvas) this terminal was opened from — best-effort,
   *  not persisted, used only for the in-session "back" affordance. */
  private originLeaf: WorkspaceLeaf | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private settings: PocketOracleSettings,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PO_TERM;
  }

  getDisplayText(): string {
    return this.slug ? `Oracle · ${this.slug}` : "Oracle · node";
  }

  override getIcon(): string {
    return "square-terminal";
  }

  /** Persisted view state — what makes dedup-by-slug and layout-restore work. */
  override getState(): Record<string, unknown> {
    return { slug: this.slug };
  }

  override async setState(state: unknown, result: { history: boolean }): Promise<void> {
    const incoming = (state as { slug?: unknown } | null)?.slug;
    if (typeof incoming === "string" && incoming && incoming !== this.slug) {
      this.slug = incoming;
      this.app.workspace.trigger("layout-change");
      this.maybeConnect();
    }
    await super.setState(state, result);
  }

  /** Called by open-term.ts right after opening/revealing this leaf — records
   *  the origin leaf for the "back to canvas" action. Not part of view state
   *  on purpose (a WorkspaceLeaf isn't serializable); lost on reload, which is
   *  an acceptable trade — the leaf itself still restores via getState/slug. */
  setOriginLeaf(leaf: WorkspaceLeaf | null): void {
    this.originLeaf = leaf;
  }

  /** Return to the canvas we came from — or, if that leaf is gone (e.g. after a
   *  reload dropped the non-persisted originLeaf), fall back to the workspace's
   *  most-recent non-terminal leaf so mobile always lands somewhere navigable. */
  private goBack(): void {
    const ws = this.app.workspace;
    if (this.originLeaf) {
      void ws.revealLeaf(this.originLeaf);
      return;
    }
    const recent = ws.getMostRecentLeaf?.();
    if (recent && recent !== this.leaf) {
      ws.setActiveLeaf(recent, { focus: true });
      void ws.revealLeaf(recent);
      return;
    }
    new Notice("PocketOracle: no canvas to return to — use the tab switcher.");
  }

  override async onOpen(): Promise<void> {
    ensureXtermCss();
    const root = this.contentEl;
    root.empty();
    root.addClass("pocketoracle-view");
    root.addClass("po-term-view");

    this.addAction("arrow-left", "Back to canvas", () => this.goBack());

    // A floating in-pane escape. The header action above lives in the tab
    // header, which the mobile full-screen rule hides — so on mobile that
    // button vanishes and the only exit is the ribbon. This one is inside the
    // view content, styled visible only when the header is hidden, so there is
    // always a way out. (Desktop keeps its tab bar, so it stays hidden there.)
    const back = root.createEl("button", {
      cls: "po-term-escape",
      text: "‹ Back",
      attr: { "aria-label": "Back to canvas" },
    });
    back.addEventListener("click", (ev) => {
      ev.preventDefault();
      this.goBack();
    });

    if (!this.settings.wsUrl.trim()) {
      root.createDiv({
        cls: "pocketoracle-msg",
        text: "Set the ttyd websocket URL in PocketOracle settings, then reopen this pane.",
      });
      return;
    }
    if (!Platform.isDesktopApp && this.settings.wsUrl.startsWith("ws://")) {
      root.createDiv({
        cls: "pocketoracle-msg",
        text: "This device needs a wss:// URL — a plain ws:// gateway is blocked as mixed content here.",
      });
      return;
    }

    this.hostEl = root.createDiv({ cls: "pocketoracle-term-host" });
    this.maybeConnect();

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.forceReconnect();
    });
    this.registerDomEvent(window, "online", () => this.forceReconnect());
  }

  /**
   * Build the terminal + open the socket, but only once both a slug (from
   * setState) and a mounted host element (from onOpen) are available — those
   * two calls can happen in either order depending on whether the leaf was
   * deferred, so this is the single gate both paths funnel through. Guards
   * itself with `this.term` so it never double-builds.
   */
  private maybeConnect(): void {
    if (this.disposed || this.term || !this.slug || !this.hostEl) return;
    if (!this.settings.wsUrl.trim()) return; // onOpen already said so in the pane

    const nodeUrl = deriveNodeWsUrl(this.settings.wsUrl, this.slug);
    if (!nodeUrl) {
      this.hostEl.setText(`PocketOracle: could not derive a node terminal URL from "${this.settings.wsUrl}".`);
      return;
    }

    const term = new Terminal({
      fontFamily: "'JetBrains Mono PO', 'SFMono-Regular', Menlo, Monaco, 'Courier New', monospace",
      fontSize: this.settings.fontSize,
      lineHeight: this.settings.lineHeight,
      cursorBlink: true,
      scrollback: 10000,
      theme: ORACLE_THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(this.hostEl);
    fit.fit();
    this.term = term;
    this.fit = fit;

    this.hostEl.addEventListener("pointerup", () => {
      if (!this.settings.copyOnSelect) return;
      const sel = term.getSelection();
      if (sel) void this.copySelection(sel);
    });

    if (this.settings.showKeyBar) this.buildKeyBar(this.contentEl);

    this.connect(nodeUrl);

    // Grab keyboard focus on open — without this the xterm mounts unfocused,
    // so the first keystrokes go nowhere and the pane reads as "can't type"
    // (the terminal shows output but never accepts input). A tap into the
    // canvas node opens this leaf but leaves focus on the canvas otherwise.
    term.focus();

    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(this.hostEl);

    // iOS soft-keyboard fit — see terminal-view.ts for the full rationale. The
    // layout viewport doesn't shrink when the keyboard opens, so the
    // ResizeObserver misses it; visualViewport catches the open/close/animation
    // and refits the terminal to the space actually above the keyboard.
    const vv = window.visualViewport;
    if (vv) {
      this.registerDomEvent(vv as unknown as HTMLElement, "resize", () => this.refit());
      this.registerDomEvent(vv as unknown as HTMLElement, "scroll", () => this.refit());
    }

    this.heartbeatTimer = window.setInterval(() => this.heartbeat(), HEARTBEAT_MS);
  }

  private connect(nodeUrl: string): void {
    if (this.disposed || !this.term) return;
    const term = this.term;

    const client = new TtydClient(nodeUrl, this.settings.authToken, {
      onOutput: (bytes) => term.write(bytes),
      onOpen: () => {
        this.backoffMs = RECONNECT_FLOOR_MS;
        this.lastBuffered = 0;
        this.refit();
        this.term?.focus();
      },
      onClose: (ev) => {
        if (this.disposed) return;
        term.writeln(`\r\n\x1b[38;5;140m[pocketoracle] disconnected (${ev.code}) — reconnecting…\x1b[0m`);
        this.scheduleReconnect(nodeUrl);
      },
      onError: () => {
        if (this.disposed) return;
        term.writeln("\r\n\x1b[38;5;203m[pocketoracle] websocket error\x1b[0m");
      },
    });

    term.onData((d) => client.sendInput(d));
    term.onResize(({ cols, rows }) => client.sendResize(cols, rows));

    client.connect(term.cols, term.rows);
    this.client = client;
  }

  private forceReconnect(): void {
    if (this.disposed || !this.term || !this.slug) return;
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const nodeUrl = deriveNodeWsUrl(this.settings.wsUrl, this.slug);
    if (!nodeUrl) return;
    this.backoffMs = RECONNECT_FLOOR_MS;
    this.client?.close();
    this.client = null;
    this.connect(nodeUrl);
  }

  private heartbeat(): void {
    if (this.disposed || document.visibilityState !== "visible") return;
    const client = this.client;
    if (!client) return;
    if (client.readyState === WebSocket.CLOSED || client.readyState === WebSocket.CLOSING) {
      this.forceReconnect();
      return;
    }
    if (client.readyState !== WebSocket.OPEN) return;
    const buffered = client.bufferedAmount;
    if (buffered > 0 && this.lastBuffered > 0 && buffered >= this.lastBuffered) {
      this.lastBuffered = 0;
      this.forceReconnect();
      return;
    }
    this.lastBuffered = buffered;
    if (this.term) client.probe(this.term.cols, this.term.rows);
  }

  private async copySelection(text: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      /* fall through to the execCommand path below */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch {
      /* clipboard unavailable — nothing more to do */
    }
  }

  private buildKeyBar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "pocketoracle-keybar" });
    for (const key of KEY_BAR) {
      const btn = bar.createEl("button", { cls: "pocketoracle-key", text: key.label });
      btn.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        this.client?.sendInput(key.seq);
        this.term?.focus();
      });
    }
    this.keyBarEl = bar;
  }

  override onResize(): void {
    this.refit();
  }

  private scheduleReconnect(nodeUrl: string): void {
    if (this.reconnectTimer != null) return;
    const delay = this.backoffMs + Math.floor(Math.random() * 300);
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_CAP_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.client?.close();
      this.client = null;
      this.connect(nodeUrl);
    }, delay);
  }

  private refit(): void {
    if (this.resizeDebounce != null) window.clearTimeout(this.resizeDebounce);
    this.resizeDebounce = window.setTimeout(() => {
      this.resizeDebounce = null;
      this.clampToVisualViewport();
      try {
        this.fit?.fit();
        this.term?.scrollToBottom();
      } catch {
        /* pane not laid out yet */
      }
    }, 80);
  }

  /**
   * iOS keeps the LAYOUT viewport full-height when the soft keyboard opens, so
   * our full-screen view stays tall and fit() sizes the terminal past the
   * keyboard — the prompt row renders behind it and scrollToBottom() can't help
   * (the row is physically under the keyboard, not just scrolled off). Clamp the
   * view root to visualViewport.height (the band above the keyboard) so the flex
   * column collapses the terminal into the visible region before we fit. On
   * keyboard-close vv.height returns to full-screen and this resets to full.
   * Desktop keeps the CSS height:100% path untouched.
   */
  private clampToVisualViewport(): void {
    if (!Platform.isMobile) return;
    const vv = window.visualViewport;
    const root = this.contentEl;
    if (!vv || !root) return;
    root.style.height = `${Math.round(vv.height)}px`;
  }

  settingsChanged(settings: PocketOracleSettings): void {
    this.settings = settings;
    if (this.term) {
      this.term.options.fontSize = settings.fontSize;
      this.term.options.lineHeight = settings.lineHeight;
      const root = this.contentEl;
      if (settings.showKeyBar && !this.keyBarEl) {
        this.buildKeyBar(root);
      } else if (!settings.showKeyBar && this.keyBarEl) {
        this.keyBarEl.remove();
        this.keyBarEl = null;
      }
      this.fit?.fit();
    }
  }

  override async onClose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer != null) window.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer != null) window.clearInterval(this.heartbeatTimer);
    if (this.resizeDebounce != null) window.clearTimeout(this.resizeDebounce);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.keyBarEl = null;
    this.client?.close();
    this.client = null;
    this.term?.dispose();
    this.term = null;
    this.hostEl = null;
    this.originLeaf = null;
  }
}
