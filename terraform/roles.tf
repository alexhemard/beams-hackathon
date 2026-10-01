# Roles for the change-request MVP.
#
#   oncall-change    approval carrier. The CR is an Access Request for this role.
#                    Nothing consumes it as a role; cr-exec checks for an APPROVED
#                    request naming it. Empty allow on purpose.
#   cr-requester     attach to the requester (you). Lets you file CRs.
#   oncall-reviewer  attach to the reviewer user. Lets them approve CRs.
#   cr-executor      bot role. One bot `cr-<id8>` per CR is created by the `cr`
#                    CLI with this role and a one-time bound-keypair token. The
#                    bot runs inside the executor beam and performs the change.

resource "teleport_role" "oncall_change" {
  version = "v8"
  metadata = {
    name        = "oncall-change"
    description = "Approval carrier for change requests. Grants nothing by itself."
    labels      = { "beams-hackathon" = "cr" }
  }
  spec = {
    allow = {}
  }
}

resource "teleport_role" "cr_requester" {
  version = "v8"
  metadata = {
    name        = "cr-requester"
    description = "On-call operator: may file change requests, and has read-only Kubernetes access to the demo cluster for the TUI (alerts, status)."
    labels      = { "beams-hackathon" = "cr" }
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
    }
  }
}

# Bot role for the investigation beam: read-only Kubernetes. The investigator
# agent diagnoses with kubectl get/describe/logs/events and drafts the CR; it
# cannot change anything.
resource "teleport_role" "cr_investigator" {
  version = "v8"
  metadata = {
    name        = "cr-investigator"
    description = "Bot role for per-investigation bots running inside a beam. Read-only Kubernetes."
    labels      = { "beams-hackathon" = "cr" }
  }
  spec = {
    options = {
      max_session_ttl = "2h"
    }
    allow = {
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
    }
  }
}

resource "teleport_role" "oncall_reviewer" {
  version = "v8"
  # renaming a role: create the new one before the old is destroyed, so the reviewer user (which
  # references it) can be moved over first; Teleport refuses to delete a role a user still holds
  lifecycle {
    create_before_destroy = true
  }
  metadata = {
    name        = "oncall-reviewer"
    description = "May review change requests."
    labels      = { "beams-hackathon" = "cr" }
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

resource "teleport_role" "cr_executor" {
  version = "v8"
  metadata = {
    name        = "cr-executor"
    description = "Bot role for per-CR executor bots running inside a beam. Kubernetes write in one namespace, plus read access to Access Requests so cr-exec can verify approval."
    labels      = { "beams-hackathon" = "cr" }
  }
  spec = {
    options = {
      max_session_ttl = "2h"
    }
    allow = {
      kubernetes_labels = var.kube_labels
      kubernetes_groups = [var.kube_group]
      kubernetes_resources = [{
        api_group = "*"
        kind      = "*"
        namespace = var.kube_namespace
        name      = "*"
        verbs     = ["*"]
      }]
      rules = [
        {
          # cr-exec verifies the approval through the bot identity
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
