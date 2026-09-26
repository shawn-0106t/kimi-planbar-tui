package tui

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/shawn-0106t/kimi-planbar-tui/go/internal/core"
)

func newTestModel(t *testing.T) *Model {
	t.Helper()
	state := core.NewAppState(core.DefaultSettings(), "dark")
	// The temp dir keeps a settings save from touching the real config.
	m := NewModel(state, t.TempDir())
	m.width = 72
	m.height = 13
	return m
}

func frameTexts(t *testing.T, m *Model) []string {
	t.Helper()
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
		footer = settingsFooterRow(m, p)
	case ViewSkills:
		rows = skillsView(m, p)
		footer = skillsFooterRow(p)
	}
	all := assembleFrame(rows, footer, m.width, m.height, p.WindowBg)
	texts := make([]string, len(all))
	for i, row := range all {
		padded := padLineToWidth(row, m.width, p.WindowBg)
		if w := lineWidth(padded); w != m.width {
			t.Errorf("row %d is %d cells, want exactly %d", i, w, m.width)
		}
		texts[i] = lineText(padded)
	}
	return texts
}

func quotaFixture(nowMs int64) core.QuotaResult {
	return core.QuotaResult{
		FiveHour: &core.QuotaSegment{
			Percent: 21,
			ResetAt: &core.RustDateTime{Ms: nowMs + 4*time.Hour.Milliseconds() + 30*time.Minute.Milliseconds()},
		},
		Week: &core.QuotaSegment{
			Percent: 18.4,
			ResetAt: &core.RustDateTime{Ms: nowMs + 5*24*time.Hour.Milliseconds() + 15*time.Hour.Milliseconds()},
		},
		Extra: &core.ExtraInfo{
			State:             core.ExtraReady,
			BalanceCents:      int64Ptr(1234),
			MonthlyEnabled:    true,
			MonthlyUsedCents:  int64Ptr(4567),
			MonthlyLimitCents: int64Ptr(10000),
		},
		FetchedAt: core.DtFromNow(nowMs),
	}
}

func int64Ptr(v int64) *int64 { return &v }

// updatedStampRe matches "Updated HH:mm" ending exactly at the right edge.
var updatedStampRe = regexp.MustCompile(`Updated \d{2}:\d{2}$`)

func TestDashboardEmptyState(t *testing.T) {
	m := newTestModel(t)
	rows := frameTexts(t, m)
	if len(rows) != 13 {
		t.Fatalf("got %d rows, want 13", len(rows))
	}
	want := []struct {
		row      int
		contains string
	}{
		{0, "Kimi Planbar TUI"},
		{2, "5-hour usage"},
		{2, "--"},
		{3, "Weekly usage"},
		{5, "Extra Usage"},
		{5, "--"},
		// No monthly sub-line: the monthly chunk is zero-height, so the
		// version row sits one row higher than with the sub-line.
		{7, "Kimi Code CLI"},
		{7, "--"},
		{12, "r Refresh · s Settings · k Skills · c Console · g Releases · q Quit"},
	}
	for _, w := range want {
		if !strings.Contains(rows[w.row], w.contains) {
			t.Errorf("row %d = %q, want it to contain %q", w.row, rows[w.row], w.contains)
		}
	}
}

