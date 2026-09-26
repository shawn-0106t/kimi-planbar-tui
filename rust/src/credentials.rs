// Credential chain, 1:1 port of QuotaService.LoadToken (SPEC 16.2):
// 1) <kimi_home>/credentials/kimi-code.json -> access_token (expires_at > now+30s)
// 2) <kimi_home>/config.toml -> provider whose base_url contains api.kimi.com/coding
// 3) None -> caller reports "no-token"
// <kimi_home> honors the KIMI_CODE_HOME override (see kimi_home below).

use regex::Regex;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn home_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("USERPROFILE") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    // Fallback: HOMEDRIVE + HOMEPATH
    if let (Ok(d), Ok(p)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        return Some(PathBuf::from(format!("{d}{p}")));
    }
    None
}

/// JSON number-or-string -> f64 (server models numbers as strings).
fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// ~/.kimi-code, honoring the KIMI_CODE_HOME override (SPEC 16.2 / 21.2).
pub(crate) fn kimi_home(home: &Path) -> PathBuf {
    if let Ok(p) = std::env::var("KIMI_CODE_HOME") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    home.join(".kimi-code")
}

pub fn load_token() -> Option<String> {
    let home = home_dir()?;
    let kimi = kimi_home(&home);

    // 1) OAuth access token from the credentials store
    let cred = kimi.join("credentials").join("kimi-code.json");
    if let Ok(text) = fs::read_to_string(&cred) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(at) = v.get("access_token").and_then(|x| x.as_str()) {
                let exp = v.get("expires_at").and_then(as_f64).unwrap_or(0.0);
                let now = chrono::Utc::now().timestamp() as f64;
                if exp > now + 30.0 {
                    return Some(at.to_string());
                }
            }
        }
    }

    // 2) config.toml fallback: line-by-line parse (not a full TOML parser)
    let cfg_path = kimi.join("config.toml");
    let text = fs::read_to_string(&cfg_path).ok()?;
    parse_config_provider(&text)
}

/// config.toml ladder, split out for unit tests (pure text -> api_key).
fn parse_config_provider(text: &str) -> Option<String> {
    let kv = Regex::new(r#"^(base_url|api_key)\s*=\s*"([^"]*)""#).ok()?;
    let mut section: Option<String> = None;
    let mut base_url: Option<String> = None;
    let mut api_key: Option<String> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            // Settle the previous section before starting a new one
            if let Some(found) = match_provider(section.as_deref(), base_url.as_deref(), api_key.as_deref()) {
                return Some(found);
            }
            // REVIEW-RUST Suggestion 7: strip the brackets, then trim — the
            // real CLI writes "[providers.x]" compact, but "[ providers.x ]"
            // used to leave padding in the section name and miss the match.
            section = Some(
                line.trim_matches(|c| c == '[' || c == ']')
                    .trim()
                    .to_string(),
            );
            base_url = None;
            api_key = None;
            continue;
        }
        if let Some(m) = kv.captures(line) {
            if &m[1] == "base_url" {
                base_url = Some(m[2].to_string());
            } else {
                api_key = Some(m[2].to_string());
            }
        }
    }
    match_provider(section.as_deref(), base_url.as_deref(), api_key.as_deref())
}

fn match_provider(section: Option<&str>, base_url: Option<&str>, api_key: Option<&str>) -> Option<String> {
    match (section, base_url, api_key) {
        (Some(s), Some(b), Some(k))
            if s.starts_with("providers.") && b.contains("api.kimi.com/coding") && !k.is_empty() =>
        {
            Some(k.to_string())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// REVIEW-RUST Suggestion 7 regression: compact (real CLI shape) and
    /// bracket-padded section names must both match.
    #[test]
    fn config_toml_compact_and_padded_sections() {
        let compact = "[providers.kimi]\nbase_url = \"https://api.kimi.com/coding/v1\"\napi_key = \"key-1\"\n";
        assert_eq!(parse_config_provider(compact), Some("key-1".to_string()));

        let padded = "[ providers.kimi ]\nbase_url = \"https://api.kimi.com/coding/v1\"\napi_key = \"key-2\"\n";
        assert_eq!(parse_config_provider(padded), Some("key-2".to_string()));
    }

    /// Section settlement: a non-matching section must not leak into the
    /// next one; an empty api_key is rejected (SPEC 16.2).
    #[test]
    fn config_toml_section_settlement() {
        let first_match_wins = "[providers.kimi]\nbase_url = \"https://api.kimi.com/coding/v1\"\napi_key = \"key-3\"\n\
            [providers.other]\nbase_url = \"https://api.kimi.com/coding/v1\"\napi_key = \"later\"\n";
        assert_eq!(parse_config_provider(first_match_wins), Some("key-3".to_string()));

        let skips_unrelated = "[providers.other]\nbase_url = \"https://example.com/v1\"\napi_key = \"ignored\"\n\
            [providers.kimi]\nbase_url = \"https://api.kimi.com/coding/v1\"\napi_key = \"key-4\"\n";
        assert_eq!(parse_config_provider(skips_unrelated), Some("key-4".to_string()));

        let empty_key = "[providers.kimi]\nbase_url = \"https://api.kimi.com/coding/v1\"\napi_key = \"\"\n";
        assert_eq!(parse_config_provider(empty_key), None);

        assert_eq!(parse_config_provider("not toml at all"), None);
    }
}
