# Generates terraform/bootstrap-kube-agent.sh: the one-time, manual bootstrap step
# that installs teleport-kube-agent (+ k8s/rbac.yaml) before Teleport has anything
# to proxy. Run from AWS CloudShell launched in this VPC (see terraform/README.md) —
# no public endpoint exposure, no bastion EC2 instance, no CodeBuild/vpc_config (which
# needs ec2:DescribeSecurityGroups on whoever runs `terraform apply`, not just the
# resources Terraform creates — a permission not every account grants).
locals {
  # Same shape as the `helm_install` output: one --set per kube_labels entry.
  kube_label_set_flags = join(" ", [for k, v in var.kube_labels : "--set labels.${k}=${v[0]}"])
}

resource "local_file" "bootstrap_kube_agent_script" {
  filename        = "${path.module}/bootstrap-kube-agent.sh"
  file_permission = "0700"
  content = templatefile("${path.module}/templates/bootstrap-kube-agent.sh.tftpl", {
    cluster           = var.kube_cluster_name
    region            = var.aws_region
    proxy             = var.proxy_addr
    token             = teleport_provision_token.kube_agent[0].metadata.name
    namespace         = var.kube_namespace
    label_flags       = local.kube_label_set_flags
    rbac_yaml         = file("${path.module}/../k8s/rbac.yaml")
    vpc_id            = local.vpc_id
    subnet_ids        = join(", ", local.subnet_ids)
    security_group_id = module.eks.node_security_group_id
  })
}
