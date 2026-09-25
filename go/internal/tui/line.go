// Pure line model shared by the views (SPEC 12): the views emit []Line, and
// the bubbletea adapter (app.go View) turns them into one styled string per
// frame. It is the Go counterpart of ts/src/tui/line.ts.
//
// Constraints carried over from the Bun edition (SPEC 22.5) and PLAN-GO §4.3:
//   - nothing fills the screen background for us (no ratatui Block::bg), so
//     every row is clipped and padded to the full width with a window_bg
//     filler run, and the frame is filled to the full height (padLineToWidth);
//   - cell widths follow East Asian Width with ambiguous glyphs at 1 cell —
//     the ratatui default — so the clipping below and the renderer's own cell
//     accounting stay consistent for CJK skill names (SPEC 21.3);
//   - sanitize() is the injection firewall: lipgloss does not filter control
//     characters, so every external string (skill names/descriptions, version
//     output, API error text) passes it before entering a frame.
package tui

import (
	"fmt"
	"regexp"
	"strings"
	"sync"

	"charm.land/lipgloss/v2"
	"github.com/mattn/go-runewidth"
)

// Span is one styled run; empty Fg/Bg mean the terminal default.
type Span struct {
	Text      string
	Fg        string // #RRGGBB from the palette (SPEC 11.1)
	Bg        string
	Bold      bool
	Underline bool // SPEC 13.2 selected interval pills
}

// Line is one display row.
type Line struct {
	Spans []Span
}

// spanOf builds an unstyled span.
func spanOf(text string) Span { return Span{Text: text} }

// styledSpan builds a foreground-styled span.
func styledSpan(text, fg string) Span { return Span{Text: text, Fg: fg} }

// widthCond is a fixed-width condition: ambiguous-width glyphs stay at 1 cell
// regardless of RUNEWIDTH_EASTASIAN / locale (the ratatui unicode-width
// default the Rust oracle renders with; SPEC 21.3).
var widthCond = runewidth.Condition{EastAsianWidth: false, StrictEmojiNeutral: true, ZeroWidthJoiner: true}

// runeWidth is the terminal cell width of one code point.
func runeWidth(r rune) int { return widthCond.RuneWidth(r) }

// displayWidth is the terminal cell width of a run; unlike len() this is
// correct for the CJK names and descriptions the skills view renders.
func displayWidth(text string) int { return widthCond.StringWidth(text) }

// lineWidth is the cell width of a whole line.
func lineWidth(line Line) int {
	w := 0
	for _, s := range line.Spans {
		w += displayWidth(s.Text)
	}
	return w
}

// lineText is the plain text of a line — what snapshot tests compare.
func lineText(line Line) string {
	var b strings.Builder
	for _, s := range line.Spans {
		b.WriteString(s.Text)
	}
	return b.String()
}

// truncateToCells takes the first `cells` cells of a run. Iterating code
// points keeps a 2-cell glyph that straddles the edge from being split — a
// wide character that does not fit the last cell is dropped whole, matching
// the ratatui buffer (SPEC 21.3) and ts truncateToCells.
func truncateToCells(text string, cells int) string {
	var out strings.Builder
	used := 0
	for _, r := range text {
		w := runeWidth(r)
		if used+w > cells {
			break
		}
		out.WriteRune(r)
		used += w
	}
	return out.String()
}

// ansiRe matches whole ANSI escape sequences: CSI, OSC (BEL- or ST-terminated)
// and the two-character C1 escapes — stripped first so a sequence split across
// the later control purge cannot reassemble (same rules and order as
// ts/src/tui/line.ts sanitize, SPEC 22.5).
var ansiRe = regexp.MustCompile(`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])`)

// ctrlRe matches leftover C0 controls, DEL and C1.
var ctrlRe = regexp.MustCompile(`[\x00-\x1f\x7f-\x9f]`)

// sanitize strips everything that could move the cursor or change terminal
// state from an external string (SPEC 22.5 injection firewall).
func sanitize(text string) string {
	return ctrlRe.ReplaceAllString(ansiRe.ReplaceAllString(text, ""), "")
}

// sanitizeSpans sanitizes every span's text; runs emptied by the stripping
// are dropped.
func sanitizeSpans(line Line) Line {
	spans := make([]Span, 0, len(line.Spans))
	changed := false
	for _, s := range line.Spans {
		text := sanitize(s.Text)
		if text == "" {
			changed = true
			continue
		}
		if text != s.Text {
			changed = true
			s.Text = text
		}
		spans = append(spans, s)
	}
	if !changed {
		return line
	}
	return Line{Spans: spans}
}

// padLineToWidth brings a line to exactly `width` cells: clip the overflow
// (the renderer would otherwise wrap a too-long row onto the next one) and
// append a window_bg filler run so the row paints edge to edge. This is the
// render-path choke point where every external string passes sanitize().
func padLineToWidth(line Line, width int, windowBg string) Line {
	line = sanitizeSpans(line)
	spans := line.Spans
	used := lineWidth(line)
	if used > width {
		spans = make([]Span, 0, len(line.Spans))
		used = 0
		for _, s := range line.Spans {
			if used >= width {
				break
			}
			keep := truncateToCells(s.Text, width-used)
			if keep != "" {
				s.Text = keep
				spans = append(spans, s)
				used += displayWidth(keep)
			}
		}
	}
	if filler := width - used; filler > 0 {
		spans = append(spans, Span{Text: strings.Repeat(" ", filler), Bg: windowBg})
	}
	return Line{Spans: spans}
}

// blankLine is a fully-blank window_bg row (fills the vertical gap).
func blankLine(width int, windowBg string) Line {
	return Line{Spans: []Span{{Text: strings.Repeat(" ", width), Bg: windowBg}}}
}

// styleCache memoizes lipgloss styles per (fg,bg,bold,underline) key. Views
// re-render the same handful of palette combinations every frame.
var (
	styleCacheMu sync.Mutex
	styleCache   = map[string]lipgloss.Style{}
)

func styleFor(s Span) lipgloss.Style {
	key := fmt.Sprintf("%s|%s|%t|%t", s.Fg, s.Bg, s.Bold, s.Underline)
	styleCacheMu.Lock()
	defer styleCacheMu.Unlock()
	if st, ok := styleCache[key]; ok {
		return st
	}
	st := lipgloss.NewStyle()
	if s.Fg != "" {
		st = st.Foreground(lipgloss.Color(s.Fg))
	}
	if s.Bg != "" {
		st = st.Background(lipgloss.Color(s.Bg))
	}
	if s.Bold {
		st = st.Bold(true)
	}
	if s.Underline {
		st = st.Underline(true)
	}
	styleCache[key] = st
	return st
}

// renderLine renders one (already padded) line into an ANSI string for the
// bubbletea View content.
func renderLine(line Line) string {
	var b strings.Builder
	for _, s := range line.Spans {
		if s.Text == "" {
			continue
		}
		b.WriteString(styleFor(s).Render(s.Text))
	}
	return b.String()
}

// labelW is the column width for the dashboard row labels ("5-hour usage" /
// "Kimi Code CLI" fit); mirrored from rust/src/ui/dashboard.rs LABEL_W.
const labelW = 14

// padLabel right-pads a row label to the label column (ASCII labels, so the
// Rust `{:<LABEL_W$}` byte/char distinction does not matter here).
func padLabel(label string) string {
	return fmt.Sprintf("%-*s", labelW, label)
}
