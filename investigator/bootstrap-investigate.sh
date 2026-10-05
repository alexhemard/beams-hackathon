#!/usr/bin/env bash
# Runs INSIDE the investigation beam. Started by `cr investigate` via `tsh beams exec`.
#
#   bootstrap-investigate.sh <proxy:443> <token-name> <registration-secret> <kube-cluster>
#
# Enrolls a read-only bot (bound keypair, one-time secret), gets a kubeconfig
# from tbot, downloads kubectl. The agent itself is started by a second exec so
# its output streams back to the caller.
set -euo pipefail
PROXY="$1"; TOKEN="$2"; SECRET="$3"; KUBE_CLUSTER="${4:-emailpals-production}"
TELEPORT_VERSION="${TELEPORT_VERSION:-18.11.1}"
HOME_DIR=/home/beams
BIN="$HOME_DIR/bin"; STORAGE="$HOME_DIR/tbot-storage"; BOT_ID="$HOME_DIR/bot-id"; KUBE="$HOME_DIR/kube"
mkdir -p "$BIN" "$STORAGE" "$BOT_ID" "$KUBE" "$HOME_DIR/logs" "$HOME_DIR/investigate"
scrub() { env -u TELEPORT_PROXY -u TELEPORT_CLUSTER -u TELEPORT_IDENTITY_FILE -u TELEPORT_KEY_AGENT_DIR "$@"; }

echo "== binaries =="
ARCH="$(dpkg --print-architecture)"
if [ ! -x "$BIN/tbot" ]; then
  curl -fsSL "https://cdn.teleport.dev/teleport-v${TELEPORT_VERSION}-linux-${ARCH}-bin.tar.gz" -o /tmp/t.tgz
  tar xzf /tmp/t.tgz -C /tmp teleport/tbot && mv /tmp/teleport/tbot "$BIN/"; rm -rf /tmp/t.tgz /tmp/teleport
fi
if [ ! -x "$BIN/tctl" ]; then
  # tctl: the investigator registers the executor itself (bot + token) with the beam's identity
  curl -fsSL "https://cdn.teleport.dev/teleport-v${TELEPORT_VERSION}-linux-${ARCH}-bin.tar.gz" -o /tmp/t.tgz
  tar xzf /tmp/t.tgz -C /tmp teleport/tctl && mv /tmp/teleport/tctl "$BIN/"; rm -rf /tmp/t.tgz /tmp/teleport
fi
if [ ! -x "$BIN/kubectl" ]; then
  KV="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"
  curl -fsSL "https://dl.k8s.io/release/${KV}/bin/linux/${ARCH}/kubectl" -o "$BIN/kubectl"; chmod +x "$BIN/kubectl"
fi

echo "== enroll read-only bot =="
# $STORAGE/identity never exists (tbot's directory storage doesn't write a file by
# that name); check the rendered destination file instead, like plan-runner/bootstrap.sh
# does, so a re-run doesn't re-enroll and collide with the long-running tbot's lock
# on $STORAGE.
if [ ! -f "$BOT_ID/identity" ]; then
  scrub "$BIN/tbot" start identity --proxy-server="$PROXY" --token="$TOKEN" --registration-secret="$SECRET" \
    --join-method=bound_keypair --storage="$STORAGE" --destination="$BOT_ID" --oneshot
fi

echo "== tbot: identity (renewable) + kubeconfig for $KUBE_CLUSTER =="
# The one-shot join above (--oneshot) produces a disallow-reissue identity at $BOT_ID -- fine for a
# single join, but it never renews, so it can never request a role or reissue an app-scoped cert
# later (confirmed live: "can not request role oncall-change" from a cert that otherwise correctly
# held `operator`). The continuous tbot process below re-renders that same destination with
# allow_reissue: true, exactly like plan-runner/bootstrap.sh already does for the executor bot --
# same mechanism, same reason.
cat > "$HOME_DIR/tbot.yaml" <<EOF
version: v2
proxy_server: $PROXY
onboarding:
  join_method: bound_keypair
  token: $TOKEN
storage:
  type: directory
  path: $STORAGE
services:
  - type: identity
    allow_reissue: true
    destination:
      type: directory
      path: $BOT_ID
  - type: kubernetes/v2
    selectors:
      - name: $KUBE_CLUSTER
    destination:
      type: directory
      path: $KUBE
EOF
# pgrep can't see across exec contexts that share this filesystem but not a PID
# namespace; tbot's own storage lock is filesystem-level, so check that instead.
if flock -n -x "$STORAGE/lock" -c true 2>/dev/null; then
  scrub setsid nohup "$BIN/tbot" start -c "$HOME_DIR/tbot.yaml" > "$HOME_DIR/logs/tbot.log" 2>&1 < /dev/null &
fi
for i in $(seq 1 30); do [ -f "$KUBE/kubeconfig.yaml" ] && break; sleep 1; done
[ -f "$KUBE/kubeconfig.yaml" ] || { echo "no kubeconfig from tbot"; tail -20 "$HOME_DIR/logs/tbot.log"; exit 1; }
"$BIN/kubectl" --kubeconfig "$KUBE/kubeconfig.yaml" get ns >/dev/null && echo "kubectl (read-only bot) OK"
echo "bootstrap complete"
