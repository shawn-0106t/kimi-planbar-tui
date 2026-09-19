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

pub fn save(data: &SettingsData) {
    let dir = config_dir();
    let _ = fs::create_dir_all(&dir);
    if let Ok(json) = serde_json::to_string_pretty(data) {
        let _ = fs::write(file_path(), json);
    }
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
