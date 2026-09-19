// TUI bootstrap + event loop (plan section 5):
//
// tokio::select! over
//   - crossterm EventStream (keyboard / resize) -> App state machine -> redraw
//   - polling mpsc (quota results / failures)   -> state + redraw
//   - update mpsc (version check result)        -> version row badge
//   - skills mpsc (background scan result)      -> skills view
//   - theme tick (30s registry poll, SPEC 20)   -> palette swap in system mode
//   - draw tick (250ms)                         -> idle heartbeat only; every
//     event redraws immediately, countdown text is recomputed on every redraw
//     (SPEC 12.3: input is reset_at - now)
//
// Terminal discipline (SPEC 20): raw mode + alternate screen on entry, restored
// on every exit path including panic (panic hook).

use crate::polling;
use crate::quota::QuotaResult;
use crate::settings::{self, SettingsData};
use crate::skills::{self, SkillInfo};
use crate::state::AppState;
use crate::theme;
use crate::ui;
use crate::update::{self, UpdateStatus};
use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use futures_util::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::io;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// SPEC 12.7: Console button URL.
pub const CONSOLE_URL: &str = "https://www.kimi.com/code/console?from=kfc_overview_topbar";
/// SPEC 12.6: version row click target.
pub const RELEASES_URL: &str = "https://github.com/MoonshotAI/kimi-code/releases";

/// Idle redraw heartbeat (SPEC 20): wakes the loop when no events arrive so
/// countdown text stays fresh; not a throttle — events redraw immediately.
const DRAW_HEARTBEAT: Duration = Duration::from_millis(250);
/// Minimal window size (character cells) applied on fresh-window launch
/// (SPEC 20). Sized to the wireframe layout: 9 content rows + footer
/// (+ flexible spacer); the footer hint line is ~66 cells wide.
const MIN_WIN_COLS: i16 = 72;
const MIN_WIN_ROWS: i16 = 13;
const THEME_POLL: Duration = Duration::from_secs(30);
/// SPEC 12.7: manual refresh debounce.
const MANUAL_REFRESH_DEBOUNCE: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum View {
    Dashboard,
    Settings,
    Skills,
}

pub struct App {
    pub state: Arc<AppState>,
    pub view: View,
    pub quota: Option<QuotaResult>,
    pub update: Option<UpdateStatus>,
    /// Draft copy edited in the settings form; committed on Save.
    pub settings_draft: Option<SettingsData>,
    /// Selected settings row: 0 Theme, 1 Interval, 2 AutoStart, 3 Save.
    pub settings_sel: usize,
    /// Flattened skills rows (group headers + items) for the skills view.
    pub skills_rows: Vec<ui::skills_view::Row>,
    /// Index into skills_rows of the highlighted entry.
    pub skills_sel: usize,
    pub skills_loading: bool,
    pub quit: bool,
}

impl App {
    fn new(state: Arc<AppState>) -> Self {
        App {
            state,
            view: View::Dashboard,
            quota: None,
            update: None,
            settings_draft: None,
            settings_sel: 0,
            skills_rows: Vec::new(),
            skills_sel: 0,
            skills_loading: false,
            quit: false,
        }
    }

    pub fn palette(&self) -> theme::Palette {
        theme::palette(&self.state.effective_theme.read().unwrap())
    }

    fn set_skills(&mut self, skills: Vec<SkillInfo>) {
        self.skills_loading = false;
        let mut rows = Vec::new();
        let mut last_source: Option<&str> = None;
        for s in &skills {
            if last_source != Some(s.source.as_str()) {
                rows.push(ui::skills_view::Row::Group(s.source.clone()));
                last_source = Some(s.source.as_str());
            }
            rows.push(ui::skills_view::Row::Item {
                name: s.name.clone(),
                description: s.description.clone(),
            });
        }
        self.skills_rows = rows;
        self.skills_sel = first_item(&self.skills_rows).unwrap_or(0);
    }
}

fn first_item(rows: &[ui::skills_view::Row]) -> Option<usize> {
    rows.iter().position(|r| matches!(r, ui::skills_view::Row::Item { .. }))
}

