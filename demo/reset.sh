#!/usr/bin/env bash
# Restore emailpals-api to the known-good image and clean up leftover CR bots/tokens/beams.
set -euo pipefail
K="kubectl --context kind-${KIND_CLUSTER:-oncall}"
$K -n emailpals set image deploy/emailpals-api emailpals-api=nginx:1.27-alpine
$K -n emailpals scale deploy/emailpals-api --replicas=1
$K -n emailpals rollout status deploy/emailpals-api --timeout=120s
echo "== leftover CR objects =="
tctl bots ls 2>/dev/null | awk '$1 ~ /^cr-/ {print $1}' | while read -r b; do echo "rm bot $b"; tctl bots rm "$b"; done
tctl tokens ls 2>/dev/null | awk '$1 ~ /^cr-/ {print $1}' | while read -r t; do echo "rm token $t"; tctl tokens rm "$t"; done
tsh beams ls --format json 2>/dev/null | python3 -c "import sys,json; [print(b['id']) for b in json.load(sys.stdin)]" 2>/dev/null | while read -r beam; do echo "rm beam $beam"; tsh beams rm "$beam"; done
echo "reset complete"
