// Settings form (plan section 4.3; options/defaults per SPEC 13.2):
// theme radio x3 (System default / Moonlit (light) / Moondark (dark)),
// interval radio x4 (1/5/10/30 min, default 5), autostart checkbox, Save.
// Save order: write JSON -> autostart -> theme -> reschedule timer (app.rs).

use crate::app::App;
use crate::theme::Palette;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Padding, Paragraph};
use ratatui::Frame;

const FOOTER: &str = "↑/↓ Move · ←/→ Change · Enter Save/Toggle · Esc Cancel";

const THEME_LABELS: [(&str, &str); 3] = [
    ("system", "System default"),
    ("light", "Moonlit (light)"),
    ("dark", "Moondark (dark)"),
];
const INTERVAL_LABELS: [(i64, &str); 4] = [(1, "1 min"), (5, "5 min"), (10, "10 min"), (30, "30 min")];

fn sel_style(selected: bool, p: &Palette) -> Style {
    if selected {
        Style::default().bg(p.button_hover).fg(p.text_primary)
    } else {
        Style::default().fg(p.text_primary)
    }
}

fn radio(selected_value: bool, row_selected: bool, label: &str, p: &Palette) -> Line<'static> {
    let mark = if selected_value { "(●)" } else { "( )" };
    let mark_style = if selected_value {
        Style::default().fg(p.accent)
    } else {
        Style::default().fg(p.text_secondary)
    };
    Line::from(vec![
        Span::styled(format!("{mark} "), mark_style),
        Span::styled(label.to_string(), sel_style(row_selected, p)),
    ])
}

pub fn draw(f: &mut Frame, app: &App, p: &Palette) {
    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(10),
        Constraint::Length(1),
    ])
    .split(f.area());

    // Title bar (SPEC 13.1 copy)
    let title = Paragraph::new(Line::from(Span::styled(
        "Kimi Planbar TUI Settings",
        Style::default().fg(p.text_primary).add_modifier(Modifier::BOLD),
    )))
    .block(Block::default().padding(Padding::new(2, 0, 1, 0)));
    f.render_widget(title, chunks[0]);

    let inner = Rect {
        x: chunks[1].x,
        y: chunks[1].y + 1,
        width: chunks[1].width,
        height: chunks[1].height.saturating_sub(1),
    };

    let Some(draft) = &app.settings_draft else {
        return;
    };

    let heading = |text: &str| {
        Line::from(Span::styled(
            text.to_string(),
            Style::default()
                .fg(p.text_secondary)
                .add_modifier(Modifier::BOLD),
        ))
    };
    let mut lines: Vec<Line> = vec![
        heading("Theme"),
        Line::raw(""),
    ];
    for (value, label) in THEME_LABELS {
        lines.push(radio(draft.theme == value, app.settings_sel == 0, label, p));
    }
    lines.push(Line::raw(""));
    lines.push(heading("Refresh interval"));
    lines.push(Line::raw(""));
    // Interval pills on one row (SPEC 13.2 horizontal StackPanel)
    let mut pill_spans: Vec<Span> = Vec::new();
    for (value, label) in INTERVAL_LABELS {
        let active = draft.refresh_minutes == value;
        let style = if active {
            Style::default().fg(ratatui::style::Color::White).bg(p.accent)
        } else {
            Style::default().fg(p.text_primary).bg(p.button_bg)
        };
        let style = if app.settings_sel == 1 {
            style.add_modifier(Modifier::UNDERLINED)
        } else {
            style
        };
        pill_spans.push(Span::styled(format!(" {label} "), style));
        pill_spans.push(Span::raw(" "));
    }
    lines.push(Line::from(pill_spans));
    lines.push(Line::raw(""));
    // Autostart checkbox
    let check = if draft.auto_start { "[x]" } else { "[ ]" };
    let check_style = if draft.auto_start {
        Style::default().fg(p.accent)
    } else {
        Style::default().fg(p.text_secondary)
    };
    lines.push(Line::from(vec![
        Span::styled(format!("{check} "), check_style),
        Span::styled("Launch at Windows startup", sel_style(app.settings_sel == 2, p)),
    ]));
    lines.push(Line::raw(""));
    // Save button
    let save_style = if app.settings_sel == 3 {
        Style::default().fg(ratatui::style::Color::White).bg(p.accent)
    } else {
        Style::default().fg(p.text_primary).bg(p.button_bg)
    };
    lines.push(Line::from(Span::styled(" Save ", save_style)));

    f.render_widget(Paragraph::new(lines), Rect { ..inner });

    f.render_widget(
        Paragraph::new(FOOTER).style(Style::default().fg(p.text_secondary)),
        chunks[2],
    );
}