/// Move the skills highlight to the next/previous item row (group headers
/// are not selectable).
fn move_skills_sel(rows: &[ui::skills_view::Row], sel: usize, dir: i64) -> usize {
    if rows.is_empty() {
        return 0;
    }
    let len = rows.len() as i64;
    let mut i = sel as i64;
    for _ in 0..len {
        i = (i + dir).rem_euclid(len);
        if matches!(rows[i as usize], ui::skills_view::Row::Item { .. }) {
            return i as usize;
        }
    }
    sel
}

/// Open a URL in the default browser; errors silently swallowed (SPEC 12.6/12.7).
fn open_url(url: &str) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let _ = std::process::Command::new("cmd")
        .args(["/c", "start", "", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

/// Manual refresh (SPEC 12.7): 2s debounce, repeats within 2s are silently
/// ignored. Mirrors the tray edition's Refresh button: quota refresh AND a
/// version re-check (SPEC 17.3).
fn manual_refresh(app: &App, quota_tx: &mpsc::Sender<QuotaResult>, update_tx: &mpsc::Sender<UpdateStatus>) {
    {
        let mut last = app.state.last_manual_refresh.lock().unwrap();
        if let Some(t) = *last {
            if t.elapsed() < MANUAL_REFRESH_DEBOUNCE {
                return;
            }
        }
        *last = Some(Instant::now());
    }
    let state = app.state.clone();
    let tx = quota_tx.clone();
    tokio::spawn(async move {
        polling::safe_refresh(&state, &tx).await;
    });
    spawn_update_check(&app.state, update_tx);
}

fn spawn_update_check(state: &Arc<AppState>, update_tx: &mpsc::Sender<UpdateStatus>) {
    let state = state.clone();
    let tx = update_tx.clone();
    tokio::spawn(async move {
        let st = update::check().await;
        *state.update.write().unwrap() = st.clone();
        let _ = tx.send(st).await;
    });
}

/// Trigger a skills scan in the background. `refresh=true` forces a rescan:
/// it bypasses the cached list and overwrites the cache on completion
/// (SPEC 21.2: scan once, cache; rescan only on the explicit rescan key).
fn request_skills(app: &mut App, skills_tx: &mpsc::Sender<Vec<SkillInfo>>, refresh: bool) {
    if !refresh {
        let cached = app.state.skills_cache.read().unwrap().clone();
        if let Some(cached) = cached {
            app.set_skills(cached);
            return;
        }
    }
    if app.skills_loading {
        return;
    }
    app.skills_loading = true;
    let state = app.state.clone();
    let tx = skills_tx.clone();
    tokio::task::spawn_blocking(move || {
        let list = skills::scan();
        *state.skills_cache.write().unwrap() = Some(list.clone());
        let _ = tx.blocking_send(list);
    });
}

const THEMES: [&str; 3] = ["system", "light", "dark"];
const INTERVALS: [i64; 4] = [1, 5, 10, 30];

fn cycle<T: PartialEq + Copy>(options: &[T], current: T, dir: i64) -> T {
    let len = options.len() as i64;
    let idx = options.iter().position(|o| *o == current).unwrap_or(0) as i64;
    options[(idx + dir).rem_euclid(len) as usize]
}

/// Settings save action order (SPEC 13.2): write settings.json ->
/// ApplyAutoStart -> apply theme -> reschedule the polling timer.
fn save_settings(app: &mut App) {
    let Some(draft) = app.settings_draft.take() else {
        return;
    };
    settings::save(&draft);
    settings::apply_auto_start(&draft);
    let eff = theme::effective(&draft.theme);
    *app.state.settings.write().unwrap() = draft;
    *app.state.effective_theme.write().unwrap() = eff;
    app.state.reschedule.notify_one();
    app.view = View::Dashboard;
}

fn handle_key(
    app: &mut App,
    key: KeyEvent,
    quota_tx: &mpsc::Sender<QuotaResult>,
    update_tx: &mpsc::Sender<UpdateStatus>,
    skills_tx: &mpsc::Sender<Vec<SkillInfo>>,
) {
    if key.kind == KeyEventKind::Release {
        return;
    }
    // Global quit
    if key.code == KeyCode::Char('q') || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL)) {
        app.quit = true;
        return;
    }

    match app.view {
        View::Dashboard => match key.code {
            KeyCode::Char('r') => manual_refresh(app, quota_tx, update_tx),
            KeyCode::Char('s') => {
                app.settings_draft = Some(app.state.settings.read().unwrap().clone());
                app.settings_sel = 0;
                app.view = View::Settings;
            }
            KeyCode::Char('k') => {
                app.view = View::Skills;
                request_skills(app, skills_tx, false);
            }
            KeyCode::Char('c') => open_url(CONSOLE_URL),
            KeyCode::Char('g') => open_url(RELEASES_URL),
            _ => {}
        },
        View::Settings => {
            let Some(draft) = app.settings_draft.as_mut() else {
                app.view = View::Dashboard;
                return;
            };
            match key.code {
                KeyCode::Esc => {
                    app.settings_draft = None;
                    app.view = View::Dashboard;
                }
                KeyCode::Up => app.settings_sel = app.settings_sel.saturating_sub(1),
                KeyCode::Down => app.settings_sel = (app.settings_sel + 1).min(3),
                KeyCode::Left | KeyCode::Right => {
                    let dir = if key.code == KeyCode::Left { -1 } else { 1 };
                    match app.settings_sel {
                        0 => draft.theme = cycle(&THEMES, draft.theme.as_str(), dir).to_string(),
                        1 => draft.refresh_minutes = cycle(&INTERVALS, draft.refresh_minutes, dir),
                        2 => draft.auto_start = !draft.auto_start,
                        3 => {}
                        _ => {}
                    }
                }
                KeyCode::Enter | KeyCode::Char(' ') => match app.settings_sel {
                    0 => draft.theme = cycle(&THEMES, draft.theme.as_str(), 1).to_string(),
                    1 => draft.refresh_minutes = cycle(&INTERVALS, draft.refresh_minutes, 1),
                    2 => draft.auto_start = !draft.auto_start,
                    _ => save_settings(app),
                },
                _ => {}
            }
        }
        View::Skills => match key.code {
            KeyCode::Esc => app.view = View::Dashboard,
            KeyCode::Up => app.skills_sel = move_skills_sel(&app.skills_rows, app.skills_sel, -1),
            KeyCode::Down => app.skills_sel = move_skills_sel(&app.skills_rows, app.skills_sel, 1),
            KeyCode::Char('r') => request_skills(app, skills_tx, true),
            _ => {}
        },
    }
}

