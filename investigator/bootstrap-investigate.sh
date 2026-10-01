#!/usr/bin/env bash
# Runs INSIDE the investigation beam. Started by `cr investigate` via `tsh beams exec`.
#
#   bootstrap-investigate.sh <proxy:443> <token-name> <registration-secret> <kube-cluster>
#
# Enrolls a read-only bot (bound keypair, one-time secret), gets a kubeconfig
# from tbot, downloads kubectl. The agent itself is started by a second exec so
# its output streams back to the caller.
set -euo pipefail
PROXY="$1"; TOKEN="$2"; SECRET="$3"; KUBE_CLUSTER="${4:-oncall}"
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
if [ ! -f "$STORAGE/identity" ]; then
  scrub "$BIN/tbot" start identity --proxy-server="$PROXY" --token="$TOKEN" --registration-secret="$SECRET" \
    --join-method=bound_keypair --storage="$STORAGE" --destination="$BOT_ID" --oneshot
fi

echo "== tbot: kubeconfig for $KUBE_CLUSTER =="
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
  - type: kubernetes/v2
    selectors:
      - name: $KUBE_CLUSTER
    destination:
      type: directory
      path: $KUBE
EOF
if ! pgrep -f "tbot start -c $HOME_DIR/tbot.yaml" >/dev/null 2>&1; then
  scrub setsid nohup "$BIN/tbot" start -c "$HOME_DIR/tbot.yaml" > "$HOME_DIR/logs/tbot.log" 2>&1 < /dev/null &
fi
for i in $(seq 1 30); do [ -f "$KUBE/kubeconfig.yaml" ] && break; sleep 1; done
[ -f "$KUBE/kubeconfig.yaml" ] || { echo "no kubeconfig from tbot"; tail -20 "$HOME_DIR/logs/tbot.log"; exit 1; }
"$BIN/kubectl" --kubeconfig "$KUBE/kubeconfig.yaml" get ns >/dev/null && echo "kubectl (read-only bot) OK"
echo "bootstrap complete"
