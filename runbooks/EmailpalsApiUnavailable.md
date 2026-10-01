# EmailpalsApiUnavailable (no available replicas) / KubePodCrashLooping

A pod in a Deployment is restarting or never becomes ready.

## Investigate
1. `kubectl -n <ns> get pods -o wide` and `kubectl -n <ns> get deploy <name> -o wide`: which pods, how many restarts, which image.
2. `kubectl -n <ns> describe pod <pod>`: look at Events (ImagePullBackOff, ErrImagePull, CrashLoopBackOff, OOMKilled, probe failures) and the container image/tag.
3. `kubectl -n <ns> logs <pod> --previous` (or without --previous if it never started) for application errors.
4. `kubectl -n <ns> rollout history deploy/<name>`: did a recent rollout introduce the problem? Compare the current image with the previous revision.
5. `kubectl -n <ns> get events --sort-by=.lastTimestamp | tail -30`.

## Common causes and the minimal reversible fix

The alert means the Deployment has no available replicas, so "fixed" is `status.availableReplicas`
back at `spec.replicas`. Verify that, with a wait:
`kubectl -n <ns> wait --for=jsonpath='{.status.availableReplicas}'=<spec.replicas> deploy/<name> --timeout=120s`

- **Bad image tag / ImagePullBackOff after a rollout** → `kubectl -n <ns> rollout undo deploy/<name>`; rollback = `kubectl -n <ns> rollout undo deploy/<name>` again (returns to the broken revision); verify = the availableReplicas wait above.
- **Known-good image is identifiable** → `kubectl -n <ns> set image deploy/<name> <container>=<good image>`; rollback = set image back to the current (broken) tag; verify = the availableReplicas wait (or, to assert the tag itself, `wait --for=jsonpath='{.spec.template.spec.containers[0].image}'=<good image>`).
- **OOMKilled** → raise limits with `kubectl -n <ns> set resources deploy/<name> --limits=memory=<bigger>`; rollback = set the previous limits; verify = the availableReplicas wait.
- **Probe misconfiguration after a change** → rollout undo; verify = the availableReplicas wait.

Do not delete pods or deployments as a fix; controllers recreate them and it hides the cause.
