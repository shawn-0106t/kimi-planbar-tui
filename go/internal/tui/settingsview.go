// Settings form (SPEC 13.2): theme radio x3 (System default / Moonlit
// (light) / Moondark (dark)), interval pills x4 (1/5/10/30 min, default 5),
// autostart checkbox, Save. Save order — write JSON -> autostart -> theme ->
// reschedule timer — lives in app.go saveSettings, mirroring rust app.rs.
// Row layout translated from rust/src/ui/settings_view.rs; the layout budget
// (REVIEW-RUST Major B) is 9 content lines so the whole form — checkbox,
// Save, footer — stays visible at the 72×13 minimal window (SPEC 20).
package tui

import (
	"github.com/shawn-0106t/kimi-planbar-tui/go/internal/core"
)

const settingsFooter = "↑/↓ Move · ←/→ Change · Enter Save/Toggle · Esc Cancel · q Quit"

// settingsSaveFailedFooter is the footer swapped in while a save attempt
// failed (SPEC 13.2: a failed save must never read as saved and must not be
// a silent dead key either); the normal footer returns on the next save
// attempt, Esc, or form re-open.
const settingsSaveFailedFooter = "Save failed — could not write settings.json · Esc Cancel · q Quit"

type themeLabel struct{ value, label string }

var themeLabels = [3]themeLabel{
	{"system", "System default"},
	{"light", "Moonlit (light)"},
	{"dark", "Moondark (dark)"},
}

type intervalLabel struct {
	value int64
	label string
}

var intervalLabels = [4]intervalLabel{
	{1, "1 min"}, {5, "5 min"}, {10, "10 min"}, {30, "30 min"},
}

// selStyle highlights the row the cursor is on.
func selStyle(selected bool, p core.Palette) Span {
	if selected {
		return Span{Fg: p.TextPrimary, Bg: p.ButtonHover}
	}
	return Span{Fg: p.TextPrimary}
}

// radioLine is one radio row: "(●)" / "( )" + label.
func radioLine(selectedValue, rowSelected bool, label string, p core.Palette) Line {
	mark := "( )"
	markFg := p.TextSecondary
	if selectedValue {
		mark = "(●)"
		markFg = p.Accent
	}
	labelSpan := selStyle(rowSelected, p)
	labelSpan.Text = label
	return Line{Spans: []Span{
		{Text: mark + " ", Fg: markFg},
		labelSpan,
	}}
}

// headingLine is a section heading (bold secondary).
func headingLine(text string, p core.Palette) Line {
	s := styledSpan(text, p.TextSecondary)
	s.Bold = true
	return Line{Spans: []Span{s}}
}

// settingsView returns the content rows above the footer: blank, padded
// title, blank (the 3-row title block's padding rows), then the 9 form lines.
// The content starts right below the title block — its bottom row already
// acts as the spacer, so there is no extra inner-rect offset here (the old
// +1 cost a row the minimal window does not have, REVIEW-RUST Major B).
func settingsView(m *Model, p core.Palette) []Line {
	title := styledSpan("  Kimi Planbar TUI Settings", p.TextPrimary)
	title.Bold = true

	rows := []Line{
		blankOf(p),
		{Spans: []Span{title}},
		blankOf(p),
	}

	if m.settingsDraft == nil {
		return rows
	}
	draft := m.settingsDraft

	rows = append(rows, headingLine("Theme", p), blankOf(p))
	for _, tl := range themeLabels {
		rows = append(rows, radioLine(draft.Theme == tl.value, m.settingsSel == 0, tl.label, p))
	}
	// No spacer lines between groups beyond the one above: the form must fit
	// the 9 content rows above the footer at the 72×13 minimal window
	// (REVIEW-RUST Major B).
	rows = append(rows, headingLine("Refresh interval", p))

	// Interval pills on one row (SPEC 13.2 horizontal StackPanel).
	var pillSpans []Span
	for _, il := range intervalLabels {
		pill := Span{Text: " " + il.label + " ", Bg: p.ButtonBg, Fg: p.TextPrimary}
		if draft.RefreshMinutes == il.value {
			pill.Fg = "#FFFFFF" // ratatui Color::White on the accent pill
			pill.Bg = p.Accent
		}
		if m.settingsSel == 1 {
			pill.Underline = true
		}
		pillSpans = append(pillSpans, pill, spanOf(" "))
	}
	rows = append(rows, Line{Spans: pillSpans})

	// Autostart checkbox.
	check := "[ ]"
	checkFg := p.TextSecondary
	if draft.AutoStart {
		check = "[x]"
		checkFg = p.Accent
	}
	labelSpan := selStyle(m.settingsSel == 2, p)
	labelSpan.Text = "Launch at Windows startup"
	rows = append(rows, Line{Spans: []Span{
		{Text: check + " ", Fg: checkFg},
		labelSpan,
	}})

	// Save button.
	save := Span{Text: " Save ", Bg: p.ButtonBg, Fg: p.TextPrimary}
	if m.settingsSel == 3 {
		save.Fg = "#FFFFFF"
		save.Bg = p.Accent
	}
	rows = append(rows, Line{Spans: []Span{save}})
	return rows
}

// cycle moves through the options wrapping in `dir` (rust app.rs cycle).
func cycleI64(options []int64, current int64, dir int) int64 {
	idx := 0
	for i, o := range options {
		if o == current {
			idx = i
			break
		}
	}
	return options[((idx+dir)%len(options)+len(options))%len(options)]
}

func cycleStr(options []string, current string, dir int) string {
	idx := 0
	for i, o := range options {
		if o == current {
			idx = i
			break
		}
	}
	return options[((idx+dir)%len(options)+len(options))%len(options)]
}

var themeValues = []string{"system", "light", "dark"}
var intervalValues = []int64{1, 5, 10, 30}

// settingsFooterRow builds the pinned footer; a failed save swaps in the
// failure hint until the next attempt, Esc, or form re-open (SPEC 13.2,
// rust/src/ui/settings_view.rs settings_save_failed).
func settingsFooterRow(m *Model, p core.Palette) Line {
	text := settingsFooter
	if m.settingsSaveFailed {
		text = settingsSaveFailedFooter
	}
	return Line{Spans: []Span{styledSpan(text, p.TextSecondary)}}
}
