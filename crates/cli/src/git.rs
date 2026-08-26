//! Git probes. Mirrors `src/lib/code-nav/repos.ts:firstCommitSha` and
//! `gitOrigin` (lines 51–67).
use anyhow::{Context, Result};
use std::path::Path;
use std::process::Command;

fn run_git(cwd: &Path, args: &[&str]) -> Result<String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        // The hud-line daemon runs detached (no console), so a console child
        // like git.exe would otherwise spawn a visible terminal window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .with_context(|| format!("failed to invoke git {:?}", args))?;
    if !out.status.success() {
        anyhow::bail!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// First commit SHA on HEAD. `git rev-list --max-parents=0 HEAD` may emit
/// multiple lines for grafted/octopus history — take the first.
pub fn first_commit_sha(repo_abs: &Path) -> Result<String> {
    let out = run_git(repo_abs, &["rev-list", "--max-parents=0", "HEAD"])?;
    let first = out
        .lines()
        .map(|s| s.trim())
        .find(|s| !s.is_empty())
        .context("repo has no commits")?;
    Ok(first.to_string())
}

/// Origin URL or None if unset.
pub fn git_origin(repo_abs: &Path) -> Option<String> {
    let out = run_git(repo_abs, &["config", "--get", "remote.origin.url"]).ok()?;
    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
