// Refresh scheduling, 1:1 port of QuotaService.SafeRefresh/Reschedule (SPEC 16.5):
// first refresh 2s after start, period = max(1, RefreshMinutes), failure keeps
// last-known-good data and retries fast after 30s.
//
// De-Tauri-fication: the tray edition emitted a "quota-updated" Tauri event and
// refreshed the tray tooltip; here the result is pushed to the UI over an
// mpsc channel instead. Scheduling semantics are unchanged.

use crate::quota::{self, QuotaResult};
use crate::state::AppState;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

pub async fn safe_refresh(state: &Arc<AppState>, tx: &mpsc::Sender<QuotaResult>) -> QuotaResult {
    let mut r = quota::fetch().await;
    if r.error.is_some() {
        let last = state.last_quota.read().unwrap().clone();
        if let Some(l) = &last {
            r.fill_missing_from(l);
        }
    }
    *state.last_quota.write().unwrap() = Some(r.clone());
    let _ = tx.send(r.clone()).await;
    // Every refresh (scheduled or manual) moves the next scheduled tick:
    // 30s after a failure, one period after a success (SPEC 16.5 step 3,
    // mirrors _timer.Change in QuotaService.SafeRefresh)
    let mins = state.settings.read().unwrap().refresh_minutes.max(1) as u64;
    let delay = if r.error.is_some() {
        Duration::from_secs(30)
    } else {
        Duration::from_secs(mins.saturating_mul(60))
    };
    *state.retime_delay.lock().unwrap() = Some(delay);
    state.retime.notify_one();
    r
}

/// Polling loop. `reschedule` notify restarts the cycle with the 2s first
/// delay (mirrors QuotaService.Reschedule's timer.Change(2s, period)).
pub async fn run(state: Arc<AppState>, tx: mpsc::Sender<QuotaResult>) {
    let mut next = Duration::from_secs(2);
    loop {
        let reschedule = state.reschedule.clone();
        let retime = state.retime.clone();
        tokio::select! {
            _ = tokio::time::sleep(next) => {}
            _ = reschedule.notified() => {
                // Drain any stale retime hint queued before this reschedule:
                // the notify permit survives `continue`, and a leftover delay
                // would otherwise overwrite the 2s first-refresh tick.
                let _ = state.retime_delay.lock().unwrap().take();
                next = Duration::from_secs(2);
                continue;
            }
            _ = retime.notified() => {
                let hint = state.retime_delay.lock().unwrap().take();
                if let Some(d) = hint {
                    next = d;
                }
                continue;
            }
        }
        let r = safe_refresh(&state, &tx).await;
        next = if r.error.is_some() {
            Duration::from_secs(30) // fast retry after failure
        } else {
            let mins = state.settings.read().unwrap().refresh_minutes.max(1) as u64;
            Duration::from_secs(mins.saturating_mul(60))
        };
    }
}
