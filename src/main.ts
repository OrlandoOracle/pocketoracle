import { Plugin, WorkspaceLeaf } from "obsidian";
import {
  DEFAULT_SETTINGS,
  PocketOracleSettingTab,
  type PocketOracleSettings,
} from "./settings";
import { PocketOracleTerminalView, VIEW_TYPE_POCKETORACLE } from "./terminal-view";

export default class PocketOraclePlugin extends Plugin {
  settings: PocketOracleSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_POCKETORACLE,
      (leaf) => new PocketOracleTerminalView(leaf, this.settings),
    );

    this.addRibbonIcon("square-terminal", "Open Oracle terminal", () => {
      void this.openTerminal();
    });

    this.addCommand({
      id: "open-oracle-terminal",
      name: "Open Oracle terminal",
      callback: () => void this.openTerminal(),
    });

    this.addSettingTab(new PocketOracleSettingTab(this.app, this));
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_POCKETORACLE)) {
      const view = leaf.view;
      if (view instanceof PocketOracleTerminalView) view.settingsChanged(this.settings);
    }
  }
}
