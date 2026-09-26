#!/bin/zsh
# Install the built plugin into the local Obsidian vault for testing on the Mini.
# .obsidian is NOT carried by LiveSync/Syncthing, so this stays Mini-local and
# never touches d2. iPad/iPhone get the plugin via BRAT off the git remote later.
set -e
VAULT="${1:-$HOME/Deborah}"
DEST="$VAULT/.obsidian/plugins/pocketoracle"
mkdir -p "$DEST"

# xterm ships its own CSS; concatenate it after ours so a BRAT install (which
# only copies main.js/manifest.json/styles.css) still styles the terminal even
# if the runtime injection is ever removed.
cat styles.css > "$DEST/styles.css"
if [ -f node_modules/@xterm/xterm/css/xterm.css ]; then
  echo "" >> "$DEST/styles.css"
  cat node_modules/@xterm/xterm/css/xterm.css >> "$DEST/styles.css"
fi

cp main.js manifest.json "$DEST/"
echo "installed -> $DEST"
