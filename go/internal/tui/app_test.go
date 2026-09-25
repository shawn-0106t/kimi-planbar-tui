package tui

import (
	"os"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/shawn-0106t/kimi-planbar-tui/go/internal/core"
)

func keyPress(code rune) tea.KeyPressMsg { return tea.KeyPressMsg{Code: code} }

func ctrlPress(code rune) tea.KeyPressMsg {
	return tea.KeyPressMsg{Code: code, Mod: tea.ModCtrl}
}

// stubAutoStart swaps the autostart seam and returns its restore func.
func stubAutoStart(f func(bool, string)) func() {
	saved := applyAutoStart
	applyAutoStart = f
	return func() { applyAutoStart = saved }
}

func updateWith(t *testing.T, m *Model, msg tea.Msg) tea.Cmd {
	t.Helper()
	_, cmd := m.Update(msg)
	return cmd
}

func TestQQuitsAndCtrlCQuits(t *testing.T) {
	m := newTestModel(t)
	if cmd := updateWith(t, m, keyPress('q')); cmd == nil {
		t.Fatalf("q must quit")
	} else if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatalf("q must return tea.Quit, got %T", cmd())
	}

	m = newTestModel(t)
	if cmd := updateWith(t, m, ctrlPress('c')); cmd == nil {
		t.Fatalf("ctrl+c must quit")
	} else if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatalf("ctrl+c must return tea.Quit, got %T", cmd())
	}
}

func TestReleaseEventsAreIgnored(t *testing.T) {
	m := newTestModel(t)
	if cmd := updateWith(t, m, tea.KeyReleaseMsg{Code: 'q'}); cmd != nil {
		t.Fatalf("a key release must never quit")
	}
}

func TestPlainCOpensConsoleNotQuit(t *testing.T) {
	// `c` opens the console URL; only Ctrl+C quits (SPEC 12.7).
	m := newTestModel(t)
	if cmd := updateWith(t, m, keyPress('c')); cmd != nil {
		t.Fatalf("plain c must not quit")
	}
}

func TestSOpensSettingsAndEscCancels(t *testing.T) {
	m := newTestModel(t)
	updateWith(t, m, keyPress('s'))
	if m.view != ViewSettings || m.settingsDraft == nil {
		t.Fatalf("s must open the settings view with a draft")
	}
	updateWith(t, m, keyPress(tea.KeyEsc))
	if m.view != ViewDashboard || m.settingsDraft != nil {
		t.Fatalf("esc must discard the draft and return to the dashboard")
	}
}

func TestSettingsNavigationAndCycling(t *testing.T) {
	m := newTestModel(t)
	updateWith(t, m, keyPress('s'))

	// Down/Up clamp to 0..=3 (Theme, Interval, AutoStart, Save).
	for range 10 {
		updateWith(t, m, keyPress(tea.KeyDown))
	}
	if m.settingsSel != 3 {
		t.Fatalf("settingsSel = %d, want 3", m.settingsSel)
	}
	for range 10 {
		updateWith(t, m, keyPress(tea.KeyUp))
	}
	if m.settingsSel != 0 {
		t.Fatalf("settingsSel = %d, want 0", m.settingsSel)
	}

	// Theme cycles system -> light on Right, and wraps dark <- system.
	updateWith(t, m, keyPress(tea.KeyRight))
	if m.settingsDraft.Theme != "light" {
		t.Fatalf("theme after Right = %q, want light", m.settingsDraft.Theme)
	}
	updateWith(t, m, keyPress(tea.KeyLeft))
	updateWith(t, m, keyPress(tea.KeyLeft))
	if m.settingsDraft.Theme != "dark" {
		t.Fatalf("theme after Left Left = %q, want dark", m.settingsDraft.Theme)
	}

	// Interval row: default 5 -> Right -> 10.
	updateWith(t, m, keyPress(tea.KeyDown))
	updateWith(t, m, keyPress(tea.KeyRight))
	if m.settingsDraft.RefreshMinutes != 10 {
		t.Fatalf("interval after Right = %d, want 10", m.settingsDraft.RefreshMinutes)
	}

	// AutoStart toggles with Space; the draft is discarded by Esc afterwards.
	updateWith(t, m, keyPress(tea.KeyDown))
	updateWith(t, m, keyPress(' '))
	if !m.settingsDraft.AutoStart {
		t.Fatalf("space must toggle autostart on")
	}
}

