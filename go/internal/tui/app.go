// The bubbletea v2 render layer's application model: the Go counterpart of
// rust/src/app.rs (the tokio::select! event loop becomes Model/Update/View —
// every Msg triggers Update and an immediate re-render, so no event pump has
// to be assembled by hand).
//
// Mapping of the Rust event sources (SPEC 20):
//   - keyboard / resize      -> tea.KeyPressMsg / tea.WindowSizeMsg
//   - polling mpsc           -> quotaMsg (core.Polling Publish callback)
//   - update mpsc            -> updateMsg (async tea.Cmd)
//   - skills mpsc            -> skillsMsg (async tea.Cmd, never blocks Update)
//   - theme tick (30s)       -> themeTickMsg (tea.Tick self-rescheduling)
//   - draw tick (250ms)      -> heartbeatMsg (idle heartbeat; every event
//     redraws immediately, countdown text is recomputed on every redraw —
//     SPEC 12.3)
//
// Terminal discipline (SPEC 20): bubbletea restores the terminal on every
// normal exit path and recovers panics; Run() additionally registers a
// best-effort restore BEFORE terminal init (the Rust panic-hook discipline).
package tui

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/term"

	"github.com/shawn-0106t/kimi-planbar-tui/go/internal/core"
)

// SPEC 12.7: Console button URL.
const consoleURL = "https://www.kimi.com/code/console?from=kfc_overview_topbar"

// SPEC 12.6: version row click target.
const releasesURL = "https://github.com/MoonshotAI/kimi-code/releases"

// Idle redraw heartbeat (SPEC 20): wakes the loop when no events arrive so
// countdown text stays fresh; not a throttle — events redraw immediately.
const drawHeartbeat = 250 * time.Millisecond

// Theme poll period (SPEC 20).
const themePoll = 30 * time.Second

// SPEC 12.7: manual refresh debounce.
const manualRefreshDebounceMs = int64(2000)

// ViewKind is the active screen.
type ViewKind int

const (
	ViewDashboard ViewKind = iota
	ViewSettings
	ViewSkills
)

// Model is the bubbletea model; one instance drives the whole TUI.
// Non-state fields are only touched from the event-loop goroutine (Update /
// View), the shared core.AppState carries its own lock.
type Model struct {
	state   *core.AppState
	polling *core.Polling
	// configDir is resolved once at startup (SPEC 18.1 portable mode).
	configDir string

	view          ViewKind
	quota         *core.QuotaResult
	update        *core.UpdateStatus
	settingsDraft *core.SettingsData // edited in the form; committed on Save
	settingsSel   int                // 0 Theme, 1 Interval, 2 AutoStart, 3 Save
	skillsRows    []SkillsRow
	skillsSel     int
	skillsLoading bool

	width  int
	height int
}

// NewModel assembles the model for Run; tests may build Models directly.
func NewModel(state *core.AppState, configDir string) *Model {
	return &Model{state: state, configDir: configDir}
}

// --- messages ---------------------------------------------------------------

type quotaMsg struct{ result core.QuotaResult }
type updateMsg struct{ status core.UpdateStatus }
type skillsMsg struct{ list []core.SkillInfo }
type heartbeatMsg struct{}
type themeTickMsg struct{}

// --- commands ---------------------------------------------------------------

func heartbeatCmd() tea.Cmd {
	return tea.Tick(drawHeartbeat, func(time.Time) tea.Msg { return heartbeatMsg{} })
}

func themeTickCmd() tea.Cmd {
	return tea.Tick(themePoll, func(time.Time) tea.Msg { return themeTickMsg{} })
}

// updateCheckCmd runs the CLI version check off the Update goroutine (SPEC 17).
func (m *Model) updateCheckCmd() tea.Cmd {
	return func() tea.Msg {
		return updateMsg{status: core.CheckUpdate(core.UpdateDeps{})}
	}
}