func TestDashboardWithQuota(t *testing.T) {
	m := newTestModel(t)
	nowMs := time.Now().UnixMilli()
	q := quotaFixture(nowMs)
	m.quota = &q
	rows := frameTexts(t, m)

	// Title row: "Updated HH:mm" right-aligned (TZ pinned by TestMain): the
	// stamp's HH:mm must end at the row's right edge.
	if !updatedStampRe.MatchString(strings.TrimRight(rows[0], " ")) {
		t.Errorf("Updated stamp is not right-aligned: %q", rows[0])
	}
	// Usage rows: raw percent display + clamped bar + countdown.
	if !strings.Contains(rows[2], "21%") || !strings.Contains(rows[2], "████") {
		t.Errorf("5-hour row = %q, want 21%% and a filled bar", rows[2])
	}
	if !strings.Contains(rows[2], "Resets in 4h 30m") {
		t.Errorf("5-hour reset text missing: %q", rows[2])
	}
	// 18.4 rounds to 18 for display (SPEC 12.2 raw percent, half away from zero).
	if !strings.Contains(rows[3], "18%") {
		t.Errorf("weekly row = %q, want 18%%", rows[3])
	}
	// Extra: ¥12.34 and the monthly sub-line.
	if !strings.Contains(rows[5], "¥12.34") {
		t.Errorf("balance = %q, want ¥12.34", rows[5])
	}
	if !strings.Contains(rows[6], "Used ¥45.67 this month / ¥100 limit") {
		t.Errorf("monthly line = %q", rows[6])
	}
	// With the monthly sub-line shown, exactly one blank separates it from the
	// version row (the Rust chunk layout: monthly(6) / blank(7) / version(8));
	// a duplicated blank would push the version row down to 9.
	if blank := strings.TrimSpace(rows[7]); blank != "" {
		t.Errorf("row 7 = %q, want the single blank before the version row", rows[7])
	}
	if !strings.HasPrefix(rows[8], "Kimi Code CLI") {
		t.Errorf("row 8 = %q, want the version row right after the blank", rows[8])
	}
}

func TestDashboardErrorKeepsLastGood(t *testing.T) {
	m := newTestModel(t)
	nowMs := time.Now().UnixMilli()
	q := quotaFixture(nowMs)
	m.quota = &q
	failed := q // the polling layer fills missing fields from last-good
	errText := "HttpRequestException"
	failed.Error = &errText
	m.quota = &failed

	rows := frameTexts(t, m)
	if !strings.Contains(rows[0], "Update failed") {
		t.Errorf("title row = %q, want Update failed", rows[0])
	}
	// The failure keeps last-good values on screen (SPEC 16.5): the 21% and
	// the reset text survive.
	if !strings.Contains(rows[2], "21%") {
		t.Errorf("last-good 5-hour row lost: %q", rows[2])
	}
}

func TestDashboardUpdateBadge(t *testing.T) {
	m := newTestModel(t)
	local := "2.0.1"
	m.update = &core.UpdateStatus{LocalVersion: &local, UpdateAvailable: true}
	rows := frameTexts(t, m)
	if !strings.Contains(rows[7], "2.0.1") || !strings.Contains(rows[7], "Update available") {
		t.Errorf("version row = %q, want version + badge", rows[7])
	}

	m.update = &core.UpdateStatus{}
	rows = frameTexts(t, m)
	if !strings.Contains(rows[7], "Not detected") {
		t.Errorf("version row = %q, want Not detected", rows[7])
	}
}

func TestDashboardNarrowTerminalDropsBar(t *testing.T) {
	m := newTestModel(t)
	nowMs := time.Now().UnixMilli()
	q := quotaFixture(nowMs)
	m.quota = &q

	// 42 cols: label + pct + reset text fit, but the bar's share (4) is below
	// the 5-cell minimum — the bar is dropped, the reset text survives (the
	// SPEC 12.2 degradation rule, mirroring the Rust MIN_BAR_W guard).
	m.width = 42
	rows := frameTexts(t, m)
	if strings.Contains(rows[2], "█") {
		t.Errorf("bar must be dropped when its share is under %d cells: %q", minBarW, rows[2])
	}
	if !strings.Contains(rows[2], "Resets in 4h 30m") {
		t.Errorf("reset text must survive: %q", rows[2])
	}

	// 30 cols: even the reset text no longer fits — the row clips at the edge
	// (the Rust Paragraph clips identically), never crashes or wraps.
	m.width = 30
	rows = frameTexts(t, m)
	if len(rows[2]) != 30 {
		t.Errorf("clipped row is %d bytes, want the row bounded by the width: %q", len(rows[2]), rows[2])
	}
}

func TestDashboardNotActivatedExtra(t *testing.T) {
	m := newTestModel(t)
	nowMs := time.Now().UnixMilli()
	q := quotaFixture(nowMs)
	q.Extra = &core.ExtraInfo{State: core.ExtraNotActivated}
	m.quota = &q
	rows := frameTexts(t, m)
	if !strings.Contains(rows[5], "Not activated") {
		t.Errorf("Extra Usage row = %q, want Not activated (SPEC 16.3)", rows[5])
	}
}

