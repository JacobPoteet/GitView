//! Whether a commit carries a signature, and of what kind.
//!
//! This is presence, not verification. Verifying means `gpg`, `ssh-keygen` and
//! an allowed-signers file, which git already knows how to drive and libgit2
//! does not, and driving it from here was measured at 2.3 s for the 80 commits
//! a branch graph holds on 13 Sep 2026, on a machine where every answer was
//! `E` because no allowed-signers file was configured. Presence is one header
//! read on a commit already in hand, and `git verify-commit` is a line away
//! for the commit somebody actually wants to check.

use git2::{Oid, Repository};

/// `ssh`, `gpg` or `x509`, from the armour header of the signature block, or
/// `other` for a block with a header this does not know. None when the commit
/// has no `gpgsig` header at all.
pub fn kind(repo: &Repository, oid: Oid) -> Option<String> {
    let (signature, _) = repo.extract_signature(&oid, None).ok()?;
    let text = std::str::from_utf8(&signature).unwrap_or("");
    Some(kind_of(text).to_string())
}

fn kind_of(signature: &str) -> &'static str {
    let head = signature.trim_start();
    if head.starts_with("-----BEGIN SSH SIGNATURE-----") {
        "ssh"
    } else if head.starts_with("-----BEGIN PGP SIGNATURE-----")
        || head.starts_with("-----BEGIN PGP MESSAGE-----")
    {
        "gpg"
    } else if head.starts_with("-----BEGIN SIGNED MESSAGE-----")
        || head.starts_with("-----BEGIN CMS-----")
    {
        // gpgsm writes S/MIME signatures as CMS, under either header
        // depending on its version.
        "x509"
    } else {
        "other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_armour_header_names_the_kind() {
        assert_eq!(kind_of("-----BEGIN SSH SIGNATURE-----\nU1NIU0lH"), "ssh");
        assert_eq!(kind_of("-----BEGIN PGP SIGNATURE-----\n\niQIz"), "gpg");
        assert_eq!(kind_of("-----BEGIN SIGNED MESSAGE-----\nMIAG"), "x509");
        assert_eq!(kind_of("garbage"), "other");
    }

    /// A commit made without `-S` has no header, and the answer is None
    /// rather than an error the caller has to tell apart from a missing
    /// commit.
    #[test]
    fn an_unsigned_commit_has_no_kind() {
        let dir = std::env::temp_dir().join(format!("gitview-signing-{}", std::process::id()));
        {
            let repo = Repository::init(&dir).unwrap();
            let sig = git2::Signature::now("t", "t@example").unwrap();
            let tree_id = repo.index().unwrap().write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let oid = repo
                .commit(Some("HEAD"), &sig, &sig, "one", &tree, &[])
                .unwrap();
            assert_eq!(kind(&repo, oid), None);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
