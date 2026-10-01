#!/usr/bin/env bash
# Runs INSIDE the executor beam. Started by `cr perform` via `tsh beams exec`.
#
#   bootstrap.sh <proxy:443> <token-name> <registration-secret> <executor-bot> <target> <requester>
#     target: kube | tctl
#   Register-then-request: cr-exec starts from /home/beams/cr-exec/cr.yaml and discovers the
#   Access Request that names <executor-bot> once the operator files it.
#
# 1. downloads tbot, tctl and kubectl
# 2. enrolls a per-CR bot with a one-time bound-keypair secret (Cassie's quickstart, Part 2)
# 3. runs tbot with an identity output (and a kube output for the kube target)
# 4. starts cr-exec on :8080
#
# beamctl is not available through `tsh beams exec` on this tenant, so long-running
# processes are detached with setsid/nohup.
set -euo pipefail

PROXY="$1"; TOKEN="$2"; SECRET="$3"; EXECUTOR="$4"; TARGET="${5:-kube}"; REQUESTER="${6:-}"
TELEPORT_VERSION="${TELEPORT_VERSION:-18.11.1}"
HOME_DIR=/home/beams
BIN="$HOME_DIR/bin"; STORAGE="$HOME_DIR/tbot-storage"; BOT_ID="$HOME_DIR/bot-id"; KUBE="$HOME_DIR/kube"
APP="$HOME_DIR/cr-exec"
mkdir -p "$BIN" "$STORAGE" "$BOT_ID" "$KUBE" "$APP" "$HOME_DIR/logs"

# The beam's TELEPORT_* vars point at the delegated identity and override config
# files; everything below must not see them.
scrub() { env -u TELEPORT_PROXY -u TELEPORT_CLUSTER -u TELEPORT_IDENTITY_FILE -u TELEPORT_KEY_AGENT_DIR "$@"; }

echo "== 1. binaries =="
if [ ! -x "$BIN/tbot" ]; then
  ARCH="$(dpkg --print-architecture)"
  curl -fsSL "https://cdn.teleport.dev/teleport-v${TELEPORT_VERSION}-linux-${ARCH}-bin.tar.gz" -o /tmp/t.tgz
  tar xzf /tmp/t.tgz -C /tmp teleport/tbot teleport/tctl
  mv /tmp/teleport/tbot /tmp/teleport/tctl "$BIN/"; rm -rf /tmp/t.tgz /tmp/teleport
fi
if [ "$TARGET" = "kube" ] && [ ! -x "$BIN/kubectl" ]; then
  KV="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"
  curl -fsSL "https://dl.k8s.io/release/${KV}/bin/linux/$(dpkg --print-architecture)/kubectl" -o "$BIN/kubectl"; chmod +x "$BIN/kubectl"
fi
"$BIN/tbot" version

echo "== 2. enroll bot (one-time secret) =="
if [ -f "$STORAGE/identity" ] || [ -f "$BOT_ID/identity" ]; then
  echo "bot identity already present, skipping enrollment"
else
  scrub "$BIN/tbot" start identity \
    --proxy-server="$PROXY" --token="$TOKEN" --registration-secret="$SECRET" \
    --join-method=bound_keypair --storage="$STORAGE" --destination="$BOT_ID" --oneshot
fi

echo "== 3. tbot services =="
if pgrep -f "tbot start -c $HOME_DIR/tbot.yaml" >/dev/null 2>&1; then
  echo "tbot already running"
else
{
  cat <<EOF
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
EOF
  if [ "$TARGET" = "kube" ]; then
    cat <<EOF
  - type: kubernetes/v2
    selectors:
      - name: ${KUBE_CLUSTER:-oncall}
    destination:
      type: directory
      path: $KUBE
EOF
  fi
} > "$HOME_DIR/tbot.yaml"
scrub setsid nohup "$BIN/tbot" start -c "$HOME_DIR/tbot.yaml" > "$HOME_DIR/logs/tbot.log" 2>&1 < /dev/null &
fi
for i in $(seq 1 30); do
  if [ -f "$BOT_ID/identity" ] && { [ "$TARGET" != "kube" ] || [ -f "$KUBE/kubeconfig.yaml" ]; }; then break; fi
  sleep 1
done
grep -E "identity|Listening|error" "$HOME_DIR/logs/tbot.log" | tail -3 || true
[ -f "$BOT_ID/identity" ] || { echo "tbot did not produce an identity"; tail -20 "$HOME_DIR/logs/tbot.log"; exit 1; }

echo "== 4. cr-exec =="
pkill -f "cr-exec.mjs" >/dev/null 2>&1 || true
sleep 1
ALLOW="tctl"; EXTRA=()
if [ "$TARGET" = "kube" ]; then ALLOW="kubectl"; EXTRA=(--kubeconfig "$KUBE/kubeconfig.yaml"); fi
scrub setsid nohup node "$APP/cr-exec.mjs" --cr-file "$APP/cr.yaml" --executor "$EXECUTOR" --requester "$REQUESTER" \
  --identity "$BOT_ID/identity" --proxy "$PROXY" \
  --allow "$ALLOW" --path-prepend "$BIN" --port 8080 "${EXTRA[@]}" > "$HOME_DIR/logs/cr-exec.log" 2>&1 < /dev/null &
for i in $(seq 1 20); do
  curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:8080/healthz || { echo "cr-exec failed to start"; tail -30 "$HOME_DIR/logs/cr-exec.log"; exit 1; }
echo
echo "bootstrap complete"
