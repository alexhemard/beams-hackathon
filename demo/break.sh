#!/usr/bin/env bash
# Break emailpals-api: point it at an image tag that does not exist. Pods go
# ImagePullBackOff/CrashLoop; kube-prometheus-stack fires KubePodCrashLooping /
# KubeDeploymentReplicasMismatch within a few minutes.
#
# Goes through Teleport (demo/lib-teleport-admin.sh), not direct AWS access —
# the EKS endpoint can stay private. See demo/kubeup.sh / terraform/README.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CLUSTER="${EKS_CLUSTER:-emailpals-production}"
PROXY="${CR_PROXY:-flat-pine.beams.sh:443}"
source "$HERE/lib-teleport-admin.sh"
KCTX="$(teleport_admin_login "$CLUSTER" "$PROXY")"
K="kubectl --context $KCTX"
$K -n emailpals set image deploy/emailpals-api emailpals-api=nginx:1.27-alpine-does-not-exist
$K -n emailpals annotate deploy/emailpals-api demo/broken-at="$(date -u +%FT%TZ)" --overwrite
echo "emailpals-api is broken. Watch: kubectl --context $KCTX -n emailpals get pods -w"
