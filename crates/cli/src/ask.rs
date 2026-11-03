//! Bounded server-side investigation. Never reads or uploads the local checkout.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use crate::{auth, cli::AskArgs, mcp};

fn arguments(args: &AskArgs) -> Result<Value> {
    if args.question.trim().is_empty() { bail!("--question must not be empty"); }
    if args.mode == "code-investigator" && !args.note_paths.is_empty() {
        bail!("--note-path is only valid for knowledge-investigator");
    }
    if args.mode == "knowledge-investigator" && (args.repo.is_some() || !args.paths.is_empty()) {
        bail!("knowledge-investigator accepts --note-path, not --repo or --path");
    }
    if args.mode == "code-investigator" && args.repo.as_deref().unwrap_or("").trim().is_empty() {
        bail!("--repo is required for code-investigator");
    }
    if args.mode == "knowledge-investigator" && args.note_paths.is_empty() {
        bail!("--note-path is required for knowledge-investigator");
    }
    let mut out = json!({"task": args.question, "mode": args.mode});
    if let Some(repo) = &args.repo { out["repo"] = json!(repo); }
    if !args.paths.is_empty() { out["paths"] = json!(args.paths); }
    if !args.note_paths.is_empty() { out["note_paths"] = json!(args.note_paths); }
    let mut budget = serde_json::Map::new();
    if let Some(calls) = args.max_tool_calls { budget.insert("maxToolCalls".into(), json!(calls)); }
    if let Some(seconds) = args.timeout_seconds { budget.insert("timeoutMs".into(), json!(u64::from(seconds) * 1000)); }
    if !budget.is_empty() { out["budget"] = Value::Object(budget); }
    Ok(out)
}

fn decode_result(result: &Value) -> Result<Value> {
    if let Some(structured) = result.get("structuredContent") {
        if structured.get("status").is_some() { return Ok(structured.clone()); }
    }
    let content = result.get("content").and_then(Value::as_array).context("worker_run returned no content")?;
    for block in content {
        if let Some(text) = block.get("text").and_then(Value::as_str) {
            if let Ok(value) = serde_json::from_str::<Value>(text) {
                if value.get("status").is_some() { return Ok(value); }
            }
        }
    }
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        // Do not echo arbitrary upstream error content (it may contain secrets).
        bail!("worker_run rejected the request; check worker configuration and permitted scope on the server");
    }
    bail!("worker_run returned no structured investigation result")
}

pub fn cmd_ask(args: AskArgs) -> Result<()> {
    let input = arguments(&args)?;
    let creds = auth::resolve_creds(None, None)?.context("No server credentials configured. Run cortexmd auth oauth-login first.")?;
    let server = creds.server.trim_end_matches('/').trim_end_matches("/mcp");
    let (session, _) = mcp::initialize(server, &creds.api_key)?;
    // Allow transport overhead beyond the requested server deadline, but never hang forever.
    let timeout = std::time::Duration::from_secs(u64::from(args.timeout_seconds.unwrap_or(90)) + 15);
    let raw = mcp::tools_call_with_timeout(server, &creds.api_key, &session, "worker_run", &input, Some(timeout))?;
    let result = decode_result(&raw)?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    match result.get("status").and_then(Value::as_str) {
        Some("complete") => Ok(()),
        Some("partial") => bail!("Investigation is partial; inspect coverage and limitations in the JSON result"),
        Some("cancelled") => bail!("Investigation was cancelled"),
        Some("failed") => bail!("Investigation failed; inspect the JSON result"),
        _ => bail!("Unknown investigation status"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use crate::cli::{Cli, Command};
    fn parse(args: &[&str]) -> AskArgs {
        match Cli::try_parse_from(args).unwrap().command.unwrap() {
            Command::Ask(args) => args, _ => panic!("expected ask"),
        }
    }
    #[test]
    fn scopes_and_budgets_survive_cli_serialization() {
        let args = parse(&["cortexmd", "ask", "--question", "trace errors", "--repo", "demo", "--path", "src", "--path", "tests", "--max-tool-calls", "4", "--timeout-seconds", "30"]);
        assert_eq!(arguments(&args).unwrap(), json!({"task":"trace errors","mode":"code-investigator","repo":"demo","paths":["src","tests"],"budget":{"maxToolCalls":4,"timeoutMs":30000}}));
    }
    #[test]
    fn knowledge_needs_explicit_scope_and_code_needs_repo() {
        assert!(arguments(&parse(&["cortexmd", "ask", "--question", "why?"])).is_err());
        assert!(arguments(&parse(&["cortexmd", "ask", "--question", "why?", "--mode", "knowledge-investigator"])).is_err());
        assert!(arguments(&parse(&["cortexmd", "ask", "--question", "why?", "--mode", "knowledge-investigator", "--note-path", "Projects/demo"])).is_ok());
        assert!(arguments(&parse(&["cortexmd", "ask", "--question", "why?", "--repo", "demo", "--note-path", "Projects/demo"])).is_err());
        assert!(arguments(&parse(&["cortexmd", "ask", "--question", "why?", "--mode", "knowledge-investigator", "--repo", "demo", "--note-path", "Projects/demo"])).is_err());
    }
    #[test]
    fn rejects_invalid_limits() {
        assert!(Cli::try_parse_from(["cortexmd", "ask", "--question", "q", "--max-tool-calls", "0"]).is_err());
    }
    #[test]
    fn parses_result_without_hiding_partial_status() {
        let value = json!({"status":"partial","answer":"Some evidence"});
        assert_eq!(decode_result(&json!({"content":[{"type":"text","text":value.to_string()}]})).unwrap(), value);
        assert!(decode_result(&json!({"isError":true,"content":[{"text":"secret"}]})).unwrap_err().to_string().find("secret").is_none());
        assert!(decode_result(&json!({"content":[]})).is_err());
    }
}
