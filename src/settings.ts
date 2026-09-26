import { App, PluginSettingTab, Setting } from "obsidian";
import type PocketOraclePlugin from "./main";

export interface PocketOracleSettings {
  /**
   * The ttyd websocket endpoint. MUST be wss:// for the mobile (capacitor)
   * webview — a secure origin refuses ws:// as mixed content. Front your plain
   * ttyd with Caddy on a tailscale-cert wss port and put that Caddy URL here.
   * Desktop Electron tolerates ws:// for dev, so a plain ws:// value is allowed
   * but warned about on mobile.
   */
  wsUrl: string;
  /** tmux session to attach — the same `main` Moshi shares. Informational; ttyd's own -W command decides the real session. */
  sessionLabel: string;
  /** ttyd credential if the gateway runs with `-c user:pass`. Empty = network-auth (tailnet-only, no password). */
  authToken: string;
  /** DOM renderer is mandatory on GPU-broken boxes; webgl paints blank. Kept as a toggle only for A/B on a good GPU. */
  useCanvasRenderer: boolean;
  fontSize: number;
  /** xterm line-height multiplier. 1.4 gives the "roomier" iPad feel Sebastian picked. */
  lineHeight: number;
  /** Minimal on-screen key row for the keys the iPad Magic Keyboard lacks (Esc) + quick nav. */
  showKeyBar: boolean;
  /** Copy the terminal selection to the device clipboard automatically (iPad has no auto-copy-on-highlight). */
  copyOnSelect: boolean;
  /**
   * The ask-loop: poll the po-broker so Claude Code's AskUserQuestion prompts pop
   * as native tap-to-answer buttons on THIS device. This is PocketOracle's reason
   * to exist — steer by tapping, no keyboard. Default on.
   */
  askLoop: boolean;
  /**
   * Broker base URL (…/po). Leave BLANK to auto-derive from the ttyd wss URL
   * (wss://host:7890/ws → https://host:7890/po). Set only to point the ask-loop
   * at a different host than the terminal.
   */
  brokerUrl: string;
  /** Poll interval for /po/pending, ms. Lower = snappier taps, more requests. */
  askPollMs: number;
}

export const DEFAULT_SETTINGS: PocketOracleSettings = {
  // Left BLANK on purpose: the repo is public, so we do not bake a tailnet host
  // or IP into it. Set this per-device in PocketOracle settings to the Caddy wss
  // front of your ttyd, e.g. wss://<magicdns-name>:7890/ws (must be wss:// — a
  // secure-origin webview drops ws:// as mixed content).
  wsUrl: "",
  sessionLabel: "main",
  authToken: "",
  useCanvasRenderer: false,
  // 18px + 1.4 line-height = the "bigger & roomier" iPad choice (8-Q look/feel pass 2026-09-26).
  fontSize: 18,
  lineHeight: 1.4,
  showKeyBar: true,
  copyOnSelect: true,
  askLoop: true,
  brokerUrl: "",
  askPollMs: 2500,
};

export class PocketOracleSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PocketOraclePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "PocketOracle" });

    new Setting(containerEl)
      .setName("ttyd websocket URL")
      .setDesc(
        "Must be wss:// for iPad/iPhone (secure origin blocks ws://). Point at the Caddy wss front of your ttyd, e.g. wss://<magicdns-host>:7890/ws",
      )
      .addText((t) =>
        t
          .setPlaceholder("wss://host:port/ws")
          .setValue(this.plugin.settings.wsUrl)
          .onChange(async (v) => {
            this.plugin.settings.wsUrl = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Session label")
      .setDesc("Display name for the shared tmux session (informational).")
      .addText((t) =>
        t.setValue(this.plugin.settings.sessionLabel).onChange(async (v) => {
          this.plugin.settings.sessionLabel = v.trim() || "main";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc("Leave empty for network-auth (tailnet-only, no ttyd password). Set only if ttyd runs with -c.")
      .addText((t) =>
        t.setValue(this.plugin.settings.authToken).onChange(async (v) => {
          this.plugin.settings.authToken = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Terminal font size in px.")
      .addSlider((s) =>
        s
          .setLimits(9, 28, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.fontSize = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Line height")
      .setDesc("Row spacing multiplier. 1.4 = roomier; 1.0 = dense.")
      .addSlider((s) =>
        s
          .setLimits(10, 20, 1) // shown as tenths; divided by 10 on apply
          .setValue(Math.round(this.plugin.settings.lineHeight * 10))
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.lineHeight = v / 10;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Touch key row")
      .setDesc("Show a minimal on-screen row (Esc · Ctrl-C · Tab · arrows) — the keys the iPad Magic Keyboard lacks.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showKeyBar).onChange(async (v) => {
          this.plugin.settings.showKeyBar = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Copy on select")
      .setDesc("Selecting text in the terminal copies it to this device's clipboard automatically (iPad has no highlight-to-copy).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.copyOnSelect).onChange(async (v) => {
          this.plugin.settings.copyOnSelect = v;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("h3", { text: "Ask-loop (tap-to-answer)" });

    new Setting(containerEl)
      .setName("Enable ask-loop")
      .setDesc(
        "When Claude Code asks a question, pop native tap-to-answer buttons on this device. Steer by tapping — no keyboard.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.askLoop).onChange(async (v) => {
          this.plugin.settings.askLoop = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Broker URL")
      .setDesc("Leave blank to auto-derive from the ttyd wss URL (…:7890/po). Set only to use a different host.")
      .addText((t) =>
        t
          .setPlaceholder("https://host:7890/po")
          .setValue(this.plugin.settings.brokerUrl)
          .onChange(async (v) => {
            this.plugin.settings.brokerUrl = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Poll interval")
      .setDesc("How often to check for new questions, ms. Lower = snappier, more requests.")
      .addSlider((s) =>
        s
          .setLimits(1000, 6000, 500)
          .setValue(this.plugin.settings.askPollMs)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.askPollMs = v;
            await this.plugin.saveSettings();
          }),
      );
  }
}
