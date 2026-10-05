#!/usr/bin/env bash
# Runs INSIDE the investigation beam. Starts the investigator under tmux so the
# on-call operator can attach and watch:  tsh beams ssh <beam>; tmux attach -t investigate
# A second tmux window has a shell with the read-only kubeconfig for manual poking.
#
#   run-investigate.sh <kubectl-path> [kubeconfig-path] [identity-path]
set -euo pipefail
KUBECTL="$1"; KUBECONFIG_PATH="${2:-}"; IDENTITY_PATH="${3:-}"
DIR=/home/beams/investigate
LOG="$DIR/log"
: > "$LOG"
EXTRA=""
[ -n "$KUBECONFIG_PATH" ] && EXTRA="--kubeconfig $KUBECONFIG_PATH"
# audit_find_change (root-cause attribution via Teleport's audit log): needs the bot's own
# identity and tctl, both absent in --mock-kubectl mode (no bot is enrolled there).
[ -n "$IDENTITY_PATH" ] && EXTRA="$EXTRA --identity $IDENTITY_PATH --tctl $(dirname "$KUBECTL")/tctl"
rm -f "$DIR/cr.yaml"
tmux kill-session -t investigate 2>/dev/null || true
# deep scrollback: the TUI reads the transcript with `tmux capture-pane` from this window
tmux start-server 2>/dev/null || true
tmux set-option -g history-limit 20000 2>/dev/null || true
# The agent stays alive after the first draft as a conversation on this window's stdin: the
# operator attaches and types, or the TUI types for them (tmux send-keys). cr.yaml is the CR file.
tmux new-session -d -s investigate -n agent \
  "env ANTHROPIC_API_KEY=beam node $DIR/investigate.mjs --alert $DIR/alert.json --prompt $DIR/prompt.md --runbooks $DIR/runbooks --self $DIR/self.json --out $DIR/cr.yaml --port 8080 --kubectl $KUBECTL $EXTRA 2>&1 | tee $LOG; echo EXIT:\${PIPESTATUS[0]} >> $LOG; echo; echo '(investigator finished; this window stays open)'; exec bash"
if [ -n "$KUBECONFIG_PATH" ]; then
  tmux new-window -d -t investigate -n kubectl "env KUBECONFIG=$KUBECONFIG_PATH PATH=/home/beams/bin:\$PATH bash"
fi
# No mouse reporting in this session: when an attached SSH session ends abruptly, tmux cannot turn
# it back off in the operator's terminal and clicks start printing escape sequences there.
tmux set-option -t investigate mouse off 2>/dev/null || true
# the TUI keeps a recording client attached (Teleport session recording); size follows the most
# recently active client, so the operator's own terminal wins when they attach
tmux set-option -t investigate window-size latest 2>/dev/null || true
tmux select-window -t investigate:agent 2>/dev/null || true
# (the SSH auto-attach hook and terminfo are installed by prepare-beam.sh right after beam creation)
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 || { echo "investigator api did not come up"; tail -20 "$LOG"; exit 1; }
echo "investigator started in tmux session 'investigate'; api on :8080"