func TestSettingsViewSnapshot(t *testing.T) {
	m := newTestModel(t)
	// The compacted 9-line form (REVIEW-RUST Major B) fits the 72×13 minimal
	// window, so the default newTestModel size exercises every row.
	if _, cmd := m.Update(keyPress('s')); cmd != nil {
		t.Fatalf("opening settings returned a cmd")
	}
	rows := frameTexts(t, m)
	joined := strings.Join(rows, "\n")
	for _, want := range []string{
		"Kimi Planbar TUI Settings",
		"Theme", "System default", "Moonlit (light)", "Moondark (dark)",
		"Refresh interval", "1 min", "5 min", "10 min", "30 min",
		"Launch at Windows startup", "Save",
		"↑/↓ Move · ←/→ Change · Enter Save/Toggle · Esc Cancel · q Quit",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("settings view lacks %q", want)
		}
	}
	// Default draft: system radio selected, 5 min pill, no autostart.
	if !strings.Contains(joined, "(●) System default") {
		t.Errorf("system radio not selected: %q", joined)
	}
	if strings.Contains(joined, "[x]") {
		t.Errorf("autostart must default to off")
	}
	// The footer sits on the bottom row (padding computed in cells).
	if rows[12] != settingsFooter+strings.Repeat(" ", 72-displayWidth(settingsFooter)) {
		t.Errorf("footer not pinned to the last row: %q", rows[12])
	}
}

// REVIEW-RUST Major B + Suggestion 18 regression, mirroring the Rust
// settings_form_fits_minimal_window: at the SPEC 20 minimal window (72×13)
// the whole form — interval pills, autostart checkbox, Save action row — and
// the footer must be visible. The old 13-line form clipped its last four
// rows.
func TestSettingsFormFitsMinimalWindow(t *testing.T) {
	m := newTestModel(t)
	m.Update(keyPress('s'))
	m.settingsSel = 3 // Save row selected, like the Rust test's fixture
	rows := frameTexts(t, m)
	screen := strings.Join(rows, "\n")
	if !strings.Contains(screen, "1 min") {
		t.Errorf("interval pills clipped:\n%s", screen)
	}
	if !strings.Contains(screen, "Launch at Windows startup") {
		t.Errorf("checkbox clipped:\n%s", screen)
	}
	// " Save " with surrounding spaces is the action row; the footer's
	// "Enter Save/Toggle" must not satisfy this assert.
	if !strings.Contains(screen, " Save ") {
		t.Errorf("Save row clipped:\n%s", screen)
	}
	if !strings.Contains(screen, "q Quit") {
		t.Errorf("footer clipped:\n%s", screen)
	}
}

func TestSettingsCyclingChangesView(t *testing.T) {
	m := newTestModel(t)
	m.Update(keyPress('s'))

	m.Update(keyPress(tea.KeyRight)) // theme: system -> light
	joined := strings.Join(frameTexts(t, m), "\n")
	if !strings.Contains(joined, "(●) Moonlit (light)") {
		t.Errorf("light radio not selected after Right: %q", joined)
	}

	m.Update(keyPress(tea.KeyDown))  // to interval row
	m.Update(keyPress(tea.KeyRight)) // 5 -> 10
	// The active pill is the styled " 10 min "; plain text shows it with
	// spaces around, so assert the draft drives the frame via re-render.
	if draft := m.settingsDraft; draft == nil || draft.RefreshMinutes != 10 {
		t.Fatalf("interval cycle failed: %+v", m.settingsDraft)
	}

	m.Update(keyPress(tea.KeyDown)) // autostart row
	m.Update(keyPress(' '))         // toggle on
	joined = strings.Join(frameTexts(t, m), "\n")
	if !strings.Contains(joined, "[x] Launch at Windows startup") {
		t.Errorf("autostart checkbox not shown checked: %q", joined)
	}
}

