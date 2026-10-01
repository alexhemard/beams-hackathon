#!/usr/bin/env bash
# Review a change request as the reviewer, with Teleport's own tooling doing the talking:
#   tctl requests ls        the queue of Access Requests (one row per change request)
#   tctl requests get <id>  the request: requester, roles, status, reason (= the CR)
#   tsh request review      the review itself, as the reviewer identity
#
# Teleport forbids reviewing your own Access Request, so approval must come from a
# second identity. Two ways:
#
#   human   log in as the reviewer user (role oncall-reviewer) in a separate tsh home
#           and review, or use the Web UI at https://<proxy>/web/requests:
#             TELEPORT_HOME=~/.tsh-reviewer tsh login --proxy=flat-pine.beams.sh:443 --user=cr-reviewer
#             TELEPORT_HOME=~/.tsh-reviewer tsh request review --approve <request-id>
#           (one-time: complete the `tctl users reset cr-reviewer` link to set a password)
#
#   bot     this script. Mints a short-lived identity for the Machine ID bot
#           `cr-reviewer-bot` (role oncall-reviewer, created by terraform) and reviews
#           with it. Demo shortcut; the audit log shows bot-cr-reviewer-bot as reviewer.
#
# usage: demo/approve.sh [<request-id>] [--deny] [-y|--yes]
#        (no id: shows `tctl requests ls` and asks for one)
set -euo pipefail
# If a TUI or a tmux session died in this terminal, it may still be in the Kitty keyboard protocol
# (`read` sees CSI-u sequences) or mouse reporting (clicks print characters). Reset both; no-ops otherwise.
[ -t 0 ] && printf '\033[<u\033[?1000l\033[?1002l\033[?1003l\033[?1006l' >/dev/tty 2>/dev/null || true
PROXY="${CR_PROXY:-flat-pine.beams.sh:443}"
BOT="${CR_REVIEWER_BOT:-cr-reviewer-bot}"
DEST="${HOME}/.cr/reviewer-identity"
ACTION="--approve"; YES=0; REQ=""
for a in "$@"; do
  case "$a" in
    --deny) ACTION="--deny" ;;
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) REQ="$a" ;;
  esac
done

# ---- the queue, then the request, straight from tctl --------------------------------------
if [ -z "$REQ" ]; then
  echo "\$ tctl requests ls"
  tctl requests ls
  echo
  read -r -p "request id to review: " REQ
  [ -n "$REQ" ] || { echo "no request id"; exit 1; }
fi

echo "\$ tctl requests get $REQ"
tctl requests get "$REQ"
echo
# tctl prints the reason as one escaped string; the reason IS the change request, so show it as YAML too.
echo "change request (request_reason, unescaped):"
tctl requests get "$REQ" --format=json \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print("\n".join("    "+l for l in d["spec"].get("request_reason","").rstrip("\n").split("\n")))'
echo

if [ "$YES" != 1 ]; then
  verb="Approve"; [ "$ACTION" = "--deny" ] && verb="Deny"
  read -r -p "$verb $REQ as $BOT? [y/N] " ans
  case "$ans" in y|Y|yes|YES) ;; *) echo "not reviewed"; exit 1 ;; esac
fi

# ---- reviewer identity: Machine ID bot, short-lived, minted on the spot --------------------
# tbot: PATH, else ~/.cr/bin (downloaded once from the Teleport CDN, same tarball the beams use)
TBOT="$(command -v tbot || true)"; TBOT="${TBOT:-$HOME/.cr/bin/tbot}"
if [ ! -x "$TBOT" ]; then
  VER="${CR_TELEPORT_VERSION:-18.11.1}"; ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && ARCH=amd64; [ "$ARCH" = "arm64" ] && ARCH=arm64
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  echo "== download tbot v$VER ($OS/$ARCH) to $TBOT =="
  mkdir -p "$(dirname "$TBOT")"
  curl -fsSL "https://cdn.teleport.dev/teleport-v${VER}-${OS}-${ARCH}-bin.tar.gz" | tar xz -C "$(dirname "$TBOT")" --strip-components=1 teleport/tbot
fi

echo "\$ tctl bots instances add $BOT            # one-time join token for the reviewer bot"
TOKEN="$(tctl bots instances add "$BOT" --format=json | python3 -c 'import sys,json; print(json.load(sys.stdin)["token_id"])')"

echo "\$ tbot start identity --oneshot ...        # mint the reviewer's certificate"
rm -rf "$DEST"; mkdir -p "$DEST"
env -u TELEPORT_PROXY -u TELEPORT_CLUSTER -u TELEPORT_IDENTITY_FILE "$TBOT" start identity --proxy-server="$PROXY" --join-method=token --token="$TOKEN" \
  --storage="$DEST/storage" --destination="$DEST/id" --oneshot >/dev/null 2>&1

echo "\$ tsh -i <reviewer identity> request review $ACTION $REQ"
env -u TELEPORT_PROXY -u TELEPORT_CLUSTER -u TELEPORT_IDENTITY_FILE tsh -i "$DEST/id/identity" --proxy="$PROXY" request review "$ACTION" --reason "reviewed by $BOT (demo)" "$REQ"
echo
echo "\$ tctl requests get $REQ"
tctl requests get "$REQ" | grep -E "^(Token|Requestor|Status|Resolve Reason):"
