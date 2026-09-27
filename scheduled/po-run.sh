#!/bin/bash
# po-run.sh — fire a PocketOracle task-type headlessly, ON DEMAND (a canvas node tap).
#
# This is evening-modal.sh generalized: instead of one hard-coded evening-close on a
# launchd schedule, it runs ANY task-type <slug> whose orders live in this dir, right
# now, because Sebastian tapped its node on the Life canvas. The tap arrives over the
# broker (POST /po/run {slug}); the broker execs this script. Questions the headless
# session asks surface back as native ask-modals on the iPad via the proven P1 loop.
#
#   iPad taps node → plugin cmd → POST /po/run {slug} → THIS → tmux headless Claude
#     → AskUserQuestion → ask-device.sh hook → po-broker → ask-modal on iPad → tap → done
#
# Runs on: the MINI. Reuses the whole P1 ask-loop; zero new protocol beyond /po/run.
#
# acceptEdits stall trap (learned, see CONTINUE): a headless acceptEdits session hangs
# forever on "Do you want to proceed?" for ANY Bash containing $(...) OR $VAR. So the
# orders are COPIED to /tmp with LITERAL values sed'd in; the model uses Read/Edit/Write
# and the only Bash it may run is a literal `touch`.

set -u

SLUG="${1:-}"
REPO="$HOME/Code/pocketoracle/scheduled"
STATE_DIR="$HOME/.pocketoracle-state"
CLAUDE="$HOME/.local/bin/claude"
HEALTH="http://127.0.0.1:7893/po/health"

# When the broker (launchd) execs this, its TMPDIR/PATH differ from an interactive
# shell, so a bare `tmux` builds a NEW empty server on a different socket and the
# headless claude there dies with no environment. Pin the absolute binary AND the
# user's real default socket so we ALWAYS attach to the tmux server hosting `main`,
# regardless of who called us. (This launcher shell may use $(...) freely — only the
# acceptEdits ORDERS session below is restricted from command-substitution.)
TMUX_BIN="/opt/homebrew/bin/tmux"
[ -x "$TMUX_BIN" ] || TMUX_BIN="$(command -v tmux)"
TMUX_SOCK="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/default"
TMUXC() { "$TMUX_BIN" -S "$TMUX_SOCK" "$@"; }

mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/po-run.log"
say() { echo "$(date '+%F %T') [$SLUG] $*" >> "$LOG"; }

# 1. Validate the slug — allowlist by charset AND by an existing orders file. This is
#    the security boundary: /po/run can only launch a task whose orders we authored.
if ! printf '%s' "$SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]{0,40}$'; then
  say "REJECT bad slug"
  echo "bad-slug"; exit 2
fi
ORDERS_SRC="$REPO/${SLUG}-orders.md"
if [ ! -f "$ORDERS_SRC" ]; then
  say "REJECT no orders at $ORDERS_SRC"
  echo "no-orders"; exit 3
fi

SESSION="po-${SLUG}"

# 2. A prior on-demand session never self-exits (the headless REPL idles after its
#    orders finish), so a lingering po-<slug> would block every future tap. On demand
#    the sane semantic is "start fresh": kill any existing session for this slug and
#    relaunch. The prior run's work is already written; nothing is lost.
if TMUXC has-session -t "$SESSION" 2>/dev/null; then
  say "existing $SESSION — killing to start fresh"
  TMUXC kill-session -t "$SESSION" 2>/dev/null
fi

# 3. Presence gate. On demand the tapper IS present, but keep the guard: if the broker
#    can't confirm a device, don't strand a headless session with no way to answer.
HEALTH_JSON="$(curl -s --max-time 4 "$HEALTH" 2>/dev/null)"
PRESENT="$(printf '%s' "$HEALTH_JSON" | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin).get("present"))' 2>/dev/null)"
if [ "$PRESENT" != "True" ]; then
  say "no device present — not firing (tap again with Oracle open)"
  echo "no-device"; exit 4
fi

# 4. Substitute literal values into the /tmp orders copy. On-demand orders write ONLY
#    inside ~/Deborah (auto-allowed under acceptEdits) and run NO shell command, so there
#    is no sentinel to touch — a file-write outside the project is exactly what stalled
#    the session on a permission prompt. Keep the literal date/time/note-path only.
TODAY="$(date +%F)"
NOW_HM="$(date +%H:%M)"
DAILY_NOTE="$HOME/Deborah/05-Daily/${TODAY}.md"
ORDERS_TMP="/tmp/po-${SLUG}-orders.md"
sed -e "s|{{DAILY_NOTE}}|$DAILY_NOTE|g" \
    -e "s|{{TODAY}}|$TODAY|g" \
    -e "s|{{NOW_HM}}|$NOW_HM|g" \
    "$ORDERS_SRC" > "$ORDERS_TMP"

# 5. Per-slug optional tool grant. Default = the safe evening set; a <slug>.tools file
#    (one line) can widen it for task-types that need more (e.g. grocery → browser).
TOOLS_FILE="$REPO/${SLUG}.tools"
if [ -f "$TOOLS_FILE" ]; then
  ALLOWED="$(head -1 "$TOOLS_FILE")"
  # An empty/whitespace-only .tools file is a DELIBERATE zero-Bash lockdown, not a
  # "grant nothing" mistake. Passing --allowedTools '' would strip even AskUserQuestion
  # and strand the session. Treat it as the no-Bash safe set so an on-demand task can
  # never improvise a shell command yet can still ask + write inside the vault.
  if [ -z "$(printf '%s' "$ALLOWED" | tr -d '[:space:]')" ]; then
    ALLOWED='AskUserQuestion,Read,Edit,Write,Glob,Grep'
  fi
else
  ALLOWED='AskUserQuestion,Read,Edit,Write,Glob,Grep,Bash(touch *)'
fi

say "device present — launching $SESSION (orders -> $ORDERS_TMP)"
TMUXC new-session -d -s "$SESSION" \
  "cd $HOME/Deborah && exec $CLAUDE --permission-mode acceptEdits --allowedTools '$ALLOWED'"
TMUXC set-option -t "$SESSION" window-size manual 2>/dev/null
TMUXC resize-window -t "$SESSION" -x 200 -y 50 2>/dev/null
sleep 8
TMUXC send-keys -t "$SESSION" \
  "Read $ORDERS_TMP and carry out every instruction in it now, start to finish." Enter
sleep 2
TMUXC send-keys -t "$SESSION" Enter
say "launched $SESSION"
echo "launched"
exit 0
