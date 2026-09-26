import { ItemView, Notice, Platform, type WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import xtermCss from "@xterm/xterm/css/xterm.css";
import { TtydClient } from "./ttyd-client";
import type { PocketOracleSettings } from "./settings";

export const VIEW_TYPE_POCKETORACLE = "pocketoracle-terminal";

// Injected once (not per-view) so multiple panes share one <style>.
let xtermCssInjected = false;
function ensureXtermCss(): void {
  if (xtermCssInjected) return;
  const style = document.createElement("style");
  style.id = "pocketoracle-xterm-css";
  style.textContent = xtermCss as unknown as string;
  document.head.appendChild(style);
  xtermCssInjected = true;
}

/**
 * Oracle-dark palette. Deliberately close to the vault's AnuPpuccin-Oracle dark
 * brand so the terminal reads as part of the same surface, not a stock xterm.
 */
const ORACLE_THEME = {
  background: "#1a1524",
  foreground: "#e6e0f0",
  cursor: "#c8a2ff",
  cursorAccent: "#1a1524",
  selectionBackground: "#3d2f5c",
  black: "#2a2140",
  red: "#f06c8a",
  green: "#8fd6a0",
  yellow: "#e9c98a",
  blue: "#8ab4f8",
  magenta: "#c8a2ff",
  cyan: "#87d7e0",
  white: "#d8d2e6",
  brightBlack: "#5a4f78",
  brightRed: "#ff8aa6",
  brightGreen: "#a8e6b8",
  brightYellow: "#f5dca8",
  brightBlue: "#a8c8ff",
  brightMagenta: "#dcb8ff",
  brightCyan: "#a0e8f0",
  brightWhite: "#f4f0fa",
};

export class PocketOracleTerminalView extends ItemView {
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private client: TtydClient | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private reconnectTimer: number | null = null;
  private resizeDebounce: number | null = null;
  private disposed = false;

  constructor(
    leaf: WorkspaceLeaf,
    private settings: PocketOracleSettings,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_POCKETORACLE;
  }

  getDisplayText(): string {
    return `Oracle · ${this.settings.sessionLabel}`;
  }

  override getIcon(): string {
    return "square-terminal";
  }

  override async onOpen(): Promise<void> {
    ensureXtermCss();
    const root = this.contentEl;
    root.empty();
    root.addClass("pocketoracle-view");

    // Not configured yet — say so in the pane rather than spin forever.
    if (!this.settings.wsUrl.trim()) {
      root.createDiv({
        cls: "pocketoracle-msg",
        text: "Set the ttyd websocket URL (wss://<host>:7890/ws) in PocketOracle settings, then reopen this pane.",
      });
      return;
    }

    // Mixed-content guard: capacitor (mobile) is a secure origin and silently
    // drops ws://. Say it in the pane instead of opening a terminal that never
    // connects — the blank-pane failure this project keeps hunting.
    if (!Platform.isDesktopApp && this.settings.wsUrl.startsWith("ws://")) {
      root.createDiv({
        cls: "pocketoracle-msg",
        text: "This device needs a wss:// URL — a plain ws:// gateway is blocked as mixed content here. Set the Caddy wss URL in PocketOracle settings.",
      });
      return;
    }

    const host = root.createDiv({ cls: "pocketoracle-term-host" });

    const term = new Terminal({
      fontFamily:
        "'SFMono-Regular', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize: this.settings.fontSize,
      cursorBlink: true,
      scrollback: 100000,
      // No webgl/canvas addon on purpose: the DOM renderer is the default and is
      // the one that survives GPU-broken boxes (see reference-obsidian-terminal-
      // blank-pane-renderer). Do not add an addon that flips the renderer.
      theme: ORACLE_THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fit.fit();
    this.term = term;
    this.fit = fit;

    this.connect();

    // Keep the far pty sized to the pane.
    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(host);
  }

  /** Obsidian's own resize lifecycle hook — also drives the refit. */
  override onResize(): void {
    this.refit();
  }

  private connect(): void {
    if (this.disposed || !this.term) return;
    const term = this.term;

    const client = new TtydClient(this.settings.wsUrl, this.settings.authToken, {
      onOutput: (bytes) => term.write(bytes),
      onTitle: () => {
        /* leaf title is our own "Oracle · main"; ignore ttyd's OSC title for now */
      },
      onOpen: () => {
        // Nudge the far tmux to our real size the instant we're connected.
        this.refit();
      },
      onClose: (ev) => {
        if (this.disposed) return;
        term.writeln(
          `\r\n\x1b[38;5;140m[pocketoracle] disconnected (${ev.code}) — reconnecting…\x1b[0m`,
        );
        this.scheduleReconnect();
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

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.client?.close();
      this.client = null;
      this.connect();
    }, 1500);
  }

  private refit(): void {
    if (this.resizeDebounce != null) window.clearTimeout(this.resizeDebounce);
    this.resizeDebounce = window.setTimeout(() => {
      this.resizeDebounce = null;
      try {
        this.fit?.fit();
      } catch {
        /* pane not laid out yet */
      }
    }, 80);
  }

  settingsChanged(settings: PocketOracleSettings): void {
    this.settings = settings;
    if (this.term) {
      this.term.options.fontSize = settings.fontSize;
      this.fit?.fit();
    }
  }

  /** Write text into the far session (used by the command palette / workflows). */
  sendText(text: string): void {
    if (!this.client?.isOpen) {
      new Notice("PocketOracle: terminal not connected");
      return;
    }
    this.client.sendInput(text);
  }

  override async onClose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer != null) window.clearTimeout(this.reconnectTimer);
    if (this.resizeDebounce != null) window.clearTimeout(this.resizeDebounce);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.client?.close();
    this.client = null;
    this.term?.dispose();
    this.term = null;
  }
}