// REVIEW-RUST Minor 11: while the selected item (name + description, two
// lines) already fits the viewport, the view must not scroll.
func TestScrollForUnchangedWhileSelectionFits(t *testing.T) {
	if got := scrollFor(0, 5, 10); got != 0 {
		t.Errorf("scrollFor(0,5,10) = %d, want 0", got)
	}
	// Name 3 + desc 4 fit rows 0..=4.
	if got := scrollFor(3, 5, 10); got != 0 {
		t.Errorf("scrollFor(3,5,10) = %d, want 0", got)
	}
}

// REVIEW-RUST Minor 11 regression: the old +1 budget kept only the name row
// visible — paging down clipped the description line below the fold.
func TestScrollForShowsNameAndDescription(t *testing.T) {
	// Name on the last visible row: one line of scroll reveals the description.
	if got := scrollFor(4, 5, 10); got != 1 {
		t.Errorf("scrollFor(4,5,10) = %d, want 1", got)
	}
	// Paged past the bottom: name and description end on the last two rows.
	if got := scrollFor(7, 5, 10); got != 4 {
		t.Errorf("scrollFor(7,5,10) = %d, want 4", got)
	}
}

// maxScroll pins the view to the last page while both selected lines stay
// visible; out-of-range selections and short lists clamp safely.
func TestScrollForClampsToMax(t *testing.T) {
	// Last page rows 3..=7: name 6, desc 7 visible.
	if got := scrollFor(6, 5, 3); got != 3 {
		t.Errorf("scrollFor(6,5,3) = %d, want 3", got)
	}
	if got := scrollFor(50, 5, 3); got != 3 {
		t.Errorf("scrollFor(50,5,3) = %d, want 3", got)
	}
	// Short list, nothing to scroll.
	if got := scrollFor(0, 5, 0); got != 0 {
		t.Errorf("scrollFor(0,5,0) = %d, want 0", got)
	}
}

func TestSkillsViewSnapshot(t *testing.T) {
	m := newTestModel(t)
	m.view = ViewSkills
	m.setSkills([]core.SkillInfo{
		{ID: "a", Name: "web-search", Description: "Search the web", Source: "Kimi Code"},
		{ID: "b", Name: "翻译助手", Description: "中英互译", Source: "Kimi Code"},
		{ID: "c", Name: "plugin-skill", Description: "From a plugin", Source: "Plugin: demo"},
	})
	rows := frameTexts(t, m)
	joined := strings.Join(rows, "\n")
	// Title row exact match: the 2-space left indent is the Rust title
	// block's padding (skills_view.rs Padding::new(2, 0, 1, 0)) — anchored to
	// the row start so a lost indent cannot slip through a Contains check.
	if got := strings.TrimRight(rows[1], " "); got != "  Kimi Skills   3 skills" {
		t.Errorf("title row = %q, want %q", got, "  Kimi Skills   3 skills")
	}
	for _, want := range []string{
		"Kimi Code",
		"web-search",
		"Search the web",
		"翻译助手",
		"中英互译",
		"Plugin: demo",
		"↑/↓ Scroll · r Rescan · Esc Back · q Quit",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("skills view lacks %q", want)
		}
	}
	// Group header starts on its own line, after a blank separator between
	// groups (the Rust layout: blank before every group except the first).
	groupIdx := -1
	for i, r := range rows {
		if strings.TrimSpace(r) == "Kimi Code" {
			groupIdx = i
		}
	}
	if groupIdx == -1 {
		t.Fatalf("group header row not found")
	}
	if strings.TrimSpace(rows[groupIdx+1]) != "web-search" {
		t.Errorf("expected the first item under its group, got %q", rows[groupIdx+1])
	}
}

func TestSkillsViewScanning(t *testing.T) {
	m := newTestModel(t)
	m.view = ViewSkills
	m.skillsLoading = true
	joined := strings.Join(frameTexts(t, m), "\n")
	if !strings.Contains(joined, "Scanning...") {
		t.Errorf("loading summary missing: %q", joined)
	}
}

func TestSkillsViewCJKClippingKeepsWholeGlyphs(t *testing.T) {
	m := newTestModel(t)
	m.view = ViewSkills
	m.width = 20 // "  翻译助手" is 12 cells; force a description clip at a wide-glyph edge
	m.setSkills([]core.SkillInfo{
		{ID: "b", Name: "翻译助手", Description: "这是一条很长的中文描述需要被裁剪", Source: "Kimi Code"},
	})
	rows := frameTexts(t, m)
	for i, row := range rows {
		if strings.Contains(row, "\uFFFD") {
			t.Errorf("row %d split a wide glyph: %q", i, row)
		}
	}
}

