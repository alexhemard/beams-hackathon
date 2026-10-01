#!/usr/bin/env bash
# Runs INSIDE an investigation beam, first thing after it is created (before the slow bootstrap),
# so that `tsh beams ssh <beam>` behaves from the very first second:
#   - interactive SSH shells attach to the investigator's tmux session (waiting for it to appear)
#   - the operator's terminfo (e.g. xterm-ghostty), if shipped to terminfo.src, is compiled
#
#   prepare-beam.sh [terminfo.src]
set -uo pipefail
SRC="${1:-}"
if [ -n "$SRC" ] && [ -f "$SRC" ]; then
  tic -x -o /home/beams/.terminfo "$SRC" 2>/dev/null && echo "terminfo installed from $SRC"
fi
if ! grep -q "oncall: attach" /home/beams/.bashrc 2>/dev/null; then
  cat >> /home/beams/.bashrc <<'EOS'
# oncall: attach interactive SSH shells to the investigation
if [ -n "$SSH_TTY" ] && [ -z "$TMUX" ]; then
  # the TUI ships the operator's terminfo (e.g. xterm-ghostty); if it is not here, fall back so tmux still attaches
  infocmp "$TERM" >/dev/null 2>&1 || export TERM=xterm-256color
  # during bootstrap the session does not exist yet: wait for it (up to 3 minutes) instead of dropping to a shell
  if ! tmux has-session -t investigate 2>/dev/null; then
    echo "oncall: waiting for the investigator to start (Ctrl-C for a plain shell)..."
    for _ in $(seq 1 90); do tmux has-session -t investigate 2>/dev/null && break; sleep 2; done
  fi
  tmux has-session -t investigate 2>/dev/null && exec tmux attach -t investigate
  echo "oncall: no investigator session; plain shell"
fi
EOS
fi
grep -q "bashrc" /home/beams/.profile 2>/dev/null || echo '[ -f ~/.bashrc ] && . ~/.bashrc' >> /home/beams/.profile
echo "beam prepared: ssh shells attach to tmux"