// refreshCmd runs one serialized refresh (fetch + keep-last-good + publish +
// retime). The polling layer publishes quotaMsg itself, so the Cmd result is
// ignored.
func (m *Model) refreshCmd() tea.Cmd {
	return func() tea.Msg {
		m.polling.SafeRefresh()
		return nil
	}
}

// skillsScanCmd runs the filesystem scan off the Update goroutine (the Rust
// spawn_blocking) and overwrites the cache (SPEC 21.2).
func (m *Model) skillsScanCmd() tea.Cmd {
	return func() tea.Msg {
		list := core.ScanSkills(core.OSEnv())
		m.state.SetSkillsCache(list)
		return skillsMsg{list: list}
	}
}

// manualRefreshCmds is the `r` key (SPEC 12.7): 2 s debounce, repeats within
// 2 s are silently ignored; refresh AND a version re-check (SPEC 17.3).
func (m *Model) manualRefreshCmds() tea.Cmd {
	now := time.Now().UnixMilli()
	if last := m.state.LastManualRefreshMs(); last != nil && now-*last < manualRefreshDebounceMs {
		return nil
	}
	m.state.SetLastManualRefreshMs(&now)
	return tea.Batch(m.refreshCmd(), m.updateCheckCmd())
}

// requestSkills triggers a skills scan. refresh=false serves the cached list
// when present (SPEC 21.2: scan once, cache; rescan only on the explicit key).
func (m *Model) requestSkills(refresh bool) tea.Cmd {
	if !refresh {
		if cached := m.state.SkillsCache(); cached != nil {
			m.setSkills(cached)
			return nil
		}
	}
	if m.skillsLoading {
		return nil
	}
	m.skillsLoading = true
	return m.skillsScanCmd()
}

func (m *Model) setSkills(skills []core.SkillInfo) {
	m.skillsLoading = false
	m.skillsRows = flattenSkills(skills)
	if first := firstItem(m.skillsRows); first >= 0 {
		m.skillsSel = first
	} else {
		m.skillsSel = 0
	}
}

// pollTheme is the 30 s registry poll; only theme=system follows the OS
// (SPEC 20). The direct in-process registry read needs no async wrapper
// (PLAN-GO §4.2 — no reg.exe, unlike the TS editions).
func (m *Model) pollTheme() {
	configured := m.state.Settings().Theme
	if configured != "system" {
		return
	}
	eff := core.EffectiveTheme(configured, core.ReadSystemTheme)
	if m.state.EffectiveTheme() != eff {
		m.state.SetEffectiveTheme(eff)
	}
}

// applyAutoStart is the settings-save seam for the HKCU Run key (SPEC 18);
// tests stub it out so the suite never touches the real registry value.
var applyAutoStart = core.ApplyAutoStart

// saveSettings order (SPEC 13.2 / rust app.rs): write settings.json ->
// ApplyAutoStart -> apply theme -> reschedule the polling timer.
func (m *Model) saveSettings() {
	if m.settingsDraft == nil {
		return
	}
	draft := *m.settingsDraft
	m.settingsDraft = nil
	core.SaveSettings(draft, m.configDir)
	applyAutoStart(draft.AutoStart, core.CurrentExe())
	eff := core.EffectiveTheme(draft.Theme, core.ReadSystemTheme)
	m.state.SetSettings(draft)
	m.state.SetEffectiveTheme(eff)
	m.polling.Reschedule()
	m.view = ViewDashboard
}

