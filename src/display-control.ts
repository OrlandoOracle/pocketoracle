import type { App } from "obsidian";
import type { Terminal } from "@xterm/xterm";

/**
 * Private OSC identifier PocketOracle listens for. The far shell (on the Mac
 * Mini, inside tmux `main`) emits `ESC ] 5379 ; <verb> ; <args…> BEL`; xterm's
 * OSC parser strips it from the byte stream (it never renders and chunk
 * boundaries are handled for us) and hands us the payload.
 *
 * Because THIS code runs inside the Obsidian renderer on whatever device has the
 * pane open (iPad / iPhone / Mac), we can mutate that device's OWN appearance —
 * which is the whole point: LiveSync does not carry `.obsidian`, so the only way
 * to drive the iPad's theme is from something running on the iPad. The terminal
 * pane is exactly that something.
 *
 * tmux swallows unknown OSC unless `allow-passthrough on`; the shell helper wraps
 * the sequence in the tmux DCS passthrough envelope when $TMUX is set.
 */
export const ORACLE_OSC = 5379;

// Obsidian's appearance surface is untyped in the public API. Narrow it here so
// the casts live in one place instead of scattered `as any` at every call site.
interface CustomCss {
  theme: string;
  themes: Record<string, unknown>;
  snippets: string[];
  enabledSnippets: Set<string>;
  setTheme(name: string): void;
  setCssEnabledStatus(snippet: string, enabled: boolean): void;
}
interface AppearanceApp {
  customCss: CustomCss;
  // Present on most builds but not part of the public API — feature-detected.
  changeTheme?: (mode: "obsidian" | "moonstone") => void;
  setTheme?: (mode: "obsidian" | "moonstone") => void;
  vault: {
    getConfig(key: string): unknown;
    setConfig(key: string, value: unknown): void;
  };
  updateFontSize?: () => void;
  workspace: { trigger: (name: string) => void };
}

const CONFIRM = "\x1b[38;5;140m"; // Oracle purple
const WARN = "\x1b[38;5;203m"; // soft red
const DIM = "\x1b[38;5;102m";
const RESET = "\x1b[0m";

function line(term: Terminal, color: string, msg: string): void {
  term.writeln(`\r\n${color}[oracle-display] ${msg}${RESET}`);
}

/** 'obsidian' = dark, 'moonstone' = light — Obsidian's internal names. */
function currentMode(app: AppearanceApp): "obsidian" | "moonstone" | "system" {
  const t = app.vault.getConfig("theme");
  if (t === "moonstone" || t === "obsidian" || t === "system") return t;
  // Fall back to what's actually on the body.
  return document.body.classList.contains("theme-light") ? "moonstone" : "obsidian";
}

/**
 * Switch dark/light without depending on one internal method name. Prefers the
 * build's own `changeTheme`/`setTheme`; falls back to persisting the config and
 * flipping the body classes + firing `css-change` so the UI repaints.
 */
function applyMode(app: AppearanceApp, target: "obsidian" | "moonstone"): void {
  const fn = app.changeTheme ?? app.setTheme;
  if (typeof fn === "function") {
    fn.call(app, target);
    return;
  }
  app.vault.setConfig("theme", target);
  document.body.classList.toggle("theme-dark", target === "obsidian");
  document.body.classList.toggle("theme-light", target === "moonstone");
  app.workspace.trigger("css-change");
}

function setMode(app: AppearanceApp, term: Terminal, arg: string): void {
  const want = arg.trim().toLowerCase();
  let target: "obsidian" | "moonstone";
  if (want === "toggle") {
    target = currentMode(app) === "obsidian" ? "moonstone" : "obsidian";
  } else if (want === "system") {
    // Follow-OS mode isn't a changeTheme() argument; set it in config and let
    // Obsidian re-evaluate against the OS on next tick.
    app.vault.setConfig("theme", "system");
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyMode(app, dark ? "obsidian" : "moonstone");
    line(term, CONFIRM, "mode → system");
    return;
  } else if (want === "dark") {
    target = "obsidian";
  } else if (want === "light") {
    target = "moonstone";
  } else {
    line(term, WARN, `mode: expected dark|light|toggle|system, got "${arg}"`);
    return;
  }
  applyMode(app, target);
  line(term, CONFIRM, `mode → ${target === "obsidian" ? "dark" : "light"}`);
}

