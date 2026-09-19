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
            section = Some(line.trim_matches(|c| c == '[' || c == ']').to_string());
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
