//! Local hook-latency stats for `cortexmd status`.
//!
//! Every Node hook appends one JSON line on exit to
//! `<stateRoot>/hook-latency.jsonl` (see `recordLatency` in
//! `hooks/_mcp_rest.mjs`): `{t, hook, ms, cli_ms, cli_calls}` where `ms` is
//! the whole process lifetime (Node boot + git + `cortexmd` spawns + HTTPS)
//! and `cli_ms` the part spent waiting on `cortexmd` subprocesses. The file is
//! a ring: the writer trims it to the last ~1000 lines.
//!
//! `stateRoot` mirrors `_mcp_rest.mjs`: `$CLAUDE_PLUGIN_DATA` →
//! `$XDG_STATE_HOME/cortexmd` → `~/.local/state/cortexmd`. Hooks run by the
//! Claude Code *plugin* write under `CLAUDE_PLUGIN_DATA`, which is unset in a
//! terminal; those stats are only visible when that env var is exported.

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const LATENCY_FILE: &str = "hook-latency.jsonl";
/// Samples per hook used for the percentiles (most recent).
const WINDOW: usize = 500;

pub fn state_root() -> Option<PathBuf> {
    let env = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if let Some(p) = env("CLAUDE_PLUGIN_DATA") {
        return Some(PathBuf::from(p));
    }
    if let Some(x) = env("XDG_STATE_HOME") {
        return Some(PathBuf::from(x).join("cortexmd"));
    }
    dirs::home_dir().map(|h| h.join(".local").join("state").join("cortexmd"))
}

#[derive(Debug, Clone, PartialEq)]
pub struct HookLatency {
    pub hook: String,
    pub n: usize,
    pub p50: u64,
    pub p95: u64,
    pub cli_p95: u64,
    pub max: u64,
}

/// Nearest-rank percentile of an ascending slice.
fn percentile(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

/// Aggregate JSONL text into per-hook stats (sorted by p95, slowest first).
pub fn summarize(text: &str) -> Vec<HookLatency> {
    let mut by_hook: BTreeMap<String, Vec<(u64, u64)>> = BTreeMap::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(hook) = v.get("hook").and_then(|h| h.as_str()) else { continue };
        let Some(ms) = v.get("ms").and_then(|m| m.as_f64()) else { continue };
        let cli = v.get("cli_ms").and_then(|m| m.as_f64()).unwrap_or(0.0);
        by_hook
            .entry(hook.to_string())
            .or_default()
            .push((ms.max(0.0).round() as u64, cli.max(0.0).round() as u64));
    }
    let mut out: Vec<HookLatency> = by_hook
        .into_iter()
        .map(|(hook, samples)| {
            let recent = &samples[samples.len().saturating_sub(WINDOW)..];
            let mut ms: Vec<u64> = recent.iter().map(|s| s.0).collect();
            let mut cli: Vec<u64> = recent.iter().map(|s| s.1).collect();
            ms.sort_unstable();
            cli.sort_unstable();
            HookLatency {
                hook,
                n: ms.len(),
                p50: percentile(&ms, 50.0),
                p95: percentile(&ms, 95.0),
                cli_p95: percentile(&cli, 95.0),
                max: *ms.last().unwrap_or(&0),
            }
        })
        .collect();
    out.sort_by(|a, b| b.p95.cmp(&a.p95).then(a.hook.cmp(&b.hook)));
    out
}

pub fn render(stats: &[HookLatency], path: &Path) -> String {
    let mut s = format!("Hook latency (local, last ≤{} runs/hook — {})\n", WINDOW, path.display());
    if stats.is_empty() {
        s.push_str("  no samples yet (hooks record on every run once `cortexmd init` installed them)\n");
        return s;
    }
    s.push_str(&format!(
        "  {:<28} {:>5} {:>7} {:>7} {:>9} {:>7}\n",
        "hook", "n", "p50", "p95", "cli p95", "max"
    ));
    for h in stats {
        s.push_str(&format!(
            "  {:<28} {:>5} {:>5}ms {:>5}ms {:>7}ms {:>5}ms\n",
            h.hook, h.n, h.p50, h.p95, h.cli_p95, h.max
        ));
    }
    s
}

/// The block printed by `cortexmd status` (never fails).
pub fn status_block() -> String {
    let Some(root) = state_root() else {
        return String::new();
    };
    let path = root.join(LATENCY_FILE);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    render(&summarize(&text), &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_per_hook() {
        let mut text = String::new();
        for i in 1..=100u64 {
            text.push_str(&format!("{{\"hook\":\"userprompt_hook\",\"ms\":{},\"cli_ms\":{}}}\n", i, i / 2));
        }
        text.push_str("{\"hook\":\"wakeup_directive_hook\",\"ms\":900}\n");
        text.push_str("garbage\n{\"ms\":5}\n");
        let s = summarize(&text);
        assert_eq!(s.len(), 2);
        let up = s.iter().find(|h| h.hook == "userprompt_hook").unwrap();
        assert_eq!((up.n, up.p50, up.p95, up.max), (100, 50, 95, 100));
        assert_eq!(up.cli_p95, 47);
        assert_eq!(s[0].hook, "wakeup_directive_hook", "slowest p95 first");
        let out = render(&s, Path::new("x.jsonl"));
        assert!(out.contains("userprompt_hook"));
        assert!(out.contains("p95"));
    }

    #[test]
    fn window_keeps_most_recent_samples() {
        let mut text = String::new();
        for _ in 0..600 {
            text.push_str("{\"hook\":\"h\",\"ms\":1000}\n");
        }
        for _ in 0..WINDOW {
            text.push_str("{\"hook\":\"h\",\"ms\":10}\n");
        }
        let s = summarize(&text);
        assert_eq!(s[0].n, WINDOW);
        assert_eq!(s[0].p95, 10);
    }

    #[test]
    fn empty_input_renders_hint() {
        assert!(render(&summarize(""), Path::new("x")).contains("no samples yet"));
    }
}
