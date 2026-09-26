#!/bin/zsh
# Install the built plugin into the local Obsidian vault for testing on the Mini.
# .obsidian is NOT carried by LiveSync/Syncthing, so this stays Mini-local and
# never touches d2. iPad/iPhone get the plugin via BRAT off the git remote later.
set -e
VAULT="${1:-$HOME/Deborah}"
DEST="$VAULT/.obsidian/plugins/pocketoracle"
mkdir -p "$DEST"

# The released styles.css must be self-contained (BRAT copies only main.js/
# manifest.json/styles.css). Assemble it: bundled font @font-face (base64 woff2)
# first, then our chrome, then xterm's own CSS.
cat fonts.css > "$DEST/styles.css"
echo "" >> "$DEST/styles.css"
cat styles.css >> "$DEST/styles.css"
if [ -f node_modules/@xterm/xterm/css/xterm.css ]; then
  echo "" >> "$DEST/styles.css"
  cat node_modules/@xterm/xterm/css/xterm.css >> "$DEST/styles.css"
fi

cp main.js manifest.json "$DEST/"
echo "installed -> $DEST"
