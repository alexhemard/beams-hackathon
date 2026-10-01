#!/usr/bin/env bash
# Break emailpals-api: point it at an image tag that does not exist. Pods go
# ImagePullBackOff/CrashLoop; kube-prometheus-stack fires KubePodCrashLooping /
# KubeDeploymentReplicasMismatch within a few minutes.
set -euo pipefail
K="kubectl --context kind-${KIND_CLUSTER:-oncall}"
$K -n emailpals set image deploy/emailpals-api emailpals-api=nginx:1.27-alpine-does-not-exist
$K -n emailpals annotate deploy/emailpals-api demo/broken-at="$(date -u +%FT%TZ)" --overwrite
echo "emailpals-api is broken. Watch: kubectl -n emailpals get pods -w"
