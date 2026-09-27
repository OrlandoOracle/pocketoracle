import { Plugin, WorkspaceLeaf } from "obsidian";
import {
  DEFAULT_SETTINGS,
  PocketOracleSettingTab,
  type PocketOracleSettings,
} from "./settings";
import { PocketOracleTerminalView, VIEW_TYPE_POCKETORACLE } from "./terminal-view";
import { PoTermView, VIEW_TYPE_PO_TERM } from "./node-terminal-view";
import { AskLoop, deriveBrokerBase } from "./ask/ask-loop";
import { registerRunLinks, registerRunProtocol, runActiveCanvasNode } from "./run-task";
import {
  openActiveCanvasNodeTerminal,
  registerFullScreenSync,
  registerOpenLinks,
  registerOpenProtocol,
} from "./open-term";

// Just under the broker's 290 s /po/ask hold, so the modal never outlives the
// ask it represents.
const ASK_TTL_MS = 285_000;

export default class PocketOraclePlugin extends Plugin {
  settings: PocketOracleSettings = DEFAULT_SETTINGS;
  private askLoop: AskLoop | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_POCKETORACLE,
      (leaf) => new PocketOracleTerminalView(leaf, this.settings),
    );
    this.registerView(VIEW_TYPE_PO_TERM, (leaf) => new PoTermView(leaf, this.settings));

    this.addRibbonIcon("square-terminal", "Open Oracle terminal", () => {
      void this.openTerminal();
    });

    this.addCommand({
      id: "open-oracle-terminal",
      name: "Open Oracle terminal",
      callback: () => void this.openTerminal(),
    });

    this.addSettingTab(new PocketOracleSettingTab(this.app, this));

    // Life-canvas node taps: `[▶ Run grocery](obsidian://po-run?slug=grocery)`.
    // The protocol handler is the reliable click path (fires regardless of render
    // timing); registerRunLinks only styles the anchor into a button.
    registerRunProtocol(this, () => this.brokerBase());
    registerRunLinks(this, () => this.brokerBase());
    this.addCommand({
      id: "run-canvas-node-task",
      name: "Run canvas node task",
      callback: () => runActiveCanvasNode(this, () => this.brokerBase()),
    });

    // Life-canvas node taps that open a LIVE per-project terminal instead of a
    // headless task: `[▶ Open LookingGlass](obsidian://po-open?slug=LookingGlass)`.
    // Same reliable-click-path pattern as po-run above.
    registerOpenProtocol(this);
    registerOpenLinks(this);
    registerFullScreenSync(this);
    this.addCommand({
      id: "open-canvas-node-terminal",
      name: "Open canvas node terminal",
      callback: () => openActiveCanvasNodeTerminal(this),
    });

    // The ask-loop runs at plugin level (not per-pane) so Claude's questions pop
    // as native tap buttons even when the terminal tab isn't focused.
    this.startAskLoop();
  }

  /** Broker base URL — explicit setting, else derived from the ttyd wss URL. */
  brokerBase(): string {
    return this.settings.brokerUrl.trim() || deriveBrokerBase(this.settings.wsUrl);
  }

  override onunload(): void {
    this.askLoop?.stop();
    this.askLoop = null;
  }

  /** (Re)start the ask-loop from current settings. Idempotent. */
  startAskLoop(): void {
    this.askLoop?.stop();
    this.askLoop = null;
    if (!this.settings.askLoop) return;
    const base = this.settings.brokerUrl.trim() || deriveBrokerBase(this.settings.wsUrl);
    if (!base) return; // not configured yet
    this.askLoop = new AskLoop(this.app, base, {
      ttlMs: ASK_TTL_MS,
      pollMs: this.settings.askPollMs,
    });
    this.askLoop.start();
  }

  /** Reuse the open terminal leaf if there is one; otherwise open a new tab. */
  async openTerminal(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_POCKETORACLE);
    if (existing.length > 0) {
      this.app.workspace.setActiveLeaf(existing[0], { focus: true });
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf: WorkspaceLeaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_POCKETORACLE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PocketOracleSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // Migration: a pre-0.3 config has no `lineHeight` key. Those were saved with
    // the old cramped fontSize:14 default — bump them to the new bigger default
    // once so existing iPad/Mini installs pick up the roomier look on update.
    if (saved && saved.lineHeight === undefined) {
      this.settings.fontSize = DEFAULT_SETTINGS.fontSize;
      this.settings.lineHeight = DEFAULT_SETTINGS.lineHeight;
      this.settings.showKeyBar = DEFAULT_SETTINGS.showKeyBar;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_POCKETORACLE)) {
      const view = leaf.view;
      if (view instanceof PocketOracleTerminalView) view.settingsChanged(this.settings);
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PO_TERM)) {
      const view = leaf.view;
      if (view instanceof PoTermView) view.settingsChanged(this.settings);
    }
    // Ask-loop config (enable/broker/poll) can change here — reflect it live.
    this.startAskLoop();
  }
}
