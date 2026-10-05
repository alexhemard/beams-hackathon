output "roles" {
  description = "Roles created for the change-request flow."
  value = {
    approval_carrier                = teleport_role.oncall_change.metadata.name
    requester_and_investigator_bot  = teleport_role.operator.metadata.name
    reviewer                        = teleport_role.webmaster.metadata.name
    executor_and_cluster_setup_bot  = teleport_role.administrator.metadata.name
  }
}

output "reviewer_user" {
  description = "Local user who approves CRs. Run `tctl users reset <name>` once to set a password."
  value       = teleport_user.webmaster_user.metadata.name
}

output "kube_join_token" {
  description = "Join token for the teleport-kube-agent chart. Pass as authToken."
  value       = var.create_kube_join_token ? teleport_provision_token.kube_agent[0].metadata.name : null
  sensitive   = true
}

output "helm_install" {
  description = "Command to enroll the EKS cluster. Fill the token from `terraform output -raw kube_join_token`. demo/kubeup.sh runs the fuller version of this (roles=kube,app + the emailpals-web app)."
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

output "eks_update_kubeconfig" {
  description = "Command to point kubectl at the EKS cluster, aliasing the context to eks-<cluster> (same shape as the old kind-<cluster> context demo/break.sh and demo/reset.sh expect)."
  value       = "aws eks update-kubeconfig --name ${var.kube_cluster_name} --region ${var.aws_region} --alias eks-${var.kube_cluster_name}"
}

output "eks_cluster_endpoint" {
  description = "EKS API server endpoint."
  value       = module.eks.cluster_endpoint
}

output "eks_cluster_name" {
  description = "Name of the EKS cluster, for scripts that need it (demo/kubeup.sh, demo/break.sh, demo/reset.sh)."
  value       = var.kube_cluster_name
}

output "aws_region" {
  description = "AWS region the EKS cluster was created in, for scripts that need it (demo/kubeup.sh)."
  value       = var.aws_region
}

output "bootstrap_kube_agent_cloudshell" {
  description = "Where to run terraform/bootstrap-kube-agent.sh (generated) from an AWS CloudShell VPC environment, so the kube agent install never touches the public internet."
  value       = <<-EOT
    Open AWS CloudShell > Actions > create VPC environment, with:
      VPC:             ${local.vpc_id}
      Subnet:          one of ${join(", ", local.subnet_ids)}
      Security group:  ${module.eks.node_security_group_id}
    Then upload/paste terraform/bootstrap-kube-agent.sh and run it there.
  EOT
}
