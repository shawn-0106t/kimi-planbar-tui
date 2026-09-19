// Read-only skills view (SPEC 21.3): top line "N skills" + rescan hint,
// groups by source (case-insensitive name sort within group, done in
// skills.rs::scan), scrollable. Zero background cost: scan once on first
// open, cached in AppState; 'r' forces a rescan (SPEC 21.2).

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

    // Keep the selected row's first line inside the viewport
    let viewport = inner.height as usize;
    let sel_line = row_line.get(app.skills_sel).copied().unwrap_or(0);
    let total = lines.len();
    let max_scroll = total.saturating_sub(viewport);
    let scroll = if sel_line >= viewport {
        (sel_line + 1).saturating_sub(viewport).min(max_scroll)
    } else {
        0
    };

    f.render_widget(
        Paragraph::new(lines).scroll((scroll as u16, 0)),
        Rect { ..inner },
    );

    f.render_widget(
        Paragraph::new(FOOTER).style(Style::default().fg(p.text_secondary)),
        chunks[2],
    );
}
