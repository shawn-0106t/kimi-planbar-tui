package tui

import (
	"strings"
	"testing"
)

func TestSanitizeStripsANSISequences(t *testing.T) {
	cases := map[string]string{
		"\x1b[31mred\x1b[0m":       "red",       // CSI SGR in and out
		"\x1b]0;title\x07after":    "after",     // OSC, BEL-terminated
		"\x1b]0;title\x1b\\after":  "after",     // OSC, ST-terminated
		"a\x1bKb":                  "ab",        // two-char escape
		"plain":                    "plain",     // untouched
		"\x00\x07\x1f\u007f\u009f": "",          // C0 / DEL / C1 (as code points)
		"\x1b[38;5;9mX\x1b[m":      "X",         // long CSI params
		"skill\x1b[2Jname":         "skillname", // CSI would clear the screen
		"\uFFFD":                   "\uFFFD",    // printable replacement char survives
		"\x1b[31m\x1b[32m\x1b[0m":  "",          // stacked sequences
		"\x1b[1":                   "[1",        // truncated CSI: ESC purged, tail degrades to text (TS-oracle behavior)
	}
	for in, want := range cases {
		if got := sanitize(in); got != want {
			t.Errorf("sanitize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSanitizeDegradesLikeTheTSOracle(t *testing.T) {
	// The Rust/TS pipeline never leaves an ESC byte behind: anything the
	// sequence grammar cannot consume is stripped as a bare control.
	for _, in := range []string{"\x1b", "\x1b[", "\x1b[?2004"} {
		if got := sanitize(in); got != strings.TrimLeft(in, "\x1b") {
			t.Errorf("sanitize(%q) = %q, want no ESC byte", in, got)
		}
	}
}

func TestDisplayWidthEAW(t *testing.T) {
	cases := map[string]int{
		"abc":     3,
		"技能":      4, // CJK ideographs: 2 cells each (SPEC 21.3)
		"한국어":     6, // Hangul: wide
		"，":       2, // fullwidth comma: 2 cells
		"·":       1, // ambiguous-width glyphs stay 1 cell (ratatui default)
		"¥":       1,
		"█░":      2,
		"e\u0301": 1, // combining acute occupies no cell
	}
	for in, want := range cases {
		if got := displayWidth(in); got != want {
			t.Errorf("displayWidth(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestTruncateToCellsDropsStraddlingWideGlyph(t *testing.T) {
	// "技能ab" at 3 cells: the second 技 does not fit the last cell and is
	// dropped whole, never split.
	if got := truncateToCells("技能ab", 3); got != "技" {
		t.Errorf("truncateToCells = %q, want %q", got, "技")
	}
	if got := truncateToCells("abc", 5); got != "abc" {
		t.Errorf("truncateToCells = %q, want %q", got, "abc")
	}
}

func TestPadLineToWidthClipsAndPads(t *testing.T) {
	line := Line{Spans: []Span{
		{Text: "技能ab", Fg: "#FF0000"},
		{Text: "cd"},
	}}
	// Clip: the overflow is cut (never wrapped); the kept part keeps its style.
	got := padLineToWidth(line, 5, "#101010")
	if text := lineText(got); text != "技能a" {
		t.Errorf("clipped text = %q, want %q", text, "技能a")
	}
	if w := lineWidth(got); w != 5 {
		t.Errorf("clipped width = %d, want 5", w)
	}
	if got.Spans[0].Fg != "#FF0000" {
		t.Errorf("first span lost its fg: %+v", got.Spans[0])
	}

	// Shorter than width: padded to exactly the width with a window_bg filler.
	padded := padLineToWidth(Line{Spans: []Span{{Text: "ab"}}}, 4, "#101010")
	if text := lineText(padded); text != "ab  " || lineWidth(padded) != 4 {
		t.Errorf("padded = %q (%d cells), want %q (4 cells)", lineText(padded), lineWidth(padded), "ab  ")
	}
	filler := padded.Spans[len(padded.Spans)-1]
	if filler.Bg != "#101010" || filler.Text != "  " {
		t.Errorf("filler = %+v, want 2 spaces with window_bg", filler)
	}
}

func TestPadLineToWidthIsTheInjectionFirewall(t *testing.T) {
	// External strings (a hostile skill name here) must not be able to move
	// the cursor or change terminal state through a frame (SPEC 22.5).
	hostile := Line{Spans: []Span{{Text: "\x1b[31m\x1b]0;pwned\x07skill\x1b[2J\x07name"}}}
	got := padLineToWidth(hostile, 80, "#101010")
	if text := strings.TrimRight(lineText(got), " "); text != "skillname" {
		t.Errorf("sanitized = %q, want %q (plus width filler)", text, "skillname")
	}
	for _, s := range got.Spans {
		if strings.ContainsAny(s.Text, "\x1b\x07") {
			t.Errorf("escape byte survived in span %q", s.Text)
		}
	}
}

func TestRenderLineProducesStyledText(t *testing.T) {
	line := padLineToWidth(Line{Spans: []Span{
		{Text: "ab", Bold: true, Fg: "#1A88FF"},
	}}, 4, "#17191E")
	out := renderLine(line)
	if !strings.Contains(out, "ab") || !strings.Contains(out, "\x1b[") {
		t.Errorf("renderLine lost text or produced no styling: %q", out)
	}
	if strings.Contains(out, "\x1b[2K") || strings.Contains(out, "\x1b[0J") {
		t.Errorf("unexpected clearing sequence in %q", out)
	}
}
