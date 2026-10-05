# EKS cluster the teleport-kube-agent enrolls, replacing the local `kind`
# cluster. Credentials come from the environment (AWS_PROFILE / AWS_ACCESS_KEY_ID
# etc, same "bring your own creds" convention as the Teleport provider in
# versions.tf) — nothing here is a Terraform-managed Teleport credential.
#
# `terraform apply` on this file provisions real AWS infrastructure that
# costs money. Review `var.node_instance_types` / sizes before applying.

provider "aws" {
  region = var.aws_region

  # Applies to every taggable resource this provider creates (VPC, subnets,
  # NAT gateway, EKS cluster, node group, EC2 instances, ...), including those
  # created inside the vpc/eks modules below — no need to thread it through
  # each module call individually.
  default_tags {
    tags = {
      "teleport.dev/creator" = var.teleport_creator
    }
  }
}

data "aws_availability_zones" "available" {
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

# Skipped entirely when var.vpc_id is set (reusing an existing VPC — e.g. because the account is
# already at its VpcLimitExceeded quota in this region). count, not a conditional default, so
# `terraform plan` never even attempts a CreateVpc call in that case.
module "vpc" {
  count   = var.vpc_id == null ? 1 : 0
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.kube_cluster_name}-vpc"
  cidr = var.vpc_cidr

  azs             = slice(data.aws_availability_zones.available.names, 0, 2)
  public_subnets  = [cidrsubnet(var.vpc_cidr, 4, 0), cidrsubnet(var.vpc_cidr, 4, 1)]
  private_subnets = [cidrsubnet(var.vpc_cidr, 4, 2), cidrsubnet(var.vpc_cidr, 4, 3)]

  enable_nat_gateway = true
  single_nat_gateway = true # one NAT for a demo cluster, not HA

  # Required for the EKS load-balancer / VPC-CNI controllers to discover subnets.
  public_subnet_tags = {
    "kubernetes.io/role/elb" = "1"
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
  }

}

locals {
  vpc_id     = var.vpc_id != null ? var.vpc_id : module.vpc[0].vpc_id
  subnet_ids = var.vpc_id != null ? var.private_subnet_ids : module.vpc[0].private_subnets
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = var.kube_cluster_name
  cluster_version = var.eks_kubernetes_version

  vpc_id     = local.vpc_id
  subnet_ids = local.subnet_ids

  # Private by default: once teleport-kube-agent is running, it dials OUT from inside
  # the VPC to the Teleport proxy, so `tsh kube login` + kubectl never touch this
  # endpoint at all — Teleport is the bastion for all ongoing access. The one gap is
  # bootstrap: nothing exists yet to proxy through, so installing the agent itself
  # (terraform/bootstrap-kube-agent.sh, generated below) needs network access to this
  # endpoint — run that from AWS CloudShell launched in this VPC (see
  # terraform/README.md) to keep this false, or flip it true for that one run.
  cluster_endpoint_public_access  = var.cluster_endpoint_public_access
  cluster_endpoint_private_access = true

  enable_cluster_creator_admin_permissions = true

  # provider default_tags (above) only covers resources Terraform itself creates —
  # it does NOT reach EC2 instances an Auto Scaling Group launches on its own via the
  # node group's launch template. This account's org policy denies RunInstances when
  # teleport.dev/creator is missing, so it has to be set explicitly here too, propagated
  # into the launch template's instance tag_specifications.
  tags = {
    "teleport.dev/creator" = var.teleport_creator
  }

  eks_managed_node_groups = {
    default = {
      instance_types = var.node_instance_types
      min_size       = var.node_min_size
      max_size       = var.node_max_size
      desired_size   = var.node_desired_size
      tags = {
        "teleport.dev/creator" = var.teleport_creator
      }
    }
  }

}

# Explicit: the kube agent (running on the nodes, in the private subnets)
# needs outbound 443 to reach `var.proxy_addr` to join and stay connected to
# the Teleport Beams tenant. The NAT gateway above provides the route; this
# rule is the "Teleport access to required endpoints" piece, stated rather
# than left to the node security group's implicit default.
resource "aws_security_group_rule" "node_to_teleport_proxy" {
  description       = "Node group egress to the Teleport proxy (teleport-kube-agent join + heartbeat)."
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = module.eks.node_security_group_id
}

# The module's default node security group only opens the well-known webhook ports
# (443, 4443, 6443, 8443, 9443) and kubelet (10250) from the cluster's additional
# security group -- enough for `kubectl logs`/`exec` (kubelet) but not for the API
# server's service-proxy subresource (`kubectl get --raw .../services/.../proxy/...`),
# which dials the pod's own port directly. shared/alerts.ts reads Alertmanager that
# way, so it needs 9093 (API) and 9094 (cluster gossip) opened explicitly too.
resource "aws_security_group_rule" "cluster_to_node_alertmanager_proxy" {
  description              = "Cluster API to node: service-proxy access to Alertmanager (9093 API, 9094 cluster gossip)."
  type                     = "ingress"
  from_port                = 9093
  to_port                  = 9094
  protocol                 = "tcp"
  source_security_group_id = module.eks.cluster_security_group_id
  security_group_id        = module.eks.node_security_group_id
}