function setTheme(app: AppearanceApp, term: Terminal, arg: string): void {
  const name = arg.trim();
  // "" / "default" both mean the built-in Obsidian theme.
  const target = name === "" || name.toLowerCase() === "default" ? "" : name;
  if (target !== "" && !(target in app.customCss.themes)) {
    line(term, WARN, `theme "${target}" not installed on this device — try: oracle-display list`);
    return;
  }
  app.customCss.setTheme(target);
  line(term, CONFIRM, `theme → ${target === "" ? "default" : target}`);
}

function setSnippet(app: AppearanceApp, term: Terminal, name: string, state: string): void {
  const snip = name.trim();
  if (!snip) {
    line(term, WARN, "snippet: need a name — oracle-display snippet <name> on|off|toggle");
    return;
  }
  if (!app.customCss.snippets.includes(snip)) {
    line(term, WARN, `snippet "${snip}" not found — try: oracle-display list`);
    return;
  }
  const want = state.trim().toLowerCase();
  let enabled: boolean;
  if (want === "toggle" || want === "") enabled = !app.customCss.enabledSnippets.has(snip);
  else if (want === "on") enabled = true;
  else if (want === "off") enabled = false;
  else {
    line(term, WARN, `snippet: expected on|off|toggle, got "${state}"`);
    return;
  }
  app.customCss.setCssEnabledStatus(snip, enabled);
  line(term, CONFIRM, `snippet ${snip} → ${enabled ? "on" : "off"}`);
}

function setFont(app: AppearanceApp, term: Terminal, arg: string): void {
  const n = Number.parseInt(arg.trim(), 10);
  if (!Number.isFinite(n) || n < 8 || n > 40) {
    line(term, WARN, `font: expected 8–40, got "${arg}"`);
    return;
  }
  app.vault.setConfig("baseFontSize", n);
  app.updateFontSize?.();
  line(term, CONFIRM, `base font → ${n}px`);
}

function list(app: AppearanceApp, term: Terminal): void {
  const themes = Object.keys(app.customCss.themes);
  const mode = currentMode(app);
  const activeTheme = app.customCss.theme || "default";
  term.writeln(`\r\n${CONFIRM}[oracle-display]${RESET} this device's appearance`);
  term.writeln(`  ${DIM}mode${RESET}    ${mode === "obsidian" ? "dark" : mode === "moonstone" ? "light" : "system"}`);
  term.writeln(`  ${DIM}theme${RESET}   ${activeTheme}`);
  term.writeln(`  ${DIM}themes${RESET}  ${themes.length ? themes.join(", ") : "(only default installed)"}`);
  if (app.customCss.snippets.length) {
    const snips = app.customCss.snippets
      .map((s) => `${s}${app.customCss.enabledSnippets.has(s) ? "*" : ""}`)
      .join(", ");
    term.writeln(`  ${DIM}snippets${RESET} ${snips}  ${DIM}(*=on)${RESET}`);
  }
}

function help(term: Terminal): void {
  term.writeln(`\r\n${CONFIRM}[oracle-display]${RESET} drive THIS device's Obsidian look from the pane`);
  term.writeln(`  ${DIM}oracle-display${RESET} mode dark|light|toggle|system`);
  term.writeln(`  ${DIM}oracle-display${RESET} theme <name>|default`);
  term.writeln(`  ${DIM}oracle-display${RESET} snippet <name> on|off|toggle`);
  term.writeln(`  ${DIM}oracle-display${RESET} font <8-40>`);
  term.writeln(`  ${DIM}oracle-display${RESET} list`);
}

/**
 * Register the OSC 5379 handler on a terminal. Returns nothing; xterm owns the
 * handler lifetime and drops it when the terminal is disposed.
 */
export function registerDisplayControl(term: Terminal, app: App): void {
  const a = app as unknown as AppearanceApp;
  term.parser.registerOscHandler(ORACLE_OSC, (data: string) => {
    const parts = data.split(";");
    const verb = (parts[0] ?? "").trim().toLowerCase();
    try {
      switch (verb) {
        case "mode":
          setMode(a, term, parts[1] ?? "");
          break;
        case "theme":
          setTheme(a, term, parts.slice(1).join(";"));
          break;
        case "snippet":
          setSnippet(a, term, parts[1] ?? "", parts[2] ?? "");
          break;
        case "font":
          setFont(a, term, parts[1] ?? "");
          break;
        case "list":
          list(a, term);
          break;
        case "help":
        case "":
          help(term);
          break;
        default:
          line(term, WARN, `unknown verb "${verb}" — oracle-display help`);
      }
    } catch (e) {
      line(term, WARN, `failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Returning true tells xterm we consumed this OSC — do not render it.
    return true;
  });
}
