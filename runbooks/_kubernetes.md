# Kubernetes: how to investigate and what counts as a change

General runbook, always loaded. Alert-specific runbooks add to it.

## Tools

You have two tools: `kubectl`, read-only, bound to the affected cluster, and `audit_find_change`,
which searches Teleport's audit log instead of the cluster.

`kubectl` allowed subcommands: `get`, `describe`, `logs`, `top`, `explain`, `api-resources`,
`rollout status`, `rollout history`. Pass arguments as one string (`-n emailpals get pods -o
wide`). Never pass `--kubeconfig` or `--raw`. No pipes: use `--sort-by`, `-o wide`, `-o jsonpath`,
`--tail`.

`audit_find_change` answers "who did this" when `kubectl` shows a resource changed recently (a
new rollout, an edited deployment/configmap/secret) but not who changed it: every Kubernetes API
write Teleport proxied is a `kube.request` audit event, attributed to the human user or bot
identity that made it. Narrow with `namespace`/`resourceKind`/`resourceName` from what `kubectl`
already showed you, and `sinceMinutes` if the default window (since the alert fired) is wrong.

## Investigating

- Start from the alert labels: namespace, deployment, pod, node.
- `get pods -o wide`, `get deploy <name> -o wide`: replicas, restarts, image, node.
- `describe pod <pod>`: Events (ImagePullBackOff, ErrImagePull, CrashLoopBackOff, OOMKilled,
  probe failures), the image and tag, resource requests/limits.
- `logs <pod> --previous` (or without) for application errors.
- `rollout history deploy/<name>` and `rollout history deploy/<name> --revision=N`: did a recent
  rollout introduce it? Compare images and env between revisions.
- `get events -n <ns> --sort-by=.lastTimestamp`, `describe node <node>`, `top pods`, `get endpoints`,
  `get svc`, `get configmap/secret` (metadata only) as the symptoms suggest.
- Node-level alerts (memory, page faults, disk) on small clusters often trace to image pulls and
  rollout churn; check timing against recent rollouts before treating them as real.

## Changes

State-changing kubectl operations (at least one step's `run` must be one of these):
`set` (image, env, resources), `scale`, `rollout undo|restart|pause|resume`, `patch`, `delete`,
`create`, `apply`, `replace`, `label`, `annotate`, `cordon`, `uncordon`, `drain`, `taint`.
A step may read (`get`, `describe`, `logs`, `wait`) when a later step depends on it, e.g. a
pre-check; such a step has no `rollback`. `rollback` is always one of the operations above.

Preferences, in order: `rollout undo` (bad rollout) → `set image` (pin a known-good tag) →
`scale` → `patch` → `delete pod` (only to force a reschedule; never delete the controller) →
`apply`/`create`.

## Verify and rollback

A verify *waits for the state the step was meant to produce* and asserts it through its exit code.
Decide what "fixed" looks like for this alert before writing it: usually the condition the alert
fired on no longer holds (replicas available again, pods Ready, the image back on a good tag).
`kubectl wait` is the tool for that; it blocks until the assertion holds or the timeout passes,
and exits non-zero on timeout:

- the alert was "no available replicas" → `kubectl -n <ns> wait --for=jsonpath='{.status.availableReplicas}'=<replicas> deploy/<name> --timeout=90s`
- image pinned / rolled back → `kubectl -n <ns> wait --for=jsonpath='{.spec.template.spec.containers[0].image}'=<good tag> deploy/<name> --timeout=30s`
- scaled → `kubectl -n <ns> wait --for=jsonpath='{.status.availableReplicas}'=<n> deploy/<name> --timeout=90s`
- pods healthy → `kubectl -n <ns> wait --for=condition=Ready pod -l app=<name> --timeout=90s`
- a rollout finished and is available → `kubectl -n <ns> rollout status deploy/<name> --timeout=90s`

Prefer the assertion that matches the alert (`availableReplicas`, `Ready`) over `rollout status`,
which only says the rollout finished. One verify per step; when a value and health both matter,
assert the value on the step that set it and health on the step that depends on it. `get`,
`describe` and `logs` exit 0 whatever they show: they are investigation, never verification.
- Rollback returns to the previous state: `rollout undo` after a rollout-producing change,
  `scale --replicas=<previous>` after a scale, `set image ...=<previous tag>` after a pin.
  Never re-apply the bad state on purpose.

## Executor

The executor runs each step as a Machine ID bot with Kubernetes access limited to the demo
namespace. Anything outside it is denied by Teleport and shows as a 403 in the audit log.
