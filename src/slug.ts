/**
 * Slug charset shared by every PocketOracle click surface (canvas links,
 * `obsidian://` protocol handlers) AND the Mini's shell chokepoints
 * (`psession`, `ipad-open`, `po-node`). Keep the character class in sync — a
 * client/server mismatch either rejects a valid slug with a Notice (safe, if
 * annoying) or — the direction that actually matters — lets the client accept
 * a slug the server would reject, which just means an extra round trip, since
 * the server-side regex is the real security boundary (send-keys/tmux target
 * injection). Widened 2026-09-27 from `[a-z0-9][a-z0-9-]{0,40}` (which
 * rejected every mixed-case project slug, e.g. `LookingGlass`,
 * `AFHC-AI-Training`) to match the hardened shell-side regex exactly.
 *
 * Source: ~/Deborah/03-Resources/Research/pocketoracle-node-terminals-research-2026-09-27.md
 * (§(a), §Footguns 1) and ~/Deborah/01-Projects/project-gallery/NODE-TERMINALS-BUILD.md (U0).
 */
export const SLUG_CHARS = "[A-Za-z0-9_][A-Za-z0-9_-]{0,63}";

/** Anchored, whole-string match — use to validate a slug pulled from user input. */
export const SLUG_RE = new RegExp(`^${SLUG_CHARS}$`);

/** Build an anchored-at-prefix, single-capture-group regex for `pattern<slug>` extraction. */
export function slugCapture(prefix: string): RegExp {
  return new RegExp(`${prefix}(${SLUG_CHARS})`);
}
