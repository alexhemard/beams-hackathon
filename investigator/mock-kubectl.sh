#!/usr/bin/env bash
# Dev-only stand-in for kubectl so the investigator agent can be exercised in a
# beam before a cluster exists. Mimics a emailpals-api deployment broken by a bad image tag.
args="$*"
case "$args" in
  *"get pods"*)
    cat <<'EOF'
NAME                        READY   STATUS             RESTARTS   AGE   IP           NODE
emailpals-api-5d8f7c9b6-x2k9p    0/1     ImagePullBackOff   0          6m    10.244.0.9   oncall-control-plane
EOF
    ;;
  *"get deploy"*|*"get deployment"*)
    cat <<'EOF'
NAME       READY   UP-TO-DATE   AVAILABLE   AGE   CONTAINERS   IMAGES                              SELECTOR
emailpals-api   0/1     1            0           2d    emailpals-api     nginx:1.27-alpine-does-not-exist   app=emailpals-api
EOF
    ;;
  *"describe pod"*)
    cat <<'EOF'
Name:         emailpals-api-5d8f7c9b6-x2k9p
Namespace:    emailpals
Containers:
  emailpals-api:
    Image:          nginx:1.27-alpine-does-not-exist
    State:          Waiting
      Reason:       ImagePullBackOff
Events:
  Type     Reason     Age                  From               Message
  ----     ------     ----                 ----               -------
  Normal   Pulling    5m (x4 over 6m)      kubelet            Pulling image "nginx:1.27-alpine-does-not-exist"
  Warning  Failed     5m (x4 over 6m)      kubelet            Failed to pull image "nginx:1.27-alpine-does-not-exist": manifest unknown
  Warning  Failed     5m (x4 over 6m)      kubelet            Error: ErrImagePull
  Warning  BackOff    1m (x20 over 6m)     kubelet            Back-off pulling image "nginx:1.27-alpine-does-not-exist"
EOF
    ;;
  *"rollout history"*)
    cat <<'EOF'
deployment.apps/emailpals-api
REVISION  CHANGE-CAUSE
1         <none>
2         <none>
EOF
    ;;
  *"logs"*)
    echo "Error from server (BadRequest): container \"emailpals-api\" in pod \"emailpals-api-5d8f7c9b6-x2k9p\" is waiting to start: trying and failing to pull image" >&2
    exit 1
    ;;
  *"get events"*)
    cat <<'EOF'
LAST SEEN   TYPE      REASON              OBJECT                          MESSAGE
6m          Normal    ScalingReplicaSet   deployment/emailpals-api             Scaled up replica set emailpals-api-5d8f7c9b6 to 1
5m          Warning   Failed              pod/emailpals-api-5d8f7c9b6-x2k9p    Failed to pull image "nginx:1.27-alpine-does-not-exist": manifest unknown
1m          Warning   BackOff             pod/emailpals-api-5d8f7c9b6-x2k9p    Back-off pulling image "nginx:1.27-alpine-does-not-exist"
EOF
    ;;
  *)
    echo "mock kubectl: unhandled: $args" >&2
    exit 1
    ;;
esac
