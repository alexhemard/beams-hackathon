## Status (2026-09-28)

**Execution moved to the investigator; the executor API is fixed; TUI keys follow state.**

- The Investigations tab drives execution. The investigator registered the executor (its beam, bot and app) and is the one that calls its MCP tools from inside its beam. `n` / `v` / `b` / `r` on an investigation send one instruction each through the investigator's tmux window (same channel as `p`); the TUI then polls the executor's `status` until the command log reflects the operation, and re-enables the keys. The laptop calls the executor directly only when the investigator's beam is gone (`driver: laptop`).
- The Change Requests tab is a stand-in for a Teleport Access Request UI: it shows the request as filed (requester, roles, timestamps, reason) and offers approve / deny as the reviewer. Nothing executes from there.
- cr-exec's MCP surface is fixed: `status`, `exec`, `verify`, `rollback`, always registered. Every guard is in the handler: not approved, wrong phase (e.g. `exec` on COMPLETE), out of order (`expect`), and one command at a time (`inflight`). An invalid call returns an error naming the phase and what is valid instead. Tools no longer appear or disappear; `status` reports `available` (what would succeed now), `inflight` and the full command `log`. Earlier text describing tools that "appear on approval" is superseded.
- The investigation view shows an `executor:` block: `none` before submit, otherwise state (READY / IN PROGRESS n/m / RUNNING step.kind / COMPLETE / FAILED / …), request state, beam / bot / app, driver, pending or running operation, last command, and the steps with marks.
- Hotkeys are computed from the selection's state (`actionsFor` in `cli/tui.ts`) and the help bar shows only those. Executors with no investigation row (filed from the CLI, or a lost `~/.cr`) get a synthesized row marked "investigator gone" so they can still be closed.
- Local state vs remote state: the TUI keeps **intents**. Every action that takes effect remotely (submit, exec / verify / rollback / run) records `pending` on the investigation: what was asked, of whom (investigator or laptop), when, and the remote observation it was based on (executor log length, phase). The view derives from local state plus the intent ("submitting · registering executor", "exec via investigator"), and the keys that would conflict are absent meanwhile. One `reconcile()` runs after every remote fetch (request list, bot labels, executor status, transcript markers such as `CR-FILED`) and clears the intent when remote state reflects it, or after its timeout (submit 15 min, one operation 5 min, run-all 30 min) with a warning. `CR-FILED` in the transcript triggers an immediate request fetch instead of waiting for the timer. On boot, intents are dropped and remote state decides; `~/.cr/investigations.json` is a cache of local facts (draft path, transcript, links), never of remote state.
- The investigator is a service, tmux is a dump. The agent serves `GET /state`, `GET /events?since=`, `POST /message`, `PUT /draft` on its beam, published as a Teleport app (same JWT caller check as cr-exec, owner only). The TUI keeps a pooled `tsh proxy app` per investigator and polls; `p`, `s`, `n`/`v`/`b`/`r` and `e` are API calls. The tmux control-mode channel (`cli/tmuxctl.ts`, `capture-pane` scraping, `send-keys -H`, marker regexes) is deleted. tmux remains only so the agent's stdout is a pty that Teleport records (the TUI's `tsh beams ssh` recorder, session summaries) and that `A` can attach to; API messages are echoed there as `[operator] …`, so the recording is still the whole conversation. Submit progress is tracked by the agent from `submit-cr.sh`'s step lines and served in `/state`.
- Why the investigator and not the TUI: the executor is the investigator's, registered from its beam under the operator's identity; having the same agent that wrote the steps call them keeps one narrative (transcript = what was diagnosed, what was asked, what ran) and one recorded session. The TUI is a view over Teleport plus the executor's status, not a second driver.

## Status (2026-09-26)

Built and verified on `flat-pine.beams.sh`: `oncall` TUI (Alerts / Investigations / Change Requests); investigation beam with read-only bot running the pi-agent-core investigator under tmux (attachable), drafting a valid CR from a mock cluster; CR filed as an Access Request; executor beam with per-CR bot deployed while PENDING, exposing `status` only, then `exec` / `verify` / `rollback` within 10s of approval; one-step-at-a-time execution with server-owned cursor; deliberate rollback after COMPLETE; teardown of beam, bot, token. Approval in tests came from a Machine ID bot with `oncall-reviewer`; the human reviewer path needs `tctl users reset cr-reviewer` completed once.

