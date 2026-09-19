// Shared application state. Ported from the tray edition's AppState with the
// window/tray-only fields removed (last_hide, last_hover, panel_hiding,
// settings_open, skills_open, menu_height) — the TUI has no focus-loss
// auto-hide and no tray hover.

use crate::quota::QuotaResult;
use crate::settings::SettingsData;
use crate::skills::SkillInfo;
use crate::update::UpdateStatus;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

pub struct AppState {
    pub settings: RwLock<SettingsData>,
    pub last_quota: RwLock<Option<QuotaResult>>,
    pub update: RwLock<UpdateStatus>,
    /// Effective theme after resolving "system": "light" | "dark"
    pub effective_theme: RwLock<String>,
    /// Timestamp of the last manual refresh (2s debounce, SPEC 12.7)
    pub last_manual_refresh: Mutex<Option<Instant>>,
    /// Lazy one-shot cache for the skills view (no background scanning, SPEC 21.2)
    pub skills_cache: RwLock<Option<Vec<SkillInfo>>>,
    /// Fired when the polling schedule must restart (settings saved)
    pub reschedule: Arc<Notify>,
    /// Fired by every safe_refresh (manual or scheduled) to move the next
    /// scheduled tick to now+delay — mirrors QuotaService's per-call
    /// _timer.Change(error ? 30s : period, period) (SPEC 16.5 step 3)
    pub retime: Arc<Notify>,
    pub retime_delay: Mutex<Option<Duration>>,
}

impl AppState {
    pub fn new(settings: SettingsData, effective_theme: String) -> Self {
        AppState {
            settings: RwLock::new(settings),
            last_quota: RwLock::new(None),
            update: RwLock::new(UpdateStatus::default()),
            effective_theme: RwLock::new(effective_theme),
            last_manual_refresh: Mutex::new(None),
            skills_cache: RwLock::new(None),
            reschedule: Arc::new(Notify::new()),
            retime: Arc::new(Notify::new()),
            retime_delay: Mutex::new(None),
        }
    }
}
