# The reviewer is a local user. Terraform creates the user record; it cannot set a
# password. After `terraform apply`, run once:
#
#   tctl users reset cr-reviewer
#
# and complete the invite link (password + MFA). Then log in as that user in a
# separate profile to approve requests:
#
#   TELEPORT_HOME=~/.tsh-reviewer tsh login --proxy=flat-pine.beams.sh:443 --user=cr-reviewer
#   TELEPORT_HOME=~/.tsh-reviewer tsh request review --approve <request-id>
#
# The requester (you) is an SSO user; attach `cr-requester` to your user out of
# band (Web UI > Users, or your SSO connector's role mapping). Your existing
# `editor` and `beam-user` roles are still required for `cr perform`.

resource "teleport_user" "cr_reviewer" {
  version = "v2"
  depends_on = [
    teleport_role.oncall_reviewer,
  ]
  metadata = {
    name        = var.reviewer_user
    description = "Approves change requests for the beams hackathon demo."
    labels      = { "beams-hackathon" = "cr" }
  }
  spec = {
    roles = [teleport_role.oncall_reviewer.metadata.name]
  }
}
