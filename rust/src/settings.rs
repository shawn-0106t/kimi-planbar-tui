// Settings persistence + autostart, 1:1 port of SettingsService (SPEC section 18).
// TUI edition renames: app-data dir KimiPlanbarTray -> KimiPlanbarTui, HKCU Run
// value KimiPlanbarTray -> KimiPlanbarTui.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
#[serde(default)] // tolerate a partial settings.json: missing fields take defaults
pub struct SettingsData {
    pub theme: String, // system | light | dark
    pub refresh_minutes: i64, // 1 | 5 | 10 | 30
    pub auto_start: bool,
}

impl Default for SettingsData {
    fn default() -> Self {
        SettingsData {
            theme: "system".to_string(),
            refresh_minutes: 5,
            auto_start: false,
        }
    }
}

/// Portable mode: a `portable.dat` next to the exe pins the config dir to the
/// exe directory; otherwise %APPDATA%\KimiPlanbarTui (SPEC 18.1).
pub fn config_dir() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    if let Some(dir) = &exe_dir {
        if dir.join("portable.dat").exists() {
            return dir.clone();
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.is_empty() {
            return PathBuf::from(appdata).join("KimiPlanbarTui");
        }
    }
    exe_dir.unwrap_or_else(|| PathBuf::from("."))
}

fn file_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> SettingsData {
    let Ok(text) = fs::read_to_string(file_path()) else {
        return SettingsData::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// Write settings.json and report success. REVIEW-RUST Minor 2: the write is
/// atomic-ish — temp file in the same directory, then rename over the target —
/// so a crash mid-write can never leave a truncated settings.json behind (a
/// truncated file would silently fall back to all defaults on next load).
pub fn save(data: &SettingsData) -> bool {
    let dir = config_dir();
    let _ = fs::create_dir_all(&dir);
    let Ok(json) = serde_json::to_string_pretty(data) else {
        return false;
    };
    let tmp = dir.join(format!("settings.json.{}.tmp", std::process::id()));
    if fs::write(&tmp, &json).is_err() {
        let _ = fs::remove_file(&tmp); // drop a half-written temp, symmetric with the rename-failure path (REVIEW-RUST Suggestion 13)
        return false;
    }
    if fs::rename(&tmp, file_path()).is_err() {
        let _ = fs::remove_file(&tmp); // best-effort cleanup, keep the dir tidy
        return false;
    }
    true
}

/// HKCU Run key autostart (per-user, no UAC). All errors silently swallowed.
pub fn apply_auto_start(data: &SettingsData) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey_with_flags(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
        winreg::enums::KEY_SET_VALUE,
    ) else {
        return;
    };
    if data.auto_start {
        if let Ok(exe) = std::env::current_exe() {
            let value = format!("\"{}\"", exe.to_string_lossy());
            let _ = key.set_value("KimiPlanbarTui", &value);
        }
    } else {
        let _ = key.delete_value("KimiPlanbarTui");
    }
}

/// Startup reconciliation (REVIEW-RUST Minor 2): settings.json is the source
/// of truth, the HKCU Run value the executed contract. A legacy non-atomic
/// write (or a manual registry edit) could leave the two diverged — e.g. the
/// value stuck on `true` while settings.json fell back to AutoStart=false, so
/// the machine kept autostarting an app whose settings screen said off. Heal
/// both directions, without repointing an existing value (a stale exe path
/// self-corrects on the next explicit save; repointing at every launch would
/// let a dev build fight the installed one over the value):
/// - AutoStart=false but a Run value exists -> delete it (apply_auto_start)
/// - AutoStart=true but the Run value is missing -> write it (apply_auto_start)
/// All errors silently swallowed (code-style baseline).
pub fn reconcile_auto_start(data: &SettingsData) {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE};
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey_with_flags(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
        KEY_QUERY_VALUE | KEY_SET_VALUE,
    ) else {
        return;
    };
    // Existence check by value NAME, not type: get_value::<String> would
    // report a manually written REG_DWORD as "missing" and skip the delete
    // (code-review note on reconcile asymmetry).
    let existing = key.get_raw_value("KimiPlanbarTui").is_ok();
    let needs_apply = match (data.auto_start, existing) {
        // AutoStart=true but the value is missing -> write it
        (true, false) => true,
        // AutoStart=false but the value exists -> delete it
        (false, true) => true,
        // In sync; AutoStart=true with an existing value is deliberately left
        // alone (no repointing at every launch, see above)
        _ => false,
    };
    if needs_apply {
        apply_auto_start(data);
    }
}
