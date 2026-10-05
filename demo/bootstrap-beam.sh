#!/usr/bin/env bash
# Make a beam that already has this repo synced into it (your own sync tool,
# or `tsh beams scp`/mutagen) able to run the oncall TUI directly: install
# kubectl if it's missing, log the beam's identity into the EKS cluster's
# kube context, and npm install.
#
# Alertmanager access needs nothing beam-specific: it's read through the
# Kubernetes API server's service proxy with the caller's own Teleport role
# (shared/alerts.ts), which is identical from a beam or a laptop as long as
# that identity carries operator (kubernetes_groups: [oncall-view] plus
# the services/proxy verb on the monitoring namespace, see terraform/roles.tf).
#
# Usage (inside the beam, repo already synced to the current directory):
#   demo/bootstrap-beam.sh
#   npx tsx cli/oncall.ts
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(dirname "$HERE")"
CLUSTER="${EKS_CLUSTER:-emailpals-production}"
PROXY="${CR_PROXY:-flat-pine.beams.sh:443}"

echo "== kubectl =="
if ! command -v kubectl >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
  VERSION="$(curl -sL https://dl.k8s.io/release/stable.txt)"
  curl -sL "https://dl.k8s.io/release/${VERSION}/bin/linux/${ARCH}/kubectl" -o "$HOME/.local/bin/kubectl"
  chmod +x "$HOME/.local/bin/kubectl"
  export PATH="$HOME/.local/bin:$PATH"
  echo "installed kubectl ${VERSION} to $HOME/.local/bin (add it to PATH if not already there)"
else
  echo "kubectl already present: $(command -v kubectl)"
fi

echo "== tsh kube login $CLUSTER =="
tsh --proxy "$PROXY" kube login "$CLUSTER"

echo "== npm install =="
(cd "$REPO" && npm install)

echo
echo "ready. run the TUI with:"
echo "  npx tsx cli/oncall.ts"
