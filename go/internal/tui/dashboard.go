// Main dashboard — plain wireframe, kimi `/usage` style (SPEC 12 content/copy):
//
//	Kimi Planbar TUI                       Updated HH:mm
//
//	5-hour usage   21%  █████░░░░░░░░░░░░  Resets in 4h 30m
//	Weekly usage   18%  ████░░░░░░░░░░░░  Resets in 5d 15h
//
//	Extra Usage    ¥12.34
//	  Used ¥45.67 this month / ¥100 limit
//
//	Kimi Code CLI  2.0.1  [Update available]
//
// No bordered cards, no per-card backgrounds: one line per data row. Rows are
// translated 1:1 from rust/src/ui/dashboard.rs; the vertical spacer between
// the version row and the footer is added by the frame assembler in app.go.
package tui

import (
	"fmt"
	"math"
	"strings"

	"github.com/shawn-0106t/kimi-planbar-tui/go/internal/core"
)

const dashboardFooter = "r Refresh · s Settings · k Skills · c Console · g Releases · q Quit"

// minBarW is the minimum bar width; below this the bar is dropped (very
// narrow terminals, SPEC 12.2).
const minBarW = 5

// dashboardSpec12_1 is the right side of the title row (SPEC 12.1).
func lastUpdatedText(m *Model) string {
	switch {
	case m.quota == nil:
		return ""
	case m.quota.Error != nil:
		return "Update failed"
	default:
		return core.FormatUpdated(m.quota.FetchedAt)
	}
}

// titleRow: "Kimi Planbar TUI" left, "Updated HH:mm" right-aligned in the
// last 16 columns (the Rust two-column layout with a Length(16) right rect).
func titleRow(m *Model, p core.Palette) Line {
	spans := []Span{styledSpan("Kimi Planbar TUI", p.TextPrimary)}
	spans[0].Bold = true
	updated := lastUpdatedText(m)
	if updated != "" && m.width > 16 {
		if pad := m.width - 16 - len("Kimi Planbar TUI"); pad > 0 {
			spans = append(spans, spanOf(strings.Repeat(" ", pad)))
		}
		// Right-justify in the 16-column field, like Alignment::Right there.
		spans = append(spans, styledSpan(fmt.Sprintf("%16s", updated), p.TextSecondary))
	}
	return Line{Spans: spans}
}

// barSpans: accent fill + dim track (SPEC 11.2: fill is always the accent
// color, no threshold-based color change).
func barSpans(p core.Palette, ratio float64, width int) []Span {
	filled := int(math.Round(ratio * float64(width)))
	if filled < 0 {
		filled = 0
	}
	if filled > width {
		filled = width
	}
	return []Span{
		{Text: strings.Repeat("█", filled), Fg: p.Accent},
		{Text: strings.Repeat("░", width-filled), Fg: p.ProgressTrack},
	}
}

// usageLine is one usage row (SPEC 12.2): "label  pct  bar  Resets in ...".
// seg == nil renders the "--" default with an empty bar.
func usageLine(m *Model, p core.Palette, width int, label string, seg *core.QuotaSegment, nowMs int64) Line {
	pctText := "--"
	reset := ""
	if seg != nil {
		pctText = core.FmtPercent(seg.Percent)
		if seg.ResetAt != nil {
			reset = core.FormatReset(*seg.ResetAt, nowMs)
		}
	}
	// The column budget is 4 cells; truncate rather than overflow the line (a
	// broken payload could otherwise push the reset text off-screen).
	pctRunes := []rune(pctText)
	if len(pctRunes) > 4 {
		pctRunes = pctRunes[:4]
	}
	pctText = fmt.Sprintf("%4s", string(pctRunes))

	spans := []Span{
		styledSpan(padLabel(label), p.TextSecondary),
		styledSpan(pctText, p.TextPrimary),
		spanOf("  "),
	}
	spans[1].Bold = true

	// The bar takes the space left after label + percent + reset text.
	used := labelW + 4 + 2
	if reset != "" {
		used += len(reset) + 2
	}
	barW := width - used
	if barW >= minBarW {
		// Display uses the raw percent; the bar uses the clamped value (SPEC 12.2).
		ratio := 0.0
		if seg != nil {
			ratio = core.ClampPercent(seg.Percent) / 100.0
		}
		spans = append(spans, barSpans(p, ratio, barW)...)
		spans = append(spans, spanOf("  "))
	}
	if reset != "" {
		spans = append(spans, styledSpan(reset, p.TextSecondary))
	}
	return Line{Spans: spans}
}