Update (later 2026-09-26): order is now **register, then request**. `oncall submit` deploys the executor first (beam, labeled bot, cr-exec from the CR file, published app), then files the Access Request whose reason is the CR plus an `executor:` block naming that bot/beam/app. The reviewer approves a concrete registered executor; cr-exec discovers its request by that block, checks the steps match, and exposes `exec`/`verify`/`rollback` only when APPROVED. Executor tools are `status`, `exec`, `verify`, `rollback` (one step at a time, implicit cursor). Tracking lives in Teleport via labeled bots (`oncall/role|owner|beam-alias|beam-id|ref|app`); `~/.cr` is a cache. Verified live end to end (exec aborted only for lack of a cluster).

Still needed for the live demo: `brew install kind` + `demo/up.sh` (kube-agent join token is already in Terraform), `demo/break.sh` for a real KubePodCrashLooping alert, then `npx tsx cli/oncall.ts`.

Update (2026-09-26 afternoon): **first real live run done.** Alertmanager wired through Teleport (v8 `kubernetes_resources` needs `{kind: services, verbs: [get, proxy]}` for the API server service proxy). Real alert → investigation beam with a real read-only bot kubeconfig → CR `rollout undo` → register executor → request → bot approval → `exec` as `bot-cr-*` against kind, verify passed → teardown. Demo app renamed to E-mail Pals (`emailpals-web` static site vendored from github.com/alexhemard/email-pals and published as Teleport app `emailpals-web`; `emailpals-api` with `Recreate` strategy so a bad image is a real outage; alert `EmailpalsApiUnavailable`). TUI: details panel for the selection, pane switch follows the selection, 20s auto-refresh, background executor status, `c` close = teardown. CR carries `alert: {name, fingerprint}`; closing a CR = verified COMPLETE + alert resolved + executor torn down. `demo/approve.sh` approves as `cr-reviewer-bot`. Ghostty attach fixed by shipping terminfo into the beam.


# Change Request MVP on Beams

Prove one thing end to end, on shipped Teleport (tenant `flat-pine.beams.sh`, 18.11.2): **a change request (CR) is filed as an Access Request; after approval, a beam holding an escalated identity runs a bespoke MCP server whose only tools are that CR's steps; the steps execute against a real cluster; every hop is in the audit log.** No LLM, no TUI, no alerting in the MVP. Those are the on-call demo gaps to fill afterwards.

## Context

