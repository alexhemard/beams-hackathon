output "roles" {
  description = "Roles created for the change-request flow."
  value = {
    approval_carrier = teleport_role.oncall_change.metadata.name
    requester        = teleport_role.cr_requester.metadata.name
    reviewer         = teleport_role.oncall_reviewer.metadata.name
    executor_bot     = teleport_role.cr_executor.metadata.name
    investigator_bot = teleport_role.cr_investigator.metadata.name
  }
}

output "reviewer_user" {
  description = "Local user who approves CRs. Run `tctl users reset <name>` once to set a password."
  value       = teleport_user.cr_reviewer.metadata.name
}

output "kube_join_token" {
  description = "Join token for the teleport-kube-agent chart. Pass as authToken."
  value       = var.create_kube_join_token ? teleport_provision_token.kube_agent[0].metadata.name : null
  sensitive   = true
}

output "helm_install" {
  description = "Command to enroll the kind cluster. Fill the token from `terraform output -raw kube_join_token`."
  value       = <<-EOT
    helm repo add teleport https://charts.releases.teleport.dev && helm repo update
    helm upgrade --install teleport-kube-agent teleport/teleport-kube-agent \
      --create-namespace --namespace teleport-agent \
      --set roles=kube \
      --set proxyAddr=${var.proxy_addr} \
      --set kubeClusterName=${var.kube_cluster_name} \
      --set authToken="$(terraform output -raw kube_join_token)" \
      ${join(" ", [for k, v in var.kube_labels : "--set labels.${k}=${v[0]}"])}
  EOT
}
