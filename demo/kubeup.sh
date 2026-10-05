#!/usr/bin/env bash
# Install the rest of the demo stack on the Terraform-provisioned EKS cluster:
# monitoring, emailpals-api/web, RBAC, and the Teleport app registration for
# emailpals-web. The kube agent itself should already be installed — see
# terraform/README.md: `terraform apply` generates terraform/bootstrap-kube-agent.sh,
# run once from an AWS CloudShell VPC environment, since the EKS endpoint is private
# by default and nothing existed yet to proxy through.
#
# Everything here goes through Teleport (demo/lib-teleport-admin.sh mints a
# short-lived `cluster-setup` bot and logs it in), never direct AWS/kubeconfig
# admin access — the EKS endpoint can stay private the whole time. See
# terraform/README.md for the full picture.
#
#   demo/kubeup.sh    monitoring, emailpals, RBAC, teleport-kube-agent's app registration
#   demo/break.sh     push a bad image -> KubePodCrashLooping alert in ~5 min
#   demo/reset.sh     restore emailpals-api
#
# Requires: terraform applied (../terraform), kubectl, helm, tsh/tctl/tbot
# logged in / available (editor role, same as everything else in this repo).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(dirname "$HERE")"
TFDIR="$REPO/terraform"
CLUSTER="${EKS_CLUSTER:-$(cd "$TFDIR" && terraform output -raw eks_cluster_name 2>/dev/null || echo emailpals-production)}"
PROXY="${CR_PROXY:-flat-pine.beams.sh:443}"

echo "== EKS cluster $CLUSTER (via Teleport, not direct AWS access) =="
source "$HERE/lib-teleport-admin.sh"
KCTX="$(teleport_admin_login "$CLUSTER" "$PROXY")"
kubectl --context "$KCTX" get ns >/dev/null

echo "== monitoring (kube-prometheus-stack, minimal) =="
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null
helm --kube-context "$KCTX" upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --set grafana.enabled=false \
  --set prometheus.prometheusSpec.externalLabels.cluster="$CLUSTER" \
  --set alertmanager.alertmanagerSpec.retention=2h \
  --set prometheus.prometheusSpec.retention=2h \
  --set prometheus.prometheusSpec.scrapeInterval=15s \
  --set prometheus.prometheusSpec.evaluationInterval=15s \
  --set defaultRules.rules.etcd=false --set defaultRules.rules.kubeScheduler=false --set defaultRules.rules.kubeControllerManager=false \
  --set kubeEtcd.enabled=false --set kubeScheduler.enabled=false --set kubeControllerManager.enabled=false \
  --set kubeProxy.enabled=false --set defaultRules.rules.kubeProxy=false \
  --set alertmanager.config.route.group_wait=5s --set alertmanager.config.route.group_interval=30s

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

echo "== publish emailpals apps (via Kubernetes app auto-discovery) =="
# The kube agent (terraform/bootstrap.tf) was installed with roles=kube only, before
# emailpals-web existed to publish. Now that it does, add the app + discovery roles so
# the agent auto-registers every Service in the emailpals namespace — future services
# there get published with no further helm upgrade.
# --reuse-values keeps proxyAddr/kubeClusterName/authToken/labels as-is. apps is cleared
# explicitly in case a prior static apps[0]=emailpals-web (from before discovery) is still
# sitting in the currently-deployed values — discovery replaces it, it shouldn't stack.
helm repo add teleport https://charts.releases.teleport.dev >/dev/null 2>&1 || true
helm repo update >/dev/null
helm --kube-context "$KCTX" upgrade teleport-kube-agent teleport/teleport-kube-agent \
  --namespace teleport-agent --reuse-values \
  --set 'roles=kube\,app\,discovery' \
  --set-json 'apps=[]' \
  --set-json 'kubernetesDiscovery=[{"types":["app"],"namespaces":["emailpals"],"labels":{"*":"*"}}]'

echo "== verify =="
tsh --proxy "$PROXY" kube ls
echo
echo "cluster '$CLUSTER' is enrolled; emailpals-web is published as a Teleport app (tsh apps ls). Next: demo/break.sh, then the TUI."
