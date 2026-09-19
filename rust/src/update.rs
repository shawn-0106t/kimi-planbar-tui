// CLI version check, 1:1 port of UpdateService (SPEC section 17):
// local `kimi --version` (5s timeout, kill) -> docs changelog (Range 0-4095)
// -> GitHub Releases API fallback. All failures degrade silently.

use regex::Regex;
use reqwest::Client;
use serde::Serialize;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

const CHANGELOG_URL: &str = "https://moonshotai.github.io/kimi-code/en/release-notes/changelog.md";
const GITHUB_LATEST_URL: &str = "https://api.github.com/repos/MoonshotAI/kimi-code/releases/latest";

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub local_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub check_failed: bool,
}

fn http_client() -> Option<&'static Client> {
    static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| Client::builder().timeout(Duration::from_secs(10)).build().ok())
        .as_ref()
}

pub async fn check() -> UpdateStatus {
    let local = detect_local_version().await;
    let latest = fetch_latest_from_changelog().await;
    let latest = match latest {
        Some(v) => Some(v),
        None => fetch_latest_from_github().await,
    };
    let update_available = match (&latest, &local) {
        (Some(l), Some(c)) => match (parse_semver(l), parse_semver(c)) {
            (Some(lv), Some(cv)) => lv > cv,
            _ => false,
        },
        _ => false,
    };
    UpdateStatus {
        local_version: local,
        check_failed: latest.is_none(),
        latest_version: latest,
        update_available,
    }
}

/// x.y.z -> comparable tuple (semantic version compare, SPEC 17.3).
fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.split('.');
    let a = parts.next()?.parse().ok()?;
    let b = parts.next()?.parse().ok()?;
    let c = parts.next()?.parse().ok()?;
    Some((a, b, c))
}

/// `kimi --version`, 5000ms timeout then kill; first \d+\.\d+\.\d+ in stdout+stderr.
async fn detect_local_version() -> Option<String> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let child = tokio::process::Command::new("kimi")
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let out = tokio::time::timeout(Duration::from_millis(5000), child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    let re = Regex::new(r"\d+\.\d+\.\d+").ok()?;
    re.find(&text).map(|m| m.as_str().to_string())
}

/// Official docs changelog: Range bytes=0-4095, first `## x.y.z` heading wins.
/// (GitHub Pages may ignore Range and return 200 with the full body; both are fine.)
async fn fetch_latest_from_changelog() -> Option<String> {
    let client = http_client()?;
    let resp = client
        .get(CHANGELOG_URL)
        .header(reqwest::header::RANGE, "bytes=0-4095")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    let re = Regex::new(r"(?m)^## (\d+\.\d+\.\d+)").ok()?;
    re.captures(&text).map(|c| c[1].to_string())
}

/// GitHub Releases API fallback (User-Agent header is mandatory).
async fn fetch_latest_from_github() -> Option<String> {
    let client = http_client()?;
    let resp = client
        .get(GITHUB_LATEST_URL)
        .header(reqwest::header::USER_AGENT, "KimiPlanbarTui")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;
    let tag = v.get("tag_name")?.as_str()?;
    let re = Regex::new(r"\d+\.\d+\.\d+").ok()?;
    re.find(tag).map(|m| m.as_str().to_string())
}
