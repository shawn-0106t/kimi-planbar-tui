// Settings form (plan section 4.3; options/defaults per SPEC 13.2):
// theme radio x3 (System default / Moonlit (light) / Moondark (dark)),
// interval radio x4 (1/5/10/30 min, default 5), autostart checkbox, Save.
// Save order: write JSON -> autostart -> theme -> reschedule timer (app.rs).
// Layout budget (REVIEW-RUST Major B): 9 content lines so the whole form —
// checkbox, Save, footer — stays visible at the 72×13 minimal window.

use crate::app::App;
use crate::theme::Palette;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Padding, Paragraph};
use ratatui::Frame;

const FOOTER: &str = "↑/↓ Move · ←/→ Change · Enter Save/Toggle · Esc Cancel · q Quit";

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
    // Min(8) + fixed footer: at the 72×13 minimal window (SPEC 20) the old
    // Min(10) let the solver collapse the footer chunk to zero height and
    // clipped the form's last rows (REVIEW-RUST Major B). 3 + 9 + 1 = 13.
    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(8),
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

    // Content starts right below the title chunk: its bottom row already
    // acts as the spacer, so no extra shift here (the old +1 cost a row the
    // minimal window does not have, REVIEW-RUST Major B).
    let inner = chunks[1];

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
    // No spacer lines between groups beyond the one above: the form must fit
    // the 9 inner rows of the 72×13 minimal window (REVIEW-RUST Major B).
    lines.push(heading("Refresh interval"));
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
    // Save button
    let save_style = if app.settings_sel == 3 {
        Style::default().fg(ratatui::style::Color::White).bg(p.accent)
    } else {
        Style::default().fg(p.text_primary).bg(p.button_bg)
    };
    lines.push(Line::from(Span::styled(" Save ", save_style)));

    f.render_widget(Paragraph::new(lines), Rect { ..inner });

    // A failed Save swaps the footer for a hint until the next attempt,
    // Esc, or form re-open (SPEC 13.2: a failed save must never read as
    // saved, and must not be a silent dead key either).
    let footer = if app.settings_save_failed {
        "Save failed — could not write settings.json · Esc Cancel · q Quit"
    } else {
        FOOTER
    };
    f.render_widget(
        Paragraph::new(footer).style(Style::default().fg(p.text_secondary)),
        chunks[2],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::SettingsData;
    use crate::state::AppState;
    use crate::theme;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::sync::Arc;

    fn frame_text(app: &App, width: u16, height: u16) -> String {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, app, &theme::palette("dark"))).unwrap();
        let buffer = terminal.backend().buffer();
        (0..height)
            .map(|y| {
                (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn settings_app() -> App {
        let mut app = App::new(Arc::new(AppState::new(SettingsData::default(), "dark".to_string())));
        app.settings_draft = Some(SettingsData::default());
        app.settings_sel = 3; // Save row selected
        app
    }

    /// REVIEW-RUST Major B + Suggestion 18 regression: at the SPEC 20 minimal
    /// window (72×13) the whole form — interval pills, autostart checkbox,
    /// Save action row — and the footer must be visible. The old 13-line form
    /// clipped its last four rows and the layout collapsed the footer chunk
    /// to zero height.
    #[test]
    fn settings_form_fits_minimal_window() {
        let screen = frame_text(&settings_app(), 72, 13);
        assert!(screen.contains("1 min"), "interval pills clipped:\n{screen}");
        assert!(
            screen.contains("Launch at Windows startup"),
            "checkbox clipped:\n{screen}"
        );
        // " Save " with surrounding spaces is the action row; the footer's
        // "Enter Save/Toggle" must not satisfy this assert.
        assert!(screen.contains(" Save "), "Save row clipped:\n{screen}");
        assert!(screen.contains("q Quit"), "footer clipped:\n{screen}");
    }
}
