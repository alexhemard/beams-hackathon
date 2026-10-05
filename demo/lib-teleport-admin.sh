#!/usr/bin/env bash
# Sourced (not executed) by demo/kubeup.sh, demo/break.sh and demo/reset.sh.
#
# Mints a short-lived Machine ID bot (named cluster-setup-*, so it's identifiable in
# audit logs even though it holds the same role as per-CR executor bots) with the
# `administrator` Teleport role (full cluster-admin Kubernetes access, bound to the
# `administrator` k8s group in k8s/rbac.yaml) and logs it into the cluster through
# Teleport, so these demo scripts never need direct AWS/kubeconfig admin access —
# the EKS endpoint can stay private the whole time. Same minting pattern
# demo/approve.sh already uses
# for the reviewer bot, just with `tctl bots add` (creates a new bot outright)
# instead of `tctl bots instances add` (adds a join instance to an existing one).
#
# Usage:
#   source "$HERE/lib-teleport-admin.sh"
#   KCTX="$(teleport_admin_login "$CLUSTER" "$PROXY")"
#   kubectl --context "$KCTX" ...
#
# The bot (and its on-disk identity) is removed automatically on exit via trap,
# success or failure. Note this overwrites the kubectl context tsh would use for
# a normal `tsh kube login` as yourself — run `tsh kube login` again afterward if
# you need your own (read-only) identity back in that context.
teleport_admin_login() {
  local cluster="$1" proxy="$2"
  local tbot; tbot="$(command -v tbot || true)"; tbot="${tbot:-$HOME/.oncall/bin/tbot}"
  if [ ! -x "$tbot" ]; then
    local ver="${CR_TELEPORT_VERSION:-18.11.1}" arch os
    arch="$(uname -m)"; [ "$arch" = "x86_64" ] && arch=amd64; [ "$arch" = "arm64" ] && arch=arm64
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    echo "== download tbot v$ver ($os/$arch) to $tbot ==" >&2
    mkdir -p "$(dirname "$tbot")"
    curl -fsSL "https://cdn.teleport.dev/teleport-v${ver}-${os}-${arch}-bin.tar.gz" | tar xz -C "$(dirname "$tbot")" --strip-components=1 teleport/tbot
  fi

  local bot="cluster-setup-$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  echo "== mint short-lived setup bot $bot (role administrator) ==" >&2
  local token
  token="$(tctl bots add "$bot" --roles=administrator --format=json | python3 -c 'import sys,json; print(json.load(sys.stdin)["token_id"])')"

  local dest; dest="$(mktemp -d)"
  echo "\$ tbot start identity --oneshot ...   # mint $bot's certificate" >&2
  "$tbot" start identity --proxy-server="$proxy" --token="$token" --join-method=token \
    --storage="$dest/storage" --destination="$dest/id" --oneshot >&2

  # shellcheck disable=SC2064 (intentional: expand $bot/$dest now, not at trap time)
  trap "tctl bots rm '$bot' >/dev/null 2>&1 || true; rm -rf '$dest'" EXIT

  echo "\$ tsh -i <$bot identity> kube login $cluster" >&2
  tsh -i "$dest/id/identity" --proxy="$proxy" kube login "$cluster" >&2
  echo "${proxy%%:*}-${cluster}"
}