func TestSettingsSaveReschedulesAndReturnsToDashboard(t *testing.T) {
	m := newTestModel(t)
	// Never touch the real HKCU Run key from tests: record the call instead.
	var applied []bool
	restoreSeam := stubAutoStart(func(autoStart bool, exe string) { applied = append(applied, autoStart) })
	defer restoreSeam()

	// A real polling instance (Init is not called, so no timers are armed;
	// Reschedule only moves the recorded next delay).
	m.polling = core.NewPolling(core.PollingDeps{State: m.state})
	updateWith(t, m, keyPress('s'))
	updateWith(t, m, keyPress(tea.KeyDown))
	updateWith(t, m, keyPress(tea.KeyRight)) // interval 5 -> 10
	updateWith(t, m, keyPress(tea.KeyDown))
	updateWith(t, m, keyPress(tea.KeyDown)) // to Save
	updateWith(t, m, keyPress(tea.KeyEnter))

	if m.view != ViewDashboard || m.settingsDraft != nil {
		t.Fatalf("save must return to the dashboard")
	}
	if got := m.state.Settings().RefreshMinutes; got != 10 {
		t.Fatalf("persisted interval = %d, want 10", got)
	}
	if m.polling.NextDelayMs() != 2000 {
		t.Fatalf("save must reschedule the 2s first refresh, got %d", m.polling.NextDelayMs())
	}
	if len(applied) != 1 || applied[0] != false {
		t.Fatalf("autostart apply called %v, want [false]", applied)
	}
	// The settings file landed in the temp config dir, byte-shape unchanged.
	if _, ok := core.ReadTextStrict(m.configDir + string(os.PathSeparator) + "settings.json"); !ok {
		t.Fatalf("settings.json not written to the config dir")
	}
}

func TestSkillsNavigationSkipsGroupHeaders(t *testing.T) {
	rows := flattenSkills([]core.SkillInfo{
		{Name: "a", Source: "G1"},
		{Name: "b", Source: "G1"},
		{Name: "c", Source: "G2"},
	})
	if firstItem(rows) != 1 {
		t.Fatalf("firstItem = %d, want 1", firstItem(rows))
	}
	if got := moveSkillsSel(rows, 1, 1); got != 2 {
		t.Fatalf("down from 1 = %d, want 2", got)
	}
	if got := moveSkillsSel(rows, 2, 1); got != 4 { // skips the G2 header
		t.Fatalf("down from 2 = %d, want 4", got)
	}
	if got := moveSkillsSel(rows, 1, -1); got != 4 { // wraps backwards past the header
		t.Fatalf("up from 1 = %d, want 4", got)
	}
	if got := moveSkillsSel(nil, 0, 1); got != 0 {
		t.Fatalf("empty rows must stay at 0, got %d", got)
	}

	// Through the key router: opening the view selects the first item.
	m := newTestModel(t)
	cmd := updateWith(t, m, keyPress('k'))
	if m.view != ViewSkills || !m.skillsLoading {
		t.Fatalf("k must open the skills view in the loading state")
	}
	if cmd == nil {
		t.Fatalf("k must start the background scan (never block Update)")
	}
	updateWith(t, m, skillsMsg{list: []core.SkillInfo{
		{Name: "a", Source: "G1"},
		{Name: "b", Source: "G1"},
	}})
	if m.skillsLoading || m.skillsSel != 1 {
		t.Fatalf("skills result must select the first item: sel=%d loading=%v", m.skillsSel, m.skillsLoading)
	}
	updateWith(t, m, keyPress(tea.KeyDown))
	if m.skillsSel != 2 {
		t.Fatalf("down = %d, want 2", m.skillsSel)
	}
	updateWith(t, m, keyPress(tea.KeyEsc))
	if m.view != ViewDashboard {
		t.Fatalf("esc must return to the dashboard")
	}
}