// extraLines is the Extra Usage row (SPEC 12.4): balance by three-state, then
// the optional monthly sub-line.
func extraLines(m *Model, p core.Palette) []Line {
	var extra *core.ExtraInfo
	if m.quota != nil {
		extra = m.quota.Extra
	}
	balance := "--"
	switch {
	case extra == nil:
	case extra.State == core.ExtraReady && extra.BalanceCents != nil:
		balance = core.FmtYuan(*extra.BalanceCents)
	case extra.State == core.ExtraNoData:
		balance = "No data"
	case extra.State == core.ExtraNotActivated:
		balance = "Not activated"
	}
	label := spanOf(padLabel("Extra Usage"))
	label.Fg = p.TextSecondary
	value := spanOf(balance)
	value.Fg = p.TextPrimary
	value.Bold = true
	lines := []Line{{Spans: []Span{label, value}}}

	// Monthly sub-line (SPEC 12.4): only when monthly enabled with a real
	// limit and a known used value.
	if extra != nil && extra.MonthlyEnabled &&
		extra.MonthlyLimitCents != nil && *extra.MonthlyLimitCents > 0 &&
		extra.MonthlyUsedCents != nil {
		lines = append(lines, Line{Spans: []Span{styledSpan(fmt.Sprintf(
			"  Used %s this month / %s limit",
			core.FmtYuan(*extra.MonthlyUsedCents), core.FmtYuan(*extra.MonthlyLimitCents),
		), p.TextSecondary)}})
	}
	return lines
}

// versionRow is the version line with the "Update available" badge (SPEC 12.6,
// SPEC 17.4).
func versionRow(m *Model, p core.Palette) Line {
	version := "--"
	if m.update != nil {
		if m.update.LocalVersion != nil {
			version = *m.update.LocalVersion
		} else {
			version = "Not detected"
		}
	}
	spans := []Span{
		styledSpan(padLabel("Kimi Code CLI"), p.TextSecondary),
		styledSpan(version, p.TextPrimary),
	}
	if m.update != nil && m.update.UpdateAvailable {
		spans = append(spans, spanOf("  "))
		spans = append(spans, Span{Text: " Update available ", Fg: p.BadgeFg, Bg: p.BadgeBg})
	}
	return Line{Spans: spans}
}

// dashboardView returns the content rows above the footer (the flexible
// spacer and the pinned footer are added by the frame assembler).
func dashboardView(m *Model, p core.Palette, nowMs int64) []Line {
	var fiveHour, week *core.QuotaSegment
	if m.quota != nil {
		fiveHour, week = m.quota.FiveHour, m.quota.Week
	}
	rows := []Line{
		titleRow(m, p),
		blankOf(p),
		usageLine(m, p, m.width, "5-hour usage", fiveHour, nowMs),
		usageLine(m, p, m.width, "Weekly usage", week, nowMs),
		blankOf(p),
	}
	extra := extraLines(m, p)
	rows = append(rows, extra...)
	if len(extra) > 1 {
		rows = append(rows, blankOf(p)) // blank after the monthly sub-line
	}
	rows = append(rows, blankOf(p), versionRow(m, p))
	return rows
}

// blankOf is an empty (width-padded later) row.
func blankOf(p core.Palette) Line { return Line{Spans: []Span{{Text: "", Bg: p.WindowBg}}} }
