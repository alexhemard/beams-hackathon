# Teleport + EKS resources for the change-request MVP

Creates the static objects the demo needs: Teleport roles/users/tokens on the
Beams tenant, plus the EKS cluster (and its VPC) that `teleport-kube-agent`
enrolls. Everything per change request (bot `administrator-<id8>`, its bound-keypair
token, the beam, the published app) is created and torn down by the `cr`
CLI, not here.

| Resource | Purpose |
|---|---|
| role `oncall-change` | Approval carrier. The CR is an Access Request for this role. |
| role `operator` | Lets the requester file CRs (`request.roles: [oncall-change]`). |
| role `webmaster` | Lets the reviewer review CRs (Teleport: review_requests). |
| role `administrator` | Bot role: full cluster-admin kube access + read Access Requests. Held by per-CR executor bots and the short-lived cluster-setup bot (`demo/lib-teleport-admin.sh`); never held standing. |
| user `webmaster` | Local reviewer account. |
| provision token | Join token for the `teleport-kube-agent` chart in the EKS cluster. |
| `module.vpc` | VPC (2 AZs, public + private subnets, one NAT gateway) for the EKS cluster. |
| `module.eks` | EKS cluster + managed node group the demo workload and the kube agent run on. |
| `aws_security_group_rule.node_to_teleport_proxy` | Explicit egress so the kube agent on the nodes can reach the Teleport proxy. |
| `generated.tf` (`local_file.bootstrap_kube_agent_script`) | Renders `terraform/bootstrap-kube-agent.sh` (gitignored — has a plaintext join token) from `templates/bootstrap-kube-agent.sh.tftpl`, filled in with the real cluster/token/RBAC values. Run it from CloudShell. See below. |

This file (`eks.tf`) provisions **real, billable AWS infrastructure**. Review
`node_instance_types` / `node_desired_size` in `variables.tf` before applying.

If the account is already at its `VpcLimitExceeded` quota in the target region,
set `vpc_id` and `private_subnet_ids` (in a `.tfvars` file or `-var`) to reuse an
existing VPC instead of creating one — `module.vpc` is skipped entirely when
`vpc_id` is set.

**The EKS API server endpoint is private by default** (`cluster_endpoint_public_access
= false`), and nothing in this repo ever needs it to be public — Teleport is the bastion
for everything except the very first step:

- **Installing the kube agent itself** is the one thing that *can't* go through Teleport
  (nothing exists yet for Teleport to proxy), so it needs direct network access to the
  private endpoint. `terraform apply` renders `terraform/bootstrap-kube-agent.sh` (via
  `generated.tf`, from `templates/bootstrap-kube-agent.sh.tftpl`) with the real cluster
  name, join token, proxy address and `k8s/rbac.yaml` content already filled in — no
  parameters to pass, no repo checkout needed wherever you run it. Run it from **AWS
  CloudShell launched in a VPC** (CloudShell's own "Actions > create VPC environment" —
  pick the VPC/subnet/security-group values the `bootstrap_kube_agent_cloudshell` output
  gives you, or that are in the script's own header comment), upload or paste the script,
  and run it there. CloudShell's VPC environment gets a real ENI inside your private
  subnets — the same network path the EKS nodes themselves have — with no bastion EC2
  instance, no public exposure, ever. It installs `teleport-kube-agent` (`roles=kube`
  only — no app yet, since `emailpals-web` doesn't exist until the next step) and applies
  `k8s/rbac.yaml` (the RBAC that makes everything below mean anything).

  An earlier version of this automated the above with a CodeBuild project — dropped
  because `CreateProject` with `vpc_config` requires `ec2:DescribeSecurityGroups` on
  whoever runs `terraform apply`, which not every account grants, and isn't needed for
  the CloudShell path. `cluster_endpoint_public_access = true` remains as a fallback if
  CloudShell genuinely isn't available to you, but shouldn't be necessary.
- **Everything after that** — `demo/kubeup.sh` (monitoring stack, demo app, publishing
  `emailpals-web` as a Teleport app), `demo/break.sh`, `demo/reset.sh` — goes through
  Teleport. Each sources `demo/lib-teleport-admin.sh`, which mints a short-lived Machine ID
  bot (named `cluster-setup-*`, so it's identifiable in audit logs) with the `administrator`
  role — the same role per-CR executor bots hold, full cluster-admin kube access, bound to
  the `administrator` k8s group `k8s/rbac.yaml` just applied — and logs it in via `tsh kube
  login`, then deletes the bot on exit. No AWS credentials, no VPC network access, no
  CloudShell — just Teleport, same as the CR flow. Still a deliberately *separate* identity
  from `operator` (the human's own role, read-only) — nothing standing ever holds
  `administrator`, only short-lived bots minted per CR or per script run. One role instead
  of a namespace-scoped one plus a cluster-admin one is a deliberate simplification for a
  demo cluster: see `terraform/roles.tf` for the trade-off this accepts.

## Apply

Two separate credential sources are needed in the same shell:

```sh
# Teleport objects (roles, users, tokens) — short-lived bot credentials
tsh login --proxy=flat-pine.beams.sh:443 --user=alex.hemard@goteleport.com
eval "$(tctl terraform env)"

# EKS/VPC objects — your own AWS credentials (profile, env vars, or an assumed role)
export AWS_PROFILE=...   # or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
# Region: provider "aws" { region = var.aws_region } in eks.tf pins it to the Terraform
# variable, not the AWS CLI/SDK's usual AWS_REGION env var — that one has no effect here.
export TF_VAR_aws_region=us-east-2   # default; or -var='aws_region=...', or set it in a tfvars file

cd terraform
terraform init
terraform apply
```

`tctl terraform env` needs your user to be able to create bots and tokens, which
`editor` provides. It exports `TF_TELEPORT_ADDR` and
`TF_TELEPORT_IDENTITY_FILE_BASE64`; the Teleport provider picks them up without
any provider-block credentials. The `aws` provider uses the standard AWS SDK
credential chain — nothing Teleport-specific.

## After apply

1. Set the reviewer's password and MFA once:
   ```sh
   tctl users reset webmaster
   ```
2. Attach `operator` to your own user. You are an SSO user, so do this in the
   Web UI (Users) or in your connector's role mapping. Keep `editor` and
   `beam-user`; `cr perform` needs both.
3. Install the kube agent from CloudShell (one time): `terraform output
   bootstrap_kube_agent_cloudshell` for the VPC/subnet/security-group values, launch a
   CloudShell VPC environment with them, then upload/paste and run
   `terraform/bootstrap-kube-agent.sh`. Confirm with `tsh kube ls` (cluster
   `emailpals-production` should appear).
4. Install the rest of the demo stack, through Teleport, no AWS credentials needed:
   ```sh
   ../demo/kubeup.sh    # monitoring + demo app + publishes emailpals-web as a Teleport app
   ```
   `terraform output -raw eks_update_kubeconfig` is still there if you ever want direct
   `aws eks update-kubeconfig` access yourself (needs `cluster_endpoint_public_access =
   true` or a CloudShell-in-VPC session, since the endpoint is private) — nothing in this
   repo requires it.

## Destroy

```sh
terraform destroy
```

This tears down the EKS cluster and VPC along with the Teleport objects. Run
`demo/reset.sh` first if you want the demo app's state cleaned up and any
leftover CR bots/tokens/beams removed; `terraform destroy` itself doesn't know
about those. Per-CR bots and tokens left behind by an interrupted run are also
listed with `tctl bots ls` and `tctl tokens ls`.