### Why this shape
- Beams give a disposable sandbox with your identity and no private keys, but every beam you own carries your current roles and cannot reissue certs (`lib/tbot/services/identity/key_agent_service.go:207`). So escalation cannot come from your identity. The team's prescribed workaround (Cassie's `beams-tbot-cross-cluster/QUICKSTART.md`, Steven Martin, Sasha in #dev-beams-feedback) is to **run a second tbot inside the beam as a separate Machine ID bot** joined with a one-time bound-keypair secret. That is how the executor beam gets escalated privileges here.
- MCP apps can't be reached from a beam today (`tsh mcp connect` needs a reissue; Steve Huang, #dev-beams-feedback, Jul 16 and Sep 24). His workaround is ours: serve MCP over streamable HTTP as a plain HTTP app and point an MCP client at it. Fixed by the login-agent PRs (teleport#68612/68614, open).
- The proper version of all this is Delegation V2 (core#536, RFD 0329: `tsh beams add --roles`, in-beam access requests, VNet assuming approved requests). Not in 18.11. This MVP validates the workflow on what ships and documents the gaps neutrally.

### What the MVP proves
1. The Access Request is the change request: YAML steps with `run`/`rollback`/`verify` in the reason, reviewed with the standard flow.
2. Approval is the trigger and the gate: nothing executes until state is APPROVED, and the executor re-checks on every call.
3. The escalated identity exists only in the executor beam, only for this CR: bot `cr-<id8>`, narrow role, one-time secret, deleted at teardown.
4. The agent surface is exactly the approved steps: an MCP server generated from the CR, deny-by-default, ordered, one-shot.
5. Audit chain: `access_request.create/review` → beam create (you) → `app.session.*` (you, calling the executor) → `kube.request` (bot `cr-<id8>`), correlated by CR id.

### Honest caveats to state
- The Kubernetes writer is a bot correlated to you by name, not you (Han Cho's and Brian's point in the channel).
- The bot's private key lives in the beam user container; mitigated by one-time secret, short TTL, narrow role, teardown.
- Beams A/B/C share your identity; they isolate context, not privilege. Privilege isolation comes from the bot.

### Login and users
- Laptop side runs entirely under `tsh login --proxy=flat-pine.beams.sh:443 --user=alex.hemard@goteleport.com` (tsh auto-updates to 18.11.1). Requires `editor` + `beam-user` on that user; confirm with `tsh status` at H0.
- A second user `cr-reviewer` (role `oncall-reviewer`) approves, since self-review is not allowed.

### Change target
Default below is Kubernetes (kind cluster enrolled in flat-pine) for on-call realism. **Zero-infra alternative**: make the CR change Teleport itself (`tctl create/rm/get` on a role or app) with only the tbot `identity` output in the beam; audit shows `role.created`/`role.deleted` by the bot. Only the bot role, the tbot service, and cr-exec's `argv[0]` allowlist change. Pick at H1.

## Flow

```
laptop (you, editor)                          beam B (yours; + bot cr-<id8> via tbot)               kind cluster (enrolled in flat-pine)
  cr submit cr.yaml                             bootstrap.sh <proxy> <token> <secret> <req-id>          deployment emailpals-api (ns emailpals)
    → tsh request create --roles oncall-change      download tbot → enroll (bound_keypair, --oneshot)     ClusterRole oncall-fix ← group oncall-fix ← bot role
      --reason "$(cat cr.yaml)" → <req-id>          tbot start: identity (allow_reissue) + kubernetes/v2  Teleport kube RBAC: bot role kubernetes_groups [oncall-fix]
reviewer (2nd user)                                 cr-exec :8080/mcp --cr <req-id>
  tsh request review --approve <req-id>               load CR from request via `tsh -i bot-identity request ls`
  (or Web UI)                                         tools: <step>.run/.verify (+ .rollback after failure), cr.status
laptop                                                exec: kubectl --kubeconfig tbot-kubeconfig <argv>  ──▶ kube.request as bot-cr-<id8>
  cr perform <req-id>                                 verify caller JWT username == requester, state APPROVED
    → tctl bots add cr-<id8> --roles=cr-executor    tsh beams publish B  → HTTP app <alias>-<id4>
    → tctl create token (bound_keypair, secret)
    → tsh beams add --no-console --format json
    → tsh beams scp bundle; tsh beams exec B bootstrap.sh …
  cr run <req-id>
    → tsh proxy app <alias>-<id4> → MCP client (streamable HTTP) → calls step tools in order → report
  cr teardown <req-id>
    → tsh beams rm B; tctl bots rm cr-<id8>; tctl tokens rm
```

Beam C (a second beam of yours running `cr run` over VNet instead of `tsh proxy app`) is a stretch; it adds context isolation for the caller, not privilege.

## CR format (Access Request reason, ≤4096 bytes, `lib/services/access_request.go:52`)
```yaml
kind: change-request
summary: scale emailpals-api to 3 replicas and confirm rollout
risk: low
steps:
  - name: scale-up
    run:      kubectl -n emailpals scale deploy/emailpals-api --replicas=3
    rollback: kubectl -n emailpals scale deploy/emailpals-api --replicas=1
    verify:   kubectl -n emailpals rollout status deploy/emailpals-api --timeout=90s
```
Rules cr-exec enforces: tools `<step>.run`, `<step>.verify`, `cr.status`; `step[i].run` only after `step[i-1].verify` (or `.run`) succeeded; `.run` one-shot; on any non-zero `run`/`verify` → FAILED, `.rollback` tools for completed steps appear (reverse order) and `.run` tools disappear; argv via shell-words, no shell, argv[0] must be `kubectl`; request must be APPROVED and unexpired, roles ∋ `oncall-change`, `Teleport-Jwt-Assertion` username == requester (JWT claims: `lib/jwt/jwt.go:103-124`; JWKS at `https://flat-pine.beams.sh/.well-known/jwks.json`).

## Teleport objects (all `tctl create`, all standard)
- **Role `oncall-change`**: approval carrier, empty allow. Your role gains `request.roles: [oncall-change]`.
- **Role `oncall-reviewer`**: `review_requests.roles: [oncall-change]`. Assigned to reviewer user `cr-reviewer` (`tctl users add`; self-review isn't allowed).
- **Role `cr-executor`** (bot role): `kubernetes_labels: {env: demo}`, `kubernetes_groups: [oncall-fix]`, `kubernetes_resources: [{kind: "*", namespace: emailpals, name: "*", verbs: ["*"]}]`, `rules: [{resources: [access_request], verbs: [list, read]}]`. Created per CR as bot `cr-<id8>` by `cr perform`; the role is shared.
- **Token** per CR: `kind: token`, `join_method: bound_keypair`, `bot_name: cr-<id8>`, `bound_keypair.onboarding.registration_secret: <openssl rand -hex 24>`, `recovery.limit: 1`, short expiry. (Cassie's recipe, Part 1.3.)
- **Kube agent**: `teleport-kube-agent` chart in kind, `roles: kube`, `kubeClusterName: oncall`, labels `env: demo`; join token from `tctl tokens add --type=kube`.
- **Kubernetes RBAC**: ClusterRole `oncall-fix` (deployments get/patch/update, deployments/scale, pods get/list, replicasets get/list) bound to group `oncall-fix`.

## Inside beam B (`bootstrap.sh`, from Cassie's quickstart Part 2)
```bash
curl -sL https://cdn.teleport.dev/teleport-v18.11.1-linux-$(dpkg --print-architecture)-bin.tar.gz | tar xz -C /tmp teleport/tbot && mv /tmp/teleport/tbot ~/bin/
~/bin/tbot start identity --proxy-server=flat-pine.beams.sh:443 --token=cr-<id8> --registration-secret='…' \
  --join-method=bound_keypair --storage=/home/beams/tbot-storage --destination=/home/beams/bot-id --oneshot
# tbot.yaml: onboarding bound_keypair; services: identity (allow_reissue: true → /home/beams/bot-id), kubernetes/v2 (kubernetes_cluster: oncall → /home/beams/kube)
env -u TELEPORT_PROXY -u TELEPORT_CLUSTER -u TELEPORT_IDENTITY_FILE -u TELEPORT_KEY_AGENT_DIR \
  beamctl start --name tbot -- ~/bin/tbot start -c /home/beams/tbot.yaml
beamctl start --name cr-exec -- node cr-exec/dist/server.js --cr <req-id> --identity /home/beams/bot-id/identity --kubeconfig /home/beams/kube/kubeconfig.yaml --port 8080
tsh beams publish $(hostname)   # or from laptop; HTTP app owned by you
```
The env scrub matters: the beam's `TELEPORT_PROXY` overrides tbot's config (quickstart 2.3). Node is preinstalled in beams (banner lists Node.js).

## Deliverables (new repo `~/beams-hackathon`, TypeScript; no Teleport code changes)
```
beams-hackathon/
  cli/                    `cr` command (tsx): submit | perform | run | status | teardown
    submit.ts             validate cr.yaml (TypeBox) → tsh request create --roles oncall-change --reason … --nowait --format json
    perform.ts            assert APPROVED (tsh request ls --format json) → tctl bots add / token create → tsh beams add → scp bundle → exec bootstrap → poll publish → print app name
    run.ts                tsh proxy app <app> (laptop) or VNet URL (beam C) → MCP client → cr.status → call tools in order → on FAILED call rollbacks → report
    teardown.ts           tsh beams rm; tctl bots rm; tctl tokens rm
  cr-exec/                MCP streamable-HTTP server (@modelcontextprotocol/sdk)
    server.ts             tools from CR + phase state machine; deny-by-default
    approval.ts           `tsh -i <bot identity> request ls --format json` → APPROVED, unexpired, requester, reason → CR; re-check per call
    identity.ts           JWT verify (jose, JWKS) → username
    exec.ts               spawn kubectl with --kubeconfig; argv allowlist; timeout; structured log {cr, step, tool, caller, exit}
    bootstrap.sh, tbot.yaml.tmpl
  shared/cr.ts            CR schema + YAML parse + shell-words
  terraform/              roles (oncall-change, cr-requester, oncall-reviewer, cr-executor), user cr-reviewer, kube-agent join token; apply with `eval "$(tctl terraform env)"`
  teleport/token.yaml.tmpl  per-CR bound_keypair token template used by `cr perform` (not Terraform-managed)
  k8s/rbac.yaml, emailpals-api.yaml
  demo/cr-scale.yaml, cr-unfixable.yaml (verify times out → rollback path)
  DEMO.md
```

## Timeline (MVP ≈ 6h)
**H0–H1 · Checks on flat-pine** — `tsh login --proxy flat-pine.beams.sh` (auto-updates tsh to 18.11.1); `tctl status` (editor?); Web UI: are `/web/requests` and `/web/audit/events` unlocked or upsell? `tsh beams add --no-console --format json`, `exec`, `scp`, `publish`, `rm` round-trip; inside a beam: `curl` the tbot tarball, `node -v`, `beamctl list`; `tsh beams publish` from inside the beam works?
**H1–H2 · Cluster + objects** — `brew install kind` (you); kind → `emailpals-api` deployment; `teleport-kube-agent` joins flat-pine; RBAC; `tctl create -f teleport/roles.yaml`; `tctl users add cr-reviewer --roles=oncall-reviewer`; test bot join by hand from a beam (Cassie's Part 2) and `kubectl --kubeconfig … -n emailpals get deploy` as the bot.
**H2–H4 · cr-exec** — server, approval, identity, exec; test in beam with a hand-approved request: `tools/list` empty before approval → step tools after → ordering/replay refused → forced failure → rollback tools only.
**H4–H5 · `cr` CLI** — submit/perform/run/teardown; `perform` idempotent and printing every tsh/tctl command it runs (that's the demo narration).
**H5–H6 · End to end + DEMO.md** — happy path (`cr-scale.yaml`), failure path (`cr-unfixable.yaml`), audit screenshots or `tsh request show` + cr-exec log + Kubernetes audit, teardown.

**On-call gaps to fill after the MVP** (in order of value): pi-agent-core fixer driving the MCP tools instead of the deterministic runner; investigator beam with read-only `kube-api` HTTP app and runbooks drafting the CR; pi-tui with Alerts and Change Requests panes; ArgoCD bad-revision scenario with a real Alertmanager alert; beam C as caller over VNet; separate rollback beam; Slack approvals via the existing plugin.

## Verification
- `cr submit` → `tsh request show <id>` prints the YAML verbatim; reviewer sees it (UI or CLI).
- Before approval: `cr perform` refuses; a hand-started cr-exec exposes zero tools.
- After approval: `cr perform` creates bot, token, beam, publishes; `tsh beams ls` shows B; `tctl bots ls` shows `cr-<id8>`.
- `cr run`: `scale-up.run` → `scale-up.verify` → COMPLETE; `kubectl -n emailpals get deploy emailpals-api` shows 3 replicas.
- Negatives: `scale-up.verify` before `.run` → refused; `.run` twice → refused; caller ≠ requester (log in as `cr-reviewer`, `tsh proxy app`) → zero tools; `tctl bots rm` mid-run → next call fails (bot identity gone).
- Failure path: `cr-unfixable.yaml` → verify fails → `scale-up.rollback` appears, `.run` gone → rollback → ROLLED_BACK.
- Audit: `access_request.create`, `access_request.review`; `beam` create by you; `app.session.start/request` by you against `<alias>-<id4>`; `kube.request` by `bot-cr-<id8>` on cluster `oncall`; correlate by CR id in cr-exec log.
- `cr teardown` → beam gone, bot gone, token gone; `tsh beams ls` and `tctl bots ls` clean.

## Findings to record (facts, not proposals)
- Beam identities can't reissue; escalation required a second tbot/bot in the beam (team's prescribed workaround). Delegation V2 (core#536) is the native path.
- MCP-subkind apps unreachable from beams; served MCP over HTTPS as a plain app (Steve Huang's workaround; login-agent PRs pending).
- Kubernetes writes attributed to `bot-cr-<id8>`, correlated to you by naming convention (Cassie's guide says the same).
- Access Requests have no completion state; CR state lives in cr-exec.
- Whatever H0 showed about the beams.sh Web UI entitlements and `tsh beams publish` from inside a beam.