fn poll_theme(state: &Arc<AppState>) {
    let configured = state.settings.read().unwrap().theme.clone();
    // Only "system" follows the OS (SPEC 20)
    if configured != "system" {
        return;
    }
    let eff = theme::effective(&configured);
    let mut cur = state.effective_theme.write().unwrap();
    if *cur != eff {
        *cur = eff;
    }
}

/// RAII terminal restore (SPEC 20): disable raw mode + leave alternate screen
/// on every exit path — normal quit, draw error, EventStream end, early
/// return — so none of them can strand the terminal. Panics are covered by
/// the panic hook installed in run().
struct TerminalRestore;

impl Drop for TerminalRestore {
    fn drop(&mut self) {
        let _ = execute!(io::stdout(), crossterm::cursor::Show, LeaveAlternateScreen);
        let _ = disable_raw_mode();
    }
}

/// Minimal-window launch (SPEC 20): when the process owns its console
/// outright — a double-click created a fresh window just for us — shrink that
/// window to the wireframe's minimal size. Two channels, both best-effort:
/// the xterm window-size escape (Windows Terminal 1.22+) and the conhost
/// shrink-viewport/grow-buffer/fit-viewport sequence. Never touches a console
/// shared with a shell (GetConsoleProcessList > 1), so launching from an
/// existing terminal session leaves the user's window alone.
fn resize_owned_console() {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{
        GetConsoleProcessList, GetStdHandle, SetConsoleScreenBufferSize, SetConsoleWindowInfo,
        COORD, SMALL_RECT, STD_OUTPUT_HANDLE,
    };
    unsafe {
        let mut procs = [0u32; 8];
        if GetConsoleProcessList(&mut procs) != 1 {
            return;
        }
        use std::io::Write;
        let _ = write!(io::stdout(), "\x1b[8;{MIN_WIN_ROWS};{MIN_WIN_COLS}t");
        let _ = io::stdout().flush();
        let Ok(out) = GetStdHandle(STD_OUTPUT_HANDLE) else {
            return;
        };
        if out == HANDLE::default() {
            return;
        }
        let tiny = SMALL_RECT { Left: 0, Top: 0, Right: 0, Bottom: 0 };
        let _ = SetConsoleWindowInfo(out, true, &tiny);
        let _ = SetConsoleScreenBufferSize(out, COORD { X: MIN_WIN_COLS, Y: MIN_WIN_ROWS });
        let fit = SMALL_RECT { Left: 0, Top: 0, Right: MIN_WIN_COLS - 1, Bottom: MIN_WIN_ROWS - 1 };
        let _ = SetConsoleWindowInfo(out, true, &fit);
    }
}

