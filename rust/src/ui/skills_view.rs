// Read-only skills view (SPEC 21.3): top line "N skills" (the rescan hint
// lives in the footer), groups by source (case-insensitive name sort within
// group, done in skills.rs::scan), scrollable. Zero background cost: scan
// once on first open, cached in AppState; 'r' forces a rescan (SPEC 21.2).

use crate::app::App;
use crate::theme::Palette;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Padding, Paragraph};
use ratatui::Frame;

const FOOTER: &str = "↑/↓ Scroll · r Rescan · Esc Back · q Quit";

#[derive(Clone)]
pub enum Row {
    Group(String),
    Item { name: String, description: String },
}

/// Scroll offset keeping the selected item FULLY visible — its name line AND
/// description line (each item renders as two lines, SPEC 21.3). A selection
/// that already fits never scrolls; `max_scroll` pins the view to the last
/// page. The both-lines-visible invariant holds for viewport >= 2 (the view
/// layout's floor, `Min(3)` chunk minus one padding row); degenerate 0/1-row
/// viewports degrade gracefully to an in-range offset. The only call site
/// clamps to u16::MAX before `Paragraph::scroll` (REVIEW-RUST Suggestion 14).
/// Pure so the invariant is unit-testable (REVIEW-RUST Minor 11: the old +1
/// budget pinned the name row to the bottom edge and clipped the description
/// line right below the fold).
fn scroll_for(sel_line: usize, viewport: usize, max_scroll: usize) -> usize {
    (sel_line + 2).saturating_sub(viewport).min(max_scroll)
}

pub fn draw(f: &mut Frame, app: &App, p: &Palette) {
    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(3),
        Constraint::Length(1),
    ])
    .split(f.area());

    let n_items = app
        .skills_rows
        .iter()
        .filter(|r| matches!(r, Row::Item { .. }))
        .count();
    let summary = if app.skills_loading {
        "Scanning...".to_string()
    } else {
        format!("{n_items} skills")
    };
    let title = Line::from(vec![
        Span::styled(
            "Kimi Skills",
            Style::default().fg(p.text_primary).add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!("   {summary}"), Style::default().fg(p.text_secondary)),
    ]);
    f.render_widget(
        Paragraph::new(title).block(Block::default().padding(Padding::new(2, 0, 1, 0))),
        chunks[0],
    );

    let inner = Rect {
        x: chunks[1].x,
        y: chunks[1].y + 1,
        width: chunks[1].width,
        height: chunks[1].height.saturating_sub(1),
    };

    // Build one display line per row; items get a name line + description line.
    let mut lines: Vec<Line> = Vec::new();
    // Map: display line index of each skills_rows entry (first line of it)
    let mut row_line: Vec<usize> = Vec::new();
    for (idx, row) in app.skills_rows.iter().enumerate() {
        row_line.push(lines.len());
        match row {
            Row::Group(source) => {
                if idx > 0 {
                    lines.push(Line::raw(""));
                }
                lines.push(Line::from(Span::styled(
                    source.clone(),
                    Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
                )));
            }
            Row::Item { name, description } => {
                let selected = idx == app.skills_sel;
                let name_style = if selected {
                    Style::default()
                        .fg(p.text_primary)
                        .bg(p.button_hover)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(p.text_primary).add_modifier(Modifier::BOLD)
                };
                let desc_style = if selected {
                    Style::default().fg(p.text_secondary).bg(p.button_hover)
                } else {
                    Style::default().fg(p.text_secondary)
                };
                lines.push(Line::from(Span::styled(format!("  {name}"), name_style)));
                lines.push(Line::from(Span::styled(format!("    {description}"), desc_style)));
            }
        }
    }

    // Keep the selected item's name AND description lines inside the viewport
    let viewport = inner.height as usize;
    let sel_line = row_line.get(app.skills_sel).copied().unwrap_or(0);
    let total = lines.len();
    let max_scroll = total.saturating_sub(viewport);
    let scroll = scroll_for(sel_line, viewport, max_scroll);

    f.render_widget(
        Paragraph::new(lines).scroll((scroll.min(u16::MAX as usize) as u16, 0)),
        Rect { ..inner },
    );

    f.render_widget(
        Paragraph::new(FOOTER).style(Style::default().fg(p.text_secondary)),
        chunks[2],
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// REVIEW-RUST Minor 11: while the selected item (name + description,
    /// two lines) already fits the viewport, the view must not scroll.
    #[test]
    fn scroll_unchanged_while_selection_fits() {
        assert_eq!(scroll_for(0, 5, 10), 0);
        assert_eq!(scroll_for(3, 5, 10), 0); // name 3 + desc 4 fit rows 0..=4
    }

    /// REVIEW-RUST Minor 11 regression: the old +1 budget kept only the name
    /// row visible — paging down clipped the description line below the fold.
    #[test]
    fn scroll_shows_name_and_description() {
        // Name on the last visible row: one line of scroll reveals the description
        assert_eq!(scroll_for(4, 5, 10), 1);
        // Paged past the bottom: name and description end on the last two rows
        assert_eq!(scroll_for(7, 5, 10), 4);
    }

    /// max_scroll pins the view to the last page while both selected lines
    /// stay visible; out-of-range selections and short lists clamp safely.
    #[test]
    fn scroll_clamps_to_max() {
        assert_eq!(scroll_for(6, 5, 3), 3); // last page rows 3..=7: name 6, desc 7 visible
        assert_eq!(scroll_for(50, 5, 3), 3); // out-of-range selection clamps
        assert_eq!(scroll_for(0, 5, 0), 0); // short list, nothing to scroll
    }
}
