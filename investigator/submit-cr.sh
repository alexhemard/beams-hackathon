#!/usr/bin/env bash
# Runs INSIDE the investigator beam: register the executor for the change request file, then file
# the Access Request. One-off op; afterwards the laptop only watches Teleport and approves.
#
#   submit-cr.sh <cr.yaml> <self-beam-alias> <owner> [kube-cluster] [target]
#
# Steps (same as the laptop's `oncall submit`, with the beam's own identity):
#   1. tsh beams add                         executor beam
#   2. tctl create bot + bound_keypair token  per-CR identity (labels: role, owner, beam, ref, parent = this beam)
#   3. tar.gz {plan-runner.mjs, bootstrap.sh, cr.yaml} → scp → extract   reproducible init state
#   4. tsh beams exec bootstrap.sh            tbot joins as the bot, plan-runner starts (status only until approved)
#   5. tsh beams publish                      the executor's MCP endpoint as a Teleport app
#   6. tsh request create                     reason = CR + executor block naming bot/beam/app
#   7. tctl: label the bot with the request id and app
# Prints one JSON line on stdout: {requestId, beam, bot, app, appUrl, mcpUrl}. Progress goes to stderr.
set -euo pipefail
CR="${1:?cr.yaml}"; SELF="${2:?self beam alias}"; OWNER="${3:?owner}"; KUBE_CLUSTER="${4:-emailpals-production}"; TARGET="${5:-kube}"
PROXY="${TELEPORT_PROXY:-flat-pine.beams.sh:443}"
DIR=/home/beams/investigate; EXEC="$DIR/exec"; BIN=/home/beams/bin
APPROVAL_ROLE="${CR_APPROVAL_ROLE:-oncall-change}"; BOT_ROLE="${CR_BOT_ROLE:-administrator}"
TCTL=("$BIN/tctl" --identity "${TELEPORT_IDENTITY_FILE:?}" --auth-server "$PROXY")
log() { echo "▶ $*" >&2; }
json() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],d); process.stdout.write(String(v??""))' "$1"; }
fill() { # fill <template> KEY=VALUE...
  local t; t="$(cat "$1")"; shift
  for kv in "$@"; do local k="${kv%%=*}" v="${kv#*=}"; t="${t//\$\{$k\}/$v}"; done
  printf '%s\n' "$t"
}

[ -f "$CR" ] || { echo "no change request file at $CR" >&2; exit 2; }
[ -x "$BIN/tctl" ] || { echo "tctl missing at $BIN/tctl (bootstrap downloads it)" >&2; exit 2; }
RUN="$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')"; BOT="administrator-$RUN"

log "create executor beam"
BEAM_JSON="$(tsh beams add --no-console --format json)"
BEAM="$(json id <<<"$BEAM_JSON")"; BEAM_UUID="$(json uuid <<<"$BEAM_JSON")"
for _ in $(seq 1 18); do tsh beams exec "$BEAM" -- true >/dev/null 2>&1 && break; sleep 5; done
log "executor beam $BEAM created"

log "create executor bot $BOT ($BOT_ROLE) and one-time bound_keypair token"
fill "$DIR/teleport/bot.yaml.tmpl" BOT_NAME="$BOT" TELEPORT_ROLE="$BOT_ROLE" ROLE=executor OWNER="$OWNER" BEAM_ALIAS="$BEAM" BEAM_ID="$BEAM_UUID" REF="$RUN" PARENT="$SELF" > /tmp/bot-$BOT.yaml
"${TCTL[@]}" create --force -f /tmp/bot-$BOT.yaml >&2
SECRET="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
EXPIRES="$(date -u -d '+30 min' +%FT%TZ)"
fill "$DIR/teleport/token.yaml.tmpl" TOKEN_NAME="$BOT" BOT_NAME="$BOT" SECRET="$SECRET" EXPIRES="$EXPIRES" ROLE=executor OWNER="$OWNER" BEAM_ALIAS="$BEAM" REF="$RUN" > /tmp/token-$BOT.yaml
"${TCTL[@]}" rm "token/$BOT" >/dev/null 2>&1 || true
"${TCTL[@]}" create -f /tmp/token-$BOT.yaml >&2
rm -f /tmp/token-$BOT.yaml

log "ship the executor's init archive (plan-runner, bootstrap, cr.yaml)"
STAGE="$(mktemp -d)"; mkdir -p "$STAGE/plan-runner"
cp "$EXEC/plan-runner.mjs" "$EXEC/bootstrap.sh" "$STAGE/plan-runner/"; cp "$CR" "$STAGE/plan-runner/cr.yaml"
tar czf "/tmp/init-$BOT.tgz" -C "$STAGE" .; rm -rf "$STAGE"
tsh beams scp "/tmp/init-$BOT.tgz" "$BEAM:/home/beams/init.tgz" >/dev/null
tsh beams exec "$BEAM" -- tar xzf /home/beams/init.tgz -C /home/beams

log "bootstrap the executor (tbot joins as $BOT, plan-runner starts; no tools until approved)"
tsh beams exec "$BEAM" -- env KUBE_CLUSTER="$KUBE_CLUSTER" bash /home/beams/plan-runner/bootstrap.sh "$PROXY" "$BOT" "$SECRET" "$BOT" "$TARGET" "$OWNER" >&2

log "publish the executor as a Teleport app"
APP_URL="$(tsh beams publish "$BEAM" | grep -o 'https://[^ ]*' | head -1)"
APP="${APP_URL#https://}"; APP="${APP%%.*}"
log "published app $APP"

log "file the Access Request (reason = change request + executor block)"
REASON="$(cat "$CR")
executor:
  bot: $BOT
  beam: $BEAM
  app: $APP
  owner: $OWNER
"
OUT="$(tsh request create --roles "$APPROVAL_ROLE" --reason "$REASON" --nowait 2>&1)" || { echo "$OUT" >&2; exit 1; }
REQ="$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' <<<"$OUT" | head -1)"
[ -n "$REQ" ] || { echo "no request id in: $OUT" >&2; exit 1; }

log "label bot $BOT with request $REQ and app $APP"
"${TCTL[@]}" get "bot/$BOT" --format json \
  | node -e 'const b=JSON.parse(require("fs").readFileSync(0,"utf8"))[0]; b.metadata.labels={...(b.metadata.labels||{}),"oncall/ref":process.argv[1],"oncall/app":process.argv[2]}; process.stdout.write(JSON.stringify(b))' "$REQ" "$APP" > /tmp/bot-$BOT.json
"${TCTL[@]}" create --force -f /tmp/bot-$BOT.json >&2

printf '{"requestId":"%s","beam":"%s","bot":"%s","app":"%s","appUrl":"%s","mcpUrl":"%s/mcp"}\n' "$REQ" "$BEAM" "$BOT" "$APP" "$APP_URL" "$APP_URL"
