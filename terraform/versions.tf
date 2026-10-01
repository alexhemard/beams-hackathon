terraform {
  required_version = ">= 1.5"

  required_providers {
    teleport = {
      source  = "terraform.releases.teleport.dev/gravitational/teleport"
      version = "~> 18.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Credentials come from the environment. Before running terraform, in the same shell:
#
#   tsh login --proxy=flat-pine.beams.sh:443 --user=alex.hemard@goteleport.com
#   eval "$(tctl terraform env)"
#
# `tctl terraform env` creates a short-lived bot with the `terraform-provider`
# role and exports TF_TELEPORT_ADDR / TF_TELEPORT_IDENTITY_FILE_BASE64, which the
# provider reads automatically. `addr` below is only a fallback.
provider "teleport" {
  addr = var.proxy_addr
}
