# Roles for the change-request MVP.
#
#   oncall-change    approval carrier. The CR is an Access Request for this role.
#                    Nothing consumes it as a role; plan-runner checks for an APPROVED
#                    request naming it. Empty allow on purpose.
#   operator         attach to the requester (you). Lets you file CRs. Also the
#                    role for per-investigation bots inside a beam — identical
#                    read-only kube access, so there's no separate role for it.
#   webmaster        attach to the reviewer user. Lets them approve CRs.
#   administrator    bot role. Full cluster-admin kube access. Two kinds of bot
#                    hold it, never standing: one `administrator-<id8>` per CR,
#                    created by the `cr` CLI with a one-time bound-keypair token
#                    (runs inside the executor beam and performs the change), and
#                    the short-lived `cluster-setup-*` bot demo/lib-teleport-admin.sh
#                    mints for demo/kubeup.sh, break.sh, reset.sh. Deliberately one
#                    role, not namespace-scoped: on a demo cluster the approval gate
#                    (second reviewer, Access Request) and plan-runner's own argv
#                    checks (only kubectl, only the approved steps, one at a time)
#                    are what actually bound an approved CR — not this RBAC scope,
#                    which was a defense-in-depth layer worth trading for simplicity
#                    here. Don't make this call the same way for a real cluster.

resource "teleport_role" "oncall_change" {
  version = "v8"
  metadata = {
    name        = "oncall-change"
    description = "Approval carrier for change requests. Grants nothing by itself."
    labels      = { "teleport.dev/creator" = var.teleport_creator }
  }
  spec = {
    allow = {}
  }
}

resource "teleport_role" "operator" {
  version = "v8"
  metadata = {
    name        = "operator"
    description = "On-call operator: may file change requests, and has read-only Kubernetes access to the demo cluster for the TUI (alerts, status)."
    labels      = { "teleport.dev/creator" = var.teleport_creator }
  }
  spec = {
    allow = {
      request = {
        roles               = [teleport_role.oncall_change.metadata.name]
        max_duration        = var.request_max_duration
        suggested_reviewers = [var.reviewer_user]
      }
      # Lets a bot holding this role (the per-beam `oncall-bot`, and per-investigation bots) open
      # app sessions — needed to reissue the app-scoped cert `tsh proxy app` uses to reach the
      # investigator/executor APIs from inside a beam, whose own delegated identity can never
      # reissue. Scoped to apps Beams published for this user (not a wildcard — bot-side
      # Access-Request elevation to narrow this further isn't available until Delegation V2,
      # core#536, ships; see PLAN.md). The investigator's/executor's own owner-only caller check
      # (investigator/agent.ts, plan-runner/server.ts) and plan-runner's APPROVED-request gate on
      # every operation are the real security boundary — this is just reachability.
      app_labels        = { "teleport.internal/beams/owner" = [var.requester_user] }
      kubernetes_labels = var.kube_labels
      kubernetes_groups = [var.kube_view_group]
      kubernetes_resources = [
        {
          api_group = "*"
          kind      = "*"
          namespace = "*"
          name      = "*"
          verbs     = ["get", "list", "watch"]
        },
        {
          # Alertmanager is read through the API server's service proxy, a separate
          # Teleport verb ("proxy") on the services resource.
          api_group = ""
          kind      = "services"
          namespace = "monitoring"
          name      = "*"
          verbs     = ["get", "proxy"]
        },
      ]
      rules = [{
        # Lets the investigator (and the human operator) run `tctl audit query exec`
        # against kube_request events, to find which identity made a recent breaking
        # change -- root-cause attribution. Read-only: "use" only lets you run a
        # query, not create/persist one.
        resources = ["audit_query"]
        verbs     = ["use"]
      }]
    }
  }
}

resource "teleport_role" "webmaster" {
  version = "v8"
  # renaming a role: create the new one before the old is destroyed, so the reviewer user (which
  # references it) can be moved over first; Teleport refuses to delete a role a user still holds
  lifecycle {
    create_before_destroy = true
  }
  metadata = {
    name        = "webmaster"
    description = "May review change requests."
    labels      = { "teleport.dev/creator" = var.teleport_creator }
  }
  spec = {
    allow = {
      review_requests = {
        roles = [teleport_role.oncall_change.metadata.name]
      }
      rules = [{
        resources = ["access_request"]
        verbs     = ["list", "read"]
      }]
    }
  }
}

resource "teleport_role" "administrator" {
  version = "v8"
  metadata = {
    name        = "administrator"
    description = "Bot role for per-CR executor bots, and for the short-lived cluster-setup bot (demo/lib-teleport-admin.sh). Full cluster-admin Kubernetes access, plus read access to Access Requests so plan-runner can verify approval."
    labels      = { "teleport.dev/creator" = var.teleport_creator }
  }
  spec = {
    options = {
      max_session_ttl = "2h"
    }
    allow = {
      kubernetes_labels = var.kube_labels
      kubernetes_groups = [var.kube_admin_group]
      kubernetes_resources = [{
        api_group = "*"
        kind      = "*"
        namespace = "*"
        name      = "*"
        verbs     = ["*"]
      }]
      rules = [
        {
          # plan-runner verifies the approval through the bot identity
          resources = ["access_request"]
          verbs     = ["list", "read"]
        },
        {
          # zero-infra target (demo/cr-lock-user.yaml): lock / unlock a user
          resources = ["lock"]
          verbs     = ["create", "read", "list", "update", "delete"] # tctl lock upserts
        },
      ]
    }
  }
}
