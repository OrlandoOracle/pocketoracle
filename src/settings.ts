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
  fontSize: 14,
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
          .setLimits(9, 22, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.fontSize = v;
            await this.plugin.saveSettings();
          }),
      );
  }
}
