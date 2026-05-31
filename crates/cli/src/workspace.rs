//! npm workspace expansion. Mirrors `bin/code-index.mjs:111-154`.
//! Reads root package.json, expands workspace globs, collects each
//! workspace package's name + relative path.

use crate::payload::{PackageWorkspaces, WorkspacePackage};
use serde_json::Value;
use std::fs;
use std::path::Path;

pub fn collect_workspaces(repo_abs: &Path) -> PackageWorkspaces {
    let mut ws = PackageWorkspaces::default();
    let pkg_json_path = repo_abs.join("package.json");
    let Ok(pkg_text) = fs::read_to_string(&pkg_json_path) else {
        return ws;
    };
    let Ok(pkg): Result<Value, _> = serde_json::from_str(&pkg_text) else {
        return ws;
    };

    if let Some(name) = pkg.get("name").and_then(|v| v.as_str()) {
        if !name.is_empty() {
            ws.name = Some(name.to_string());
        }
    }

    let workspaces_raw: Vec<String> = match pkg.get("workspaces") {
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        Some(Value::Object(o)) => match o.get("packages") {
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
            _ => vec![],
        },
        _ => vec![],
    };

    if workspaces_raw.is_empty() {
        return ws;
    }
    ws.workspaces = Some(workspaces_raw.clone());

    let mut wp = Vec::<WorkspacePackage>::new();
    for pat in &workspaces_raw {
        let glob_pat = repo_abs.join(pat).to_string_lossy().replace('\\', "/");
        let entries = match glob::glob(&glob_pat) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let ws_pkg_path = entry.join("package.json");
            if !ws_pkg_path.exists() {
                continue;
            }
            let Ok(ws_pkg_text) = fs::read_to_string(&ws_pkg_path) else {
                continue;
            };
            let Ok(ws_pkg): Result<Value, _> = serde_json::from_str(&ws_pkg_text) else {
                continue;
            };
            let Some(ws_name) = ws_pkg.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            // Compute relative POSIX path.
            let Ok(rel) = entry.strip_prefix(repo_abs) else {
                continue;
            };
            let rel_posix = rel
                .to_string_lossy()
                .replace('\\', "/");
            wp.push(WorkspacePackage {
                name: ws_name.to_string(),
                relative_path: rel_posix,
            });
        }
    }
    if !wp.is_empty() {
        ws.workspace_packages = Some(wp);
    }
    ws
}
