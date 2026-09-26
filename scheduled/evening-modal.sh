#!/bin/bash
# evening-modal.sh — fire the condensed PocketOracle evening-close modal on the iPad.
#
# THE THESIS THIS PROVES: a modal appears on the iPad at a SCHEDULED time with no
# human-driven Claude session, Sebastian taps, and the evening close runs. This is
# the first scheduled-modal-only brick (see pocketoracle CONTINUE.md, 8Q alignment
# 2026-09-26). "Cron now, TimeAuto later" — launchd is the trigger today; TimeAuto
# swaps in as the trigger once the phone Xcode Run happens. Nothing else changes.
#
# HOW: reuses the entire proven P1 ask-loop. We spawn an interactive Claude in its
# OWN tmux session that reads the orders and calls AskUserQuestion; the existing
# ask-device.sh PreToolUse hook turns each question into a native tap-card on the
# iPad via po-broker. Zero new protocol.
#
# MISS BEHAVIOR (decided): queue + one text nudge. We only spawn Claude when a
# device is present (po-broker /po/health present:true). If no device is watching,
# we send ONE deborah-say nudge for the day and exit; launchd's re-check re-fires
# when he opens the pane. If he never taps, no fake close is written (orders enforce
# this) and the sentinel stays absent, so it re-fires — a queue by idempotent retry.
#
# Idempotent + reboot-durable (research-launch.sh lessons): orders live in the repo
# and are COPIED to /tmp at launch; the per-day sentinel lives in ~/.pocketoracle-state
# which survives a reboot; safe to run every 15 min via launchd StartInterval.
#
# Runs on: the MINI. Not d1/d2 (Spark exit). Not the Air.

set -u

SLUG="evening-close"
REPO="$HOME/Code/pocketoracle/scheduled"
ORDERS_SRC="$REPO/evening-close-orders.md"
ORDERS_TMP="/tmp/po-${SLUG}-orders.md"
STATE_DIR="$HOME/.pocketoracle-state"
TODAY="$(date +%F)"
SENTINEL="$STATE_DIR/${SLUG}-${TODAY}.done"
NUDGE_SENTINEL="$STATE_DIR/${SLUG}-${TODAY}.nudged"
LOG="$STATE_DIR/${SLUG}.log"
SESSION="${SLUG}"
CLAUDE="$HOME/.local/bin/claude"
HEALTH="http://127.0.0.1:7893/po/health"

# Evening window: only act between START_HOUR:00 and 23:59 so the 15-min re-check
# never fires the modal in the middle of the afternoon. StartCalendarInterval hits
# it at 21:00; the window bounds every other (RunAtLoad / StartInterval) trigger.
START_HOUR="${PO_EVENING_START_HOUR:-20}"

mkdir -p "$STATE_DIR"
say() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# 1. Already closed out today? Nothing to do.
if [ -f "$SENTINEL" ]; then
  say "sentinel present — closed out already today, no-op"
  exit 0
fi

# 2. Outside the evening window? Skip (re-check will catch the window).
HOUR="$(date +%H)"
if [ "$((10#$HOUR))" -lt "$START_HOUR" ]; then
  say "hour $HOUR before window ${START_HOUR}:00 — no-op"
  exit 0
fi

# 3. Session already running? Leave it — unless it's stalled on a permission prompt.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  PANE="$(tmux capture-pane -p -t "$SESSION" 2>/dev/null | tail -30)"
  if echo "$PANE" | grep -q "Do you want to proceed?"; then
    say "STALLED on a permission prompt — killing so the next tick re-fires clean"
    tmux kill-session -t "$SESSION" 2>/dev/null
  else
    say "session $SESSION already running — no-op"
    exit 0
  fi
fi

# 4. Orders must exist.
if [ ! -f "$ORDERS_SRC" ]; then
  say "FATAL orders missing at $ORDERS_SRC"
  exit 1
fi

# 5. Presence gate — is a device watching the iPad pane right now?
HEALTH_JSON="$(curl -s --max-time 4 "$HEALTH" 2>/dev/null)"
if [ -z "$HEALTH_JSON" ]; then
  say "po-broker not answering on $HEALTH — cannot fire; will retry next tick"
  exit 0
fi
PRESENT="$(printf '%s' "$HEALTH_JSON" | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin).get("present"))' 2>/dev/null)"

if [ "$PRESENT" != "True" ]; then
  # No device watching. Queue via idempotent retry + send ONE nudge for the day.
  if [ ! -f "$NUDGE_SENTINEL" ]; then
    say "no device present — sending one nudge for the day"
    "$HOME/.local/bin/deborah-say" "Evening close is ready — open Oracle on the iPad to tap through your close-out." >/dev/null 2>&1 || true
    touch "$NUDGE_SENTINEL"
  else
    say "no device present — already nudged today, waiting"
  fi
  exit 0
fi

# 6. Device present → fire. Substitute LITERAL values into the /tmp orders copy so the
# headless session never runs a Bash command containing $(...) OR a $VAR — BOTH trip
# acceptEdits ("Contains command_substitution" / "Contains simple_expansion" →
# "Do you want to proceed?" forever). The model reads the note with the Read tool,
# writes with Edit/Write (auto-approved), and the ONLY Bash it runs is a single
# `touch <literal-path>` — matched cleanly by Bash(touch *) with no expansion.
DAILY_NOTE="$HOME/Deborah/05-Daily/${TODAY}.md"
NOW_HM="$(date +%H:%M)"
sed -e "s|{{SENTINEL}}|$SENTINEL|g" \
    -e "s|{{DAILY_NOTE}}|$DAILY_NOTE|g" \
    -e "s|{{TODAY}}|$TODAY|g" \
    -e "s|{{NOW_HM}}|$NOW_HM|g" \
    "$ORDERS_SRC" > "$ORDERS_TMP"
say "device present — launching $SESSION (orders -> $ORDERS_TMP, values substituted)"

tmux new-session -d -s "$SESSION" \
  "cd $HOME/Deborah && exec $CLAUDE --permission-mode acceptEdits \
    --allowedTools 'AskUserQuestion,Read,Edit,Write,Glob,Grep,Bash(touch *)'"

tmux set-option -t "$SESSION" window-size manual 2>/dev/null
tmux resize-window -t "$SESSION" -x 200 -y 50 2>/dev/null
sleep 8
tmux send-keys -t "$SESSION" \
  "Read $ORDERS_TMP and carry out every instruction in it now, start to finish." Enter
sleep 2
tmux send-keys -t "$SESSION" Enter
say "launched $SESSION"
exit 0
