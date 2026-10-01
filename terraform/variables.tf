variable "proxy_addr" {
  description = "Teleport proxy address of the Beams tenant."
  type        = string
  default     = "flat-pine.beams.sh:443"
}

variable "reviewer_user" {
  description = "Local Teleport user who approves change requests. Self-review is not allowed, so this must not be the requester."
  type        = string
  default     = "cr-reviewer"
}

variable "requester_user" {
  description = "Teleport username of the change requester (you). Only used for suggested reviewers wiring and outputs; SSO users cannot have roles attached via Terraform."
  type        = string
  default     = "alex.hemard@goteleport.com"
}

variable "kube_cluster_name" {
  description = "Name the kind cluster registers under in Teleport (teleport-kube-agent kubeClusterName)."
  type        = string
  default     = "oncall"
}

variable "kube_labels" {
  description = "Teleport labels the kube agent registers with, and which the executor bot role is allowed to reach."
  type        = map(list(string))
  default     = { env = ["demo"] }
}

variable "kube_namespace" {
  description = "Kubernetes namespace the executor bot may act in."
  type        = string
  default     = "emailpals"
}

variable "kube_group" {
  description = "Kubernetes group the executor bot impersonates. Bind it to a ClusterRole in k8s/rbac.yaml."
  type        = string
  default     = "oncall-fix"
}

variable "kube_view_group" {
  description = "Kubernetes group for read-only access (investigator bot and the on-call operator). Bound to ClusterRole view in k8s/rbac.yaml."
  type        = string
  default     = "oncall-view"
}

variable "create_kube_join_token" {
  description = "Create a join token for the teleport-kube-agent Helm chart."
  type        = bool
  default     = true
}

variable "kube_join_token_ttl" {
  description = "Lifetime of the kube agent join token, as a Terraform duration (e.g. 24h)."
  type        = string
  default     = "24h"
}

variable "request_max_duration" {
  description = "Maximum access duration a change request may ask for."
  type        = string
  default     = "4h"
}