func TestAssembleFramePinsFooterAndFillsHeight(t *testing.T) {
	p := core.Moondark
	rows := []Line{Line{Spans: []Span{{Text: "r0"}}}, Line{Spans: []Span{{Text: "r1"}}}}
	all := assembleFrame(rows, Line{Spans: []Span{{Text: "F"}}}, 10, 5, p.WindowBg)
	if len(all) != 5 {
		t.Fatalf("got %d rows, want 5", len(all))
	}
	if lineText(all[4]) != "F" {
		t.Errorf("footer not on the bottom row: %q", lineText(all[4]))
	}
	if strings.TrimSpace(lineText(all[2])) != "" || strings.TrimSpace(lineText(all[3])) != "" {
		t.Errorf("middle rows must be blank fill: %q %q", lineText(all[2]), lineText(all[3]))
	}
	// Too short: the body clips, the footer still fits.
	all = assembleFrame(rows, Line{Spans: []Span{{Text: "F"}}}, 10, 2, p.WindowBg)
	if len(all) != 2 || lineText(all[1]) != "F" {
		t.Errorf("short frame = %v", all)
	}
}

func TestDashboardKeepsPercentSuffix(t *testing.T) {
	// The limit<=0 guard can yield large raw percents; SPEC 12.2 displays
	// them unclamped and the pctW budget must keep the % suffix (the Go
	// counterpart of REVIEW-RUST Minor 4).
	m := newTestModel(t)
	m.quota = &core.QuotaResult{FiveHour: &core.QuotaSegment{Percent: 5000}}
	rows := frameTexts(t, m)
	if !strings.Contains(rows[2], "5000%") {
		t.Errorf("5-hour row = %q, want the %% suffix kept on 5000%%", rows[2])
	}
}

func TestSaveSettingsFailureKeepsDraftAndStays(t *testing.T) {
	// SPEC 13.2: a write failure keeps the draft and the form open —
	// returning to the dashboard would imply the settings were saved when
	// they were not, and the follow-up steps are skipped with the write.
	m := newTestModel(t)
	if _, cmd := m.Update(keyPress('s')); cmd != nil {
		t.Fatalf("opening settings returned a cmd")
	}
	blocked := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocked, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	m.configDir = blocked
	m.saveSettings()
	if m.view != ViewSettings {
		t.Errorf("view = %v, want the settings form to stay open on failure", m.view)
	}
	if m.settingsDraft == nil {
		t.Errorf("draft lost on save failure")
	}

	// REVIEW-RUST Suggestion 16: the failed attempt swaps the footer for the
	// failure hint — a failed save must never read as saved (SPEC 13.2).
	if !m.settingsSaveFailed {
		t.Errorf("save failure must raise the save-failed hint")
	}
	joined := strings.Join(frameTexts(t, m), "\n")
	if !strings.Contains(joined, settingsSaveFailedFooter) {
		t.Errorf("footer = %q, want the Save failed hint %q", joined, settingsSaveFailedFooter)
	}

	// Esc abandons the attempt: the hint clears with the draft (SPEC 13.2).
	m.Update(keyPress(tea.KeyEsc))
	if m.settingsSaveFailed {
		t.Errorf("Esc must clear the save-failed hint")
	}

	// Re-opening the form starts from a clean footer; a successful save
	// clears the hint too (stub the registry seam, never touch the HKCU key,
	// and point the config dir back at a writable directory).
	m.Update(keyPress('s'))
	if m.settingsSaveFailed {
		t.Errorf("re-opening the form must clear the save-failed hint")
	}
	restoreSeam := stubAutoStart(func(bool, string) {})
	defer restoreSeam()
	m.polling = core.NewPolling(core.PollingDeps{State: m.state})
	m.configDir = t.TempDir()
	m.saveSettings()
	if m.settingsSaveFailed {
		t.Errorf("a successful save must clear the save-failed hint")
	}
}
