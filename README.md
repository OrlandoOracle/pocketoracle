# PocketOracle

Oracle-branded Claude Code terminal **inside Obsidian** — an `xterm.js` pane over
`wss` to a host-side `ttyd` + `tmux`, attaching the same live session Moshi uses.
iPad / iPhone / Mac.

Part of the PocketOracle project: _run the whole business from the iPad._

## What it is

A greenfield terminal (not an iframe on ttyd) — the plugin speaks ttyd 1.7's raw
WebSocket protocol itself, so the `xterm.js` instance is ours to theme, drive a
palette into, and write output back to the vault. DOM renderer (webgl paints
blank on some boxes). Reconnects and resizes with the pane.

## Install (BRAT)

This is a **public** repo — no PAT needed.

1. BRAT → **Add beta plugin** → `OrlandoOracle/pocketoracle`.
2. Enable **PocketOracle**, then set the **ttyd websocket URL** in its settings
   (per device; must be `wss://`).

### Updating on the iPad

BRAT only updates when the release tag's **semver goes up** — it never re-reads
assets re-uploaded under an existing tag. So every change ships as a new patch
tag. To pull one on the iPad:

1. Command palette → **BRAT: Check for updates to a single plugin**, watch the toast.
2. If the version didn't change → **BRAT: Choose a single plugin to reinstall**.
3. **Force-quit** Obsidian from the app switcher and reopen (the in-place reload is unreliable on iOS).

## Host side

`ttyd` binds loopback (`127.0.0.1:7891`, `tmux new -A -s main`); `Caddy` fronts it
with `wss` on the ACL-allowed tailnet port `:7890` using a `tailscale cert`
(trusted Let's-Encrypt). The Obsidian mobile webview is a secure origin and
refuses `ws://`, so the `wss` front is mandatory. `tailscale serve` is NOT usable
here — it drops the WebSocket upgrade.

## Build

```
npm install
npm run build      # tsc check + esbuild -> main.js
bash ship.sh       # install into the local vault for testing
```
