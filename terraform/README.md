# Teleport resources for the change-request MVP

Creates the static Teleport objects the demo needs on the Beams tenant. Everything
per change request (bot `cr-<id8>`, its bound-keypair token, the beam, the
published app) is created and torn down by the `cr` CLI, not here.

| Resource | Purpose |
|---|---|
| role `oncall-change` | Approval carrier. The CR is an Access Request for this role. |
| role `cr-requester` | Lets the requester file CRs (`request.roles: [oncall-change]`). |
| role `oncall-reviewer` | Lets the reviewer review CRs (Teleport: review_requests). |
| role `cr-executor` | Bot role: Kubernetes write in one namespace + read Access Requests. |
| user `cr-reviewer` | Local reviewer account. |
| provision token | Join token for the `teleport-kube-agent` chart in the kind cluster. |

## Apply

```sh
tsh login --proxy=flat-pine.beams.sh:443 --user=alex.hemard@goteleport.com
eval "$(tctl terraform env)"      # short-lived bot creds for the provider; same shell only

cd terraform
terraform init
terraform apply
```

`tctl terraform env` needs your user to be able to create bots and tokens, which
`editor` provides. It exports `TF_TELEPORT_ADDR` and
`TF_TELEPORT_IDENTITY_FILE_BASE64`; the provider picks them up without any
provider-block credentials.

## After apply

1. Set the reviewer's password and MFA once:
   ```sh
   tctl users reset cr-reviewer
   ```
2. Attach `cr-requester` to your own user. You are an SSO user, so do this in the
   Web UI (Users) or in your connector's role mapping. Keep `editor` and
   `beam-user`; `cr perform` needs both.
3. Enroll the kind cluster:
   ```sh
   terraform output -raw helm_install | sh
   kubectl apply -f ../k8s/rbac.yaml      # ClusterRole oncall-fix bound to group oncall-fix
   kubectl apply -f ../k8s/emailpals-api.yaml
   tsh kube ls                             # cluster "oncall" should appear
   ```

## Destroy

```sh
terraform destroy
```

Per-CR bots and tokens left behind by an interrupted run are listed with
`tctl bots ls` and `tctl tokens ls`, and removed with `cr teardown <id>`.