pub async fn run() -> io::Result<()> {
    resize_owned_console();

    let settings_data = settings::load();
    let eff = theme::effective(&settings_data.theme);
    let state = Arc::new(AppState::new(settings_data, eff));

    // A stranded terminal is the worst TUI bug (SPEC 20): the panic hook must
    // be installed BEFORE terminal init so even an init-time panic restores.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = execute!(io::stdout(), crossterm::cursor::Show, LeaveAlternateScreen);
        let _ = disable_raw_mode();
        default_hook(info);
    }));

    enable_raw_mode()?;
    // From here on the RAII guard restores the terminal on EVERY exit path.
    let _restore = TerminalRestore;
    execute!(io::stdout(), EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;

    let (quota_tx, mut quota_rx) = mpsc::channel::<QuotaResult>(8);
    let (update_tx, mut update_rx) = mpsc::channel::<UpdateStatus>(8);
    let (skills_tx, mut skills_rx) = mpsc::channel::<Vec<SkillInfo>>(4);

    tokio::spawn(polling::run(state.clone(), quota_tx.clone()));
    spawn_update_check(&state, &update_tx);

    let mut app = App::new(state.clone());
    let mut events = EventStream::new();
    let mut theme_tick = tokio::time::interval(THEME_POLL);
    theme_tick.tick().await; // first tick fires immediately; skip it
    let mut draw_tick = tokio::time::interval(DRAW_HEARTBEAT);

    let mut result = Ok(());
    loop {
        if let Err(e) = terminal.draw(|f| ui::draw(f, &mut app)) {
            // Capture the error and leave through the shared restore path
            // (TerminalRestore::drop) instead of propagating past it
            result = Err(e);
            break;
        }
        if app.quit {
            break;
        }
        tokio::select! {
            maybe = events.next() => {
                match maybe {
                    Some(Ok(Event::Key(key))) => {
                        handle_key(&mut app, key, &quota_tx, &update_tx, &skills_tx);
                    }
                    // Resize needs no handling: ratatui re-queries the size on draw
                    Some(Ok(_)) => {}
                    // Transient event read error: ignore, keep the loop alive
                    Some(Err(_)) => {}
                    // EventStream ended: exit cleanly instead of busy-spinning
                    None => break,
                }
            }
            q = quota_rx.recv() => {
                if let Some(q) = q {
                    app.quota = Some(q);
                }
            }
            u = update_rx.recv() => {
                if let Some(u) = u {
                    app.update = Some(u);
                }
            }
            s = skills_rx.recv() => {
                if let Some(s) = s {
                    app.set_skills(s);
                }
            }
            _ = theme_tick.tick() => poll_theme(&state),
            // Idle heartbeat: countdowns are recomputed on this redraw (SPEC 12.3)
            _ = draw_tick.tick() => {}
        }
    }

    // _restore (TerminalRestore) drops here, restoring the terminal on all paths
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_app() -> App {
        App::new(Arc::new(AppState::new(SettingsData::default(), "dark".to_string())))
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn channels() -> (
        mpsc::Sender<QuotaResult>,
        mpsc::Sender<UpdateStatus>,
        mpsc::Sender<Vec<SkillInfo>>,
    ) {
        let (q, _qr) = mpsc::channel(1);
        let (u, _ur) = mpsc::channel(1);
        let (s, _sr) = mpsc::channel(1);
        (q, u, s)
    }

    #[test]
    fn q_quits_and_ctrl_c_quits() {
        let (q, u, s) = channels();
        let mut app = test_app();
        handle_key(&mut app, key(KeyCode::Char('q')), &q, &u, &s);
        assert!(app.quit);

        let mut app = test_app();
        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        handle_key(&mut app, ctrl_c, &q, &u, &s);
        assert!(app.quit);
    }

    #[test]
    fn s_opens_settings_and_esc_cancels() {
        let (q, u, s) = channels();
        let mut app = test_app();
        handle_key(&mut app, key(KeyCode::Char('s')), &q, &u, &s);
        assert_eq!(app.view, View::Settings);
        assert!(app.settings_draft.is_some());

        handle_key(&mut app, key(KeyCode::Esc), &q, &u, &s);
        assert_eq!(app.view, View::Dashboard);
        assert!(app.settings_draft.is_none()); // discarded, not saved
    }

    #[test]
    fn settings_navigation_and_cycling() {
        let (q, u, s) = channels();
        let mut app = test_app();
        handle_key(&mut app, key(KeyCode::Char('s')), &q, &u, &s);

        // Down/Up clamp to 0..=3 (Theme, Interval, AutoStart, Save)
        for _ in 0..10 {
            handle_key(&mut app, key(KeyCode::Down), &q, &u, &s);
        }
        assert_eq!(app.settings_sel, 3);
        for _ in 0..10 {
            handle_key(&mut app, key(KeyCode::Up), &q, &u, &s);
        }
        assert_eq!(app.settings_sel, 0);

        // Theme cycles system -> light on Right
        handle_key(&mut app, key(KeyCode::Right), &q, &u, &s);
        assert_eq!(app.settings_draft.as_ref().unwrap().theme, "light");
        // Left wraps dark <- system
        handle_key(&mut app, key(KeyCode::Left), &q, &u, &s);
        handle_key(&mut app, key(KeyCode::Left), &q, &u, &s);
        assert_eq!(app.settings_draft.as_ref().unwrap().theme, "dark");

        // Interval row: default 5 -> Right -> 10
        handle_key(&mut app, key(KeyCode::Down), &q, &u, &s);
        handle_key(&mut app, key(KeyCode::Right), &q, &u, &s);
        assert_eq!(app.settings_draft.as_ref().unwrap().refresh_minutes, 10);

        // AutoStart toggles
        handle_key(&mut app, key(KeyCode::Down), &q, &u, &s);
        handle_key(&mut app, key(KeyCode::Char(' ')), &q, &u, &s);
        assert!(app.settings_draft.as_ref().unwrap().auto_start);
    }

    #[test]
    fn skills_selection_skips_group_headers() {
        let rows = vec![
            ui::skills_view::Row::Group("Kimi Code".to_string()),
            ui::skills_view::Row::Item { name: "a".to_string(), description: String::new() },
            ui::skills_view::Row::Item { name: "b".to_string(), description: String::new() },
        ];
        assert_eq!(first_item(&rows), Some(1));
        assert_eq!(move_skills_sel(&rows, 1, 1), 2);
        assert_eq!(move_skills_sel(&rows, 2, 1), 1); // wraps, skipping the header
        assert_eq!(move_skills_sel(&rows, 1, -1), 2);
        assert_eq!(move_skills_sel(&[], 0, 1), 0);
    }

    #[test]
    fn release_events_are_ignored() {
        let (q, u, s) = channels();
        let mut app = test_app();
        let mut release = key(KeyCode::Char('q'));
        release.kind = KeyEventKind::Release;
        handle_key(&mut app, release, &q, &u, &s);
        assert!(!app.quit);
    }
}