func TestManualRefreshDebounce(t *testing.T) {
	m := newTestModel(t)
	m.polling = core.NewPolling(core.PollingDeps{State: m.state})
	first := updateWith(t, m, keyPress('r'))
	if first == nil {
		t.Fatalf("first r must trigger a refresh")
	}
	if second := updateWith(t, m, keyPress('r')); second != nil {
		t.Fatalf("repeats within 2s must be silently ignored (SPEC 12.7)")
	}
	// After the 2s window the key works again.
	stamp := time.Now().UnixMilli() - 2001
	m.state.SetLastManualRefreshMs(&stamp)
	if again := updateWith(t, m, keyPress('r')); again == nil {
		t.Fatalf("r after the debounce window must trigger a refresh")
	}
}

func TestHeartbeatAndThemeTickRearm(t *testing.T) {
	m := newTestModel(t)
	if cmd := updateWith(t, m, heartbeatMsg{}); cmd == nil {
		t.Fatalf("heartbeat must re-arm itself")
	}
	if cmd := updateWith(t, m, themeTickMsg{}); cmd == nil {
		t.Fatalf("theme tick must re-arm itself")
	}
}

func TestPollThemeFollowsSystemOnly(t *testing.T) {
	// theme=dark never probes the OS (the thunk is not called).
	state := core.NewAppState(core.SettingsData{Theme: "dark", RefreshMinutes: 5}, "dark")
	m := NewModel(state, "")
	m.pollTheme()
	if got := state.EffectiveTheme(); got != "dark" {
		t.Fatalf("dark theme must stay dark, got %q", got)
	}

	// theme=system resolves through the registry (a read-only HKCU query).
	state = core.NewAppState(core.SettingsData{Theme: "system", RefreshMinutes: 5}, "light")
	m = NewModel(state, "")
	m.pollTheme()
	if got := state.EffectiveTheme(); got != "light" && got != "dark" {
		t.Fatalf("system theme resolved to %q", got)
	}
}

func TestWindowSizeMsgUpdatesFrame(t *testing.T) {
	m := newTestModel(t)
	updateWith(t, m, tea.WindowSizeMsg{Width: 80, Height: 24})
	if m.width != 80 || m.height != 24 {
		t.Fatalf("size = %dx%d, want 80x24", m.width, m.height)
	}
	// The frame grows to the new height with the footer on the bottom row.
	texts := frameTexts(t, m)
	if len(texts) != 24 {
		t.Fatalf("frame rows = %d, want 24", len(texts))
	}
	if !strings.Contains(texts[23], "q Quit") {
		t.Errorf("footer missing from the bottom row: %q", texts[23])
	}
}

func TestQuotaAndUpdateMsgsUpdateModel(t *testing.T) {
	m := newTestModel(t)
	nowMs := time.Now().UnixMilli()
	q := quotaFixture(nowMs)
	updateWith(t, m, quotaMsg{result: q})
	if m.quota == nil || m.quota.FiveHour == nil {
		t.Fatalf("quota result not stored")
	}
	// Mutating a later result must not alias the stored one.
	next := quotaFixture(nowMs)
	next.FiveHour.Percent = 99
	updateWith(t, m, quotaMsg{result: next})
	if m.quota.FiveHour.Percent != 99 {
		t.Fatalf("stored result = %v, want the latest (99)", m.quota.FiveHour.Percent)
	}

	local := "1.2.3"
	updateWith(t, m, updateMsg{status: core.UpdateStatus{LocalVersion: &local}})
	if m.update == nil || m.update.LocalVersion == nil || *m.update.LocalVersion != "1.2.3" {
		t.Fatalf("update status not stored")
	}
	if m.state.Update().LocalVersion == nil {
		t.Fatalf("update status must be mirrored into the shared state")
	}
	// The first result kept its own copy (no aliasing between results).
	if q.FiveHour.Percent != 21 {
		t.Fatalf("the stored result aliased the fixture: %v", q.FiveHour.Percent)
	}
}
