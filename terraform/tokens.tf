# Join token for the teleport-kube-agent Helm chart in the kind cluster.
#
# For provision tokens the metadata.name IS the join secret the agent presents,
# so a random string is generated here and exposed only as a sensitive output.
#
# Per-CR bot tokens (join_method bound_keypair, one-time registration secret)
# are deliberately NOT managed here: the `cr` CLI creates and deletes them per
# change request. See ../cli/perform.ts and teleport/token.yaml.tmpl.

resource "random_string" "kube_join_token" {
  count   = var.create_kube_join_token ? 1 : 0
  length  = 32
  special = false
}

resource "teleport_provision_token" "kube_agent" {
  count   = var.create_kube_join_token ? 1 : 0
  version = "v2"
  metadata = {
    name        = random_string.kube_join_token[0].result
    description = "Join token for the ${var.kube_cluster_name} kube agent (beams hackathon)."
    expires     = timeadd(plantimestamp(), var.kube_join_token_ttl)
    labels      = { "beams-hackathon" = "cr" }
  }
  spec = {
    roles       = ["Kube", "App"] # the kube agent also publishes emailpals-web as an app
    join_method = "token"
  }
  lifecycle {
    ignore_changes = [metadata.expires]
  }
}
