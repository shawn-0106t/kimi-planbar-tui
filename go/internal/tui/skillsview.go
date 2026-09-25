// Read-only skills view (SPEC 21.3): "N skills" summary + rescan hint, rows
// grouped by source (case-insensitive name sort happens in core.ScanSkills),
// scrollable with the selected item kept in the viewport. Zero background
// cost: scan once on first open, cached in AppState; 'r' forces a rescan
// (SPEC 21.2). Layout translated from rust/src/ui/skills_view.rs.
package tui

import (
	"fmt"

	"github.com/shawn-0106t/kimi-planbar-tui/go/internal/core"
)

const skillsFooter = "↑/↓ Scroll · r Rescan · Esc Back · q Quit"

// SkillsRow is a flattened display row: a group header or a skill item.
type SkillsRow struct {
	IsGroup     bool
	Source      string // group header text
	Name        string // item only
	Description string // item only
}

// skillsView returns the content rows above the footer: blank, padded title,
// blank (3-row title block), blank (inner-rect top offset), then the visible
// portion of the list.
func skillsView(m *Model, p core.Palette) []Line {
	title := styledSpan("Kimi Skills", p.TextPrimary)
	title.Bold = true
	summary := fmt.Sprintf("%d skills", m.countSkillItems())
	if m.skillsLoading {
		summary = "Scanning..."
	}
	summarySpan := styledSpan("   "+summary, p.TextSecondary)

	rows := []Line{
		blankOf(p),
		{Spans: []Span{title, summarySpan}},
		blankOf(p),
		blankOf(p),
	}

	// Build one or two display lines per row; remember each row's first line.
	lines := []Line{}
	rowLine := make([]int, len(m.skillsRows))
	for idx, row := range m.skillsRows {
		rowLine[idx] = len(lines)
		switch {
		case row.IsGroup:
			if idx > 0 {
				lines = append(lines, blankOf(p))
			}
			s := styledSpan(row.Source, p.Accent)
			s.Bold = true
			lines = append(lines, Line{Spans: []Span{s}})
		default:
			name := styledSpan("  "+row.Name, p.TextPrimary)
			name.Bold = true
			desc := styledSpan("    "+row.Description, p.TextSecondary)
			if idx == m.skillsSel {
				name.Bg = p.ButtonHover
				desc.Bg = p.ButtonHover
			}
			lines = append(lines, Line{Spans: []Span{name}}, Line{Spans: []Span{desc}})
		}
	}

	// Keep the selected row's first line inside the viewport.
	viewport := m.height - 5 // 3 title rows + inner offset + footer
	if viewport < 0 {
		viewport = 0
	}
	selLine := 0
	if m.skillsSel >= 0 && m.skillsSel < len(rowLine) {
		selLine = rowLine[m.skillsSel]
	}
	total := len(lines)
	maxScroll := total - viewport
	if maxScroll < 0 {
		maxScroll = 0
	}
	scroll := 0
	if selLine >= viewport {
		scroll = selLine + 1 - viewport
		if scroll > maxScroll {
			scroll = maxScroll
		}
	}
	if scroll < 0 {
		scroll = 0
	}
	end := scroll + viewport
	if end > total {
		end = total
	}
	if scroll < end {
		rows = append(rows, lines[scroll:end]...)
	}
	return rows
}

// skillsFooterRow builds the pinned footer.
func skillsFooterRow(p core.Palette) Line {
	return Line{Spans: []Span{styledSpan(skillsFooter, p.TextSecondary)}}
}

// firstItem is the index of the first selectable row (group headers are not
// selectable); -1 when there is none.
func firstItem(rows []SkillsRow) int {
	for i, r := range rows {
		if !r.IsGroup {
			return i
		}
	}
	return -1
}

// moveSkillsSel moves the highlight to the next/previous item row, skipping
// group headers and wrapping (rust app.rs move_skills_sel).
func moveSkillsSel(rows []SkillsRow, sel, dir int) int {
	if len(rows) == 0 {
		return 0
	}
	i := sel
	for range len(rows) {
		i = ((i+dir)%len(rows) + len(rows)) % len(rows)
		if !rows[i].IsGroup {
			return i
		}
	}
	return sel
}

// countSkillItems counts selectable rows for the summary line.
func (m *Model) countSkillItems() int {
	n := 0
	for _, r := range m.skillsRows {
		if !r.IsGroup {
			n++
		}
	}
	return n
}

// flattenSkills turns a scan result into display rows (rust App::set_skills).
func flattenSkills(skills []core.SkillInfo) []SkillsRow {
	rows := []SkillsRow{}
	lastSource := ""
	for i, s := range skills {
		if i == 0 || lastSource != s.Source {
			rows = append(rows, SkillsRow{IsGroup: true, Source: s.Source})
		}
		lastSource = s.Source
		rows = append(rows, SkillsRow{Name: s.Name, Description: s.Description})
	}
	return rows
}
