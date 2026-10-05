# Roles for the change-request MVP.
#
#   oncall-change    approval carrier. The change request is an Access Request for this role.
#                    Nothing consumes it as a role; plan-runner checks for an APPROVED
#                    request naming it. Empty allow on purpose.
#   operator         attach to the human operator and to every investigation bot. Lets
#                    either file change requests; the bot's grant is what lets it file
#                    one as itself (see investigator-executor-access below). Also the
#                    role for per-investigation bots' read-only kube access, so there's
#                    no separate role for it.
#   webmaster        attach to the reviewer user. Lets them approve change requests.
#   administrator    bot role. Full cluster-admin kube access. Two kinds of bot
#                    hold it, never standing: one `administrator-<id8>` per change
#                    request, created by `investigator/submit-cr.sh` with a one-time
#                    bound-keypair token (runs inside the executor beam and performs
#                    the change), and the short-lived `cluster-setup-*` bot
#                    demo/lib-teleport-admin.sh mints for demo/kubeup.sh, break.sh,
#                    reset.sh. Deliberately one role, not namespace-scoped: on a demo
#                    cluster the approval gate (second reviewer, Access Request) and
#                    plan-runner's own argv checks (only kubectl, only the approved
#                    steps, one at a time) are what actually bound an approved change
#                    request — not this RBAC scope, which was a defense-in-depth layer
#                    worth trading for simplicity here. Don't make this call the same
#                    way for a real cluster.

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

resource "teleport_role" "investigator_executor_access" {
  version = "v8"
  metadata = {
    name        = "investigator-executor-access"
    description = "Lets an investigation bot reach the one executor app for the change request it filed. Scoped by the executor_beam_alias trait, which cli/tui.ts's fetchLive() sets on the bot only after a human approves the request -- not a static grant. Kept separate from operator (shared by the human, oncall-bot, and every investigator bot) so this trait-templated rule only ever applies to bots deliberately given it."
    labels      = { "teleport.dev/creator" = var.teleport_creator }
  }
  spec = {
    allow = {
      app_labels = { "teleport.internal/beams/alias" = ["{{internal.executor_beam_alias}}"] }
      # Confirmed live: issuing an app-scoped cert for a role whose app_labels uses trait
      # templating ({{internal.X}}) fails with "access denied to perform action read on role"
      # without this -- Teleport needs to read the role definition to resolve the template at
      # cert-issuance time. Reading role *definitions* only (RBAC policy text), not a resource
      # access grant.
      rules = [{
        resources = ["role"]
        verbs     = ["read"]
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
    description = "Bot role for per-change-request executor bots, and for the short-lived cluster-setup bot (demo/lib-teleport-admin.sh). Full cluster-admin Kubernetes access, plus read access to Access Requests so plan-runner can verify approval."
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
