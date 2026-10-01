#!/usr/bin/env bash
# Stand up the demo cluster and enroll it in the Beams tenant.
#
#   demo/up.sh            create kind cluster, monitoring, emailpals-api, RBAC, Teleport kube agent
#   demo/break.sh         push a bad image -> KubePodCrashLooping alert in ~5 min
#   demo/reset.sh         restore emailpals-api
#
# Requires: kind, kubectl, helm, tsh logged in to flat-pine, terraform applied (for the join token).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(dirname "$HERE")"
CLUSTER="${KIND_CLUSTER:-oncall}"

echo "== kind cluster $CLUSTER =="
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --wait 120s
fi
KCTX="kind-$CLUSTER"   # never rely on the current context: tsh kube login may have switched it to Teleport
kubectl --context "$KCTX" get ns >/dev/null

echo "== monitoring (kube-prometheus-stack, minimal) =="
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null
helm --kube-context "$KCTX" upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --set grafana.enabled=false \
  --set alertmanager.alertmanagerSpec.retention=2h \
  --set prometheus.prometheusSpec.retention=2h \
  --set prometheus.prometheusSpec.scrapeInterval=15s \
  --set prometheus.prometheusSpec.evaluationInterval=15s \
  --set defaultRules.rules.etcd=false --set defaultRules.rules.kubeScheduler=false --set defaultRules.rules.kubeControllerManager=false \
  --set kubeEtcd.enabled=false --set kubeScheduler.enabled=false --set kubeControllerManager.enabled=false \
  --set kubeProxy.enabled=false --set defaultRules.rules.kubeProxy=false \
  --set alertmanager.config.route.group_wait=5s --set alertmanager.config.route.group_interval=30s \
  --wait --timeout 10m

echo "== demo app + RBAC + fast-firing alert rule =="
kubectl --context "$KCTX" apply -f "$REPO/k8s/emailpals-api.yaml"
kubectl --context "$KCTX" apply -f "$REPO/k8s/rbac.yaml"
kubectl --context "$KCTX" apply -f "$REPO/k8s/alert-rules.yaml"
kubectl --context "$KCTX" -n emailpals rollout status deploy/emailpals-api --timeout=120s

echo "== emailpals-web (static site from k8s/emailpals-web/site, served by nginx) =="
SITE="$REPO/k8s/emailpals-web/site"; KN="kubectl --context $KCTX -n emailpals"
$KN create configmap emailpals-web-root   --from-file=index.html="$SITE/index.html" --dry-run=client -o yaml | $KN apply -f -
$KN create configmap emailpals-web-css    --from-file="$SITE/css"    --dry-run=client -o yaml | $KN apply -f -
$KN create configmap emailpals-web-images --from-file="$SITE/images" --dry-run=client -o yaml | $KN apply -f -
$KN create configmap emailpals-web-nginx  --from-file=default.conf="$REPO/k8s/emailpals-web/nginx.conf" --dry-run=client -o yaml | $KN apply -f -
kubectl --context "$KCTX" apply -f "$REPO/k8s/emailpals-web.yaml"
$KN rollout status deploy/emailpals-web --timeout=120s

echo "== Teleport kube agent =="
TOKEN="$(cd "$REPO/terraform" && terraform output -raw kube_join_token)"
PROXY="$(cd "$REPO/terraform" && terraform output -raw proxy_addr 2>/dev/null || echo flat-pine.beams.sh:443)"
helm repo add teleport https://charts.releases.teleport.dev >/dev/null 2>&1 || true
helm repo update >/dev/null
helm --kube-context "$KCTX" upgrade --install teleport-kube-agent teleport/teleport-kube-agent \
  --namespace teleport-agent --create-namespace \
  --set 'roles=kube\,app' \
  --set proxyAddr="$PROXY" \
  --set kubeClusterName="$CLUSTER" \
  --set authToken="$TOKEN" \
  --set labels.env=demo \
  --set 'apps[0].name=emailpals-web' --set 'apps[0].uri=http://emailpals-web.emailpals.svc.cluster.local' --set 'apps[0].labels.env=demo' --set 'apps[0].labels.tier=web' \
  --wait --timeout 5m

echo "== verify =="
tsh kube ls
echo
echo "cluster '$CLUSTER' is enrolled; emailpals-web is published as a Teleport app (tsh apps ls). Next: demo/break.sh, then the TUI."