// openURL opens a URL in the default browser; errors silently swallowed
// (SPEC 12.6/12.7). Same `cmd /c start` channel as the Rust edition
// (HANDOFF §5-2), with CREATE_NO_WINDOW via HideWindow.
func openURL(url string) {
	cmd := exec.Command("cmd", "/c", "start", "", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Start()
}

// --- key routing -------------------------------------------------------------

// handleKey routes one key press; the Rust dispatch matches KeyCode only and
// ignores modifiers (Ctrl+R still hits the `r` branch), and so does this —
// except the global Ctrl+C quit. Key releases never reach here: Update only
// matches tea.KeyPressMsg, the Windows driver also delivers release events
// (the crossterm KeyEventKind::Release guard in the Rust edition).
func (m *Model) handleKey(k tea.KeyPressMsg) tea.Cmd {
	code := k.Code
	ctrl := k.Mod&tea.ModCtrl != 0

	// Global quit: `q` is the primary quit key; Ctrl+C is the second channel
	// (the OS signal path is bubbletea's built-in SIGINT handler, SPEC 20).
	if code == 'q' || (code == 'c' && ctrl) {
		return tea.Quit
	}

	switch m.view {
	case ViewDashboard:
		switch code {
		case 'r':
			return m.manualRefreshCmds()
		case 's':
			draft := m.state.Settings()
			m.settingsDraft = &draft
			m.settingsSel = 0
			m.view = ViewSettings
		case 'k':
			m.view = ViewSkills
			return m.requestSkills(false)
		case 'c':
			openURL(consoleURL)
		case 'g':
			openURL(releasesURL)
		}

	case ViewSettings:
		if m.settingsDraft == nil {
			m.view = ViewDashboard
			return nil
		}
		draft := m.settingsDraft
		switch code {
		case tea.KeyEsc:
			m.settingsDraft = nil
			m.view = ViewDashboard
		case tea.KeyUp:
			if m.settingsSel > 0 {
				m.settingsSel--
			}
		case tea.KeyDown:
			if m.settingsSel < 3 {
				m.settingsSel++
			}
		case tea.KeyLeft, tea.KeyRight:
			dir := 1
			if code == tea.KeyLeft {
				dir = -1
			}
			switch m.settingsSel {
			case 0:
				draft.Theme = cycleStr(themeValues, draft.Theme, dir)
			case 1:
				draft.RefreshMinutes = cycleI64(intervalValues, draft.RefreshMinutes, dir)
			case 2:
				draft.AutoStart = !draft.AutoStart
			}
		case tea.KeyEnter, ' ':
			switch m.settingsSel {
			case 0:
				draft.Theme = cycleStr(themeValues, draft.Theme, 1)
			case 1:
				draft.RefreshMinutes = cycleI64(intervalValues, draft.RefreshMinutes, 1)
			case 2:
				draft.AutoStart = !draft.AutoStart
			default:
				m.saveSettings()
			}
		}

	case ViewSkills:
		switch code {
		case tea.KeyEsc:
			m.view = ViewDashboard
		case tea.KeyUp:
			m.skillsSel = moveSkillsSel(m.skillsRows, m.skillsSel, -1)
		case tea.KeyDown:
			m.skillsSel = moveSkillsSel(m.skillsRows, m.skillsSel, 1)
		case 'r':
			return m.requestSkills(true)
		}
	}
	return nil
}

// --- bubbletea Model ---------------------------------------------------------

// Init starts the background work: refresh schedule, version check, heartbeat
// and theme poll. The first theme tick fires 30 s in, matching the Rust
// interval that skips its immediate first tick.
func (m *Model) Init() tea.Cmd {
	m.polling.Start()
	return tea.Batch(m.updateCheckCmd(), heartbeatCmd(), themeTickCmd())
}

// Update is the state machine; it must never block — everything slow is a Cmd.
func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		return m, m.handleKey(msg)

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case quotaMsg:
		result := msg.result
		m.quota = &result

	case updateMsg:
		status := msg.status
		m.update = &status
		m.state.SetUpdate(status)

	case skillsMsg:
		m.setSkills(msg.list)

	case heartbeatMsg:
		return m, heartbeatCmd()

	case themeTickMsg:
		m.pollTheme()
		return m, themeTickCmd()
	}
	return m, nil
}

// View renders one full-screen frame: the view rows, a window_bg vertical
// fill, and the footer pinned to the bottom row; every row is clipped and
// padded to the full width (SPEC 22.5 full-screen background discipline).
func (m *Model) View() tea.View {
	v := tea.NewView("")
	// Alt screen + raw mode + restore-on-exit are bubbletea's job here; the
	// dashboard defines no mouse interaction, so mouse tracking stays off
	// (SPEC 12.7/22.5: no ?1000h/?1002h/?1003h/?1006h in the startup stream).
	v.AltScreen = true
	v.MouseMode = tea.MouseModeNone
	if m.width <= 0 || m.height <= 0 {
		return v // wait for the first WindowSizeMsg
	}

	p := core.PaletteOf(m.state.EffectiveTheme())
	nowMs := time.Now().UnixMilli()

	var rows []Line
	var footer Line
	switch m.view {
	case ViewDashboard:
		rows = dashboardView(m, p, nowMs)
		footer = Line{Spans: []Span{styledSpan(dashboardFooter, p.TextSecondary)}}
	case ViewSettings:
		rows = settingsView(m, p)
		footer = settingsFooterRow(p)
	case ViewSkills:
		rows = skillsView(m, p)
		footer = skillsFooterRow(p)
	}

	all := assembleFrame(rows, footer, m.width, m.height, p.WindowBg)

	var b strings.Builder
	for i, row := range all {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(renderLine(padLineToWidth(row, m.width, p.WindowBg)))
	}
	v.Content = b.String()
	return v
}

// assembleFrame pins the footer to the bottom row, fills the vertical gap
// with window_bg rows, and clips the body when the terminal is shorter than
// the wireframe (ratatui's Layout compresses instead of dropping the footer).
func assembleFrame(rows []Line, footer Line, width, height int, windowBg string) []Line {
	body := rows
	if height-1 < 0 {
		return nil
	}
	if len(body) > height-1 {
		body = body[:height-1]
	}
	for len(body) < height-1 {
		body = append(body, blankLine(width, windowBg))
	}
	return append(body, footer)
}

// --- bootstrap ---------------------------------------------------------------

// terminalRestore is the main-level safety net for the terminal (SPEC 20):
// captured BEFORE bubbletea touches the console, applied after Run returns or
// panics. bubbletea restores on its own paths; this defer covers everything
// outside it (init-time panics, construction failures). Every step tolerates
// a terminal that was never set up.
type terminalRestore struct {
	stdin *term.State
}

func newTerminalRestore() *terminalRestore {
	st, err := term.GetState(os.Stdin.Fd())
	if err != nil {
		return &terminalRestore{}
	}
	return &terminalRestore{stdin: st}
}

func (r *terminalRestore) run() {
	// Show cursor + leave the alternate screen; both are no-ops when
	// bubbletea already restored the terminal.
	fmt.Fprint(os.Stdout, "\x1b[?25h\x1b[?1049l")
	if r.stdin != nil {
		_ = term.Restore(os.Stdin.Fd(), r.stdin)
	}
}

// Run boots the TUI (called from main after the headless self-checks). The
// Rust-order equivalent of resize_owned_console lands in M4 (PLAN-GO §6).
func Run() error {
	configDir := core.ConfigDir(core.CurrentExe(), core.OSEnv())
	settingsData := core.LoadSettings(configDir)
	eff := core.EffectiveTheme(settingsData.Theme, core.ReadSystemTheme)
	state := core.NewAppState(settingsData, eff)

	m := NewModel(state, configDir)
	prog := tea.NewProgram(m)
	m.polling = core.NewPolling(core.PollingDeps{
		State: state,
		FetchQuota: func() core.QuotaResult {
			return core.FetchQuota(core.QuotaDeps{})
		},
		Publish: func(r core.QuotaResult) {
			prog.Send(quotaMsg{result: r})
		},
	})

	// Register the restore path BEFORE terminal init (SPEC 20 discipline).
	restore := newTerminalRestore()
	defer restore.run()

	_, err := prog.Run()
	m.polling.Stop()
	// SIGINT (the non-TTY Ctrl+C channel) is a clean exit, like `q`.
	if errors.Is(err, tea.ErrInterrupted) {
		return nil
	}
	return err
}
