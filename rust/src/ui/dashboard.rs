// Main dashboard — plain wireframe, kimi `/usage` style (SPEC 12 content/copy):
//
//   Kimi Planbar TUI                       Updated HH:mm
//
//   5-hour usage   21%  █████░░░░░░░░░░░  Resets in 4h 30m
//   Weekly usage   18%  ████░░░░░░░░░░░░  Resets in 5d 15h
//
//   Extra Usage    ¥12.34
//     Used ¥45.67 this month / ¥100 limit
//
//   Kimi Code CLI  2.0.1  [Update available]
//
//   r Refresh · s Settings · k Skills · c Console · g Releases · q Quit
//
// No bordered cards, no per-card backgrounds: one line per data row, so the
// layout also fits short terminals (each row is a fixed 1-line constraint).

use crate::app::App;
use crate::format::{clamp_percent, fmt_percent, fmt_yuan, format_reset};
use crate::quota::{ExtraState, QuotaSegment};
use crate::theme::Palette;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

const FOOTER: &str = "r Refresh · s Settings · k Skills · c Console · g Releases · q Quit";
/// Column width for the row labels ("5-hour usage" / "Kimi Code CLI" fit).
const LABEL_W: usize = 14;
/// Minimum bar width; below this the bar is dropped (very narrow terminals).
const MIN_BAR_W: usize = 5;

/// SPEC 12.1: right side of the title row.
fn last_updated_text(app: &App) -> String {
    match &app.quota {
        None => String::new(),
        Some(q) if q.error.is_some() => "Update failed".to_string(),
        Some(q) => format!("Updated {}", q.fetched_at.format("%H:%M")),
    }
}

fn draw_title(f: &mut Frame, app: &App, p: &Palette, area: Rect) {
    let cols = Layout::horizontal([Constraint::Min(10), Constraint::Length(16)]).split(area);
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            "Kimi Planbar TUI",
            Style::default().fg(p.text_primary).add_modifier(Modifier::BOLD),
        ))),
        cols[0],
    );
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            last_updated_text(app),
            Style::default().fg(p.text_secondary),
        )))
        .alignment(Alignment::Right),
        cols[1],
    );
}

/// Text bar spans: accent fill + dim track (SPEC 11.2: fill is always the
/// accent color, no threshold-based color change).
fn bar_spans(p: &Palette, ratio: f64, width: usize) -> Vec<Span<'static>> {
    let filled = (ratio.clamp(0.0, 1.0) * width as f64).round() as usize;
    vec![
        Span::styled("█".repeat(filled), Style::default().fg(p.accent)),
        Span::styled("░".repeat(width - filled), Style::default().fg(p.progress_track)),
    ]
}

/// One usage row (SPEC 12.2): "label  pct  bar  Resets in ...".
/// `seg == None` renders the "--" default with an empty bar.
fn usage_line(p: &Palette, width: usize, label: &str, seg: Option<&QuotaSegment>) -> Line<'static> {
    let pct_text = seg.map(|s| fmt_percent(s.percent)).unwrap_or_else(|| "--".to_string());
    // The column budget is 4 cells; truncate rather than overflow the line
    // (a broken payload could otherwise push the reset text off-screen).
    let pct_text: String = pct_text.chars().take(4).collect();
    let reset = seg
        .and_then(|s| s.reset_at)
        .map(format_reset)
        .unwrap_or_default();

    let mut spans = vec![
        Span::styled(format!("{label:<LABEL_W$}"), Style::default().fg(p.text_secondary)),
        Span::styled(
            format!("{pct_text:>4}"),
            Style::default().fg(p.text_primary).add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
    ];

    // Bar takes the space left after label + percent + reset text.
    let used = LABEL_W + 4 + 2 + if reset.is_empty() { 0 } else { reset.len() + 2 };
    let bar_w = width.saturating_sub(used);
    if bar_w >= MIN_BAR_W {
        // Display uses the raw percent; the bar uses the clamped value (SPEC 12.2).
        let ratio = seg.map(|s| clamp_percent(s.percent) / 100.0).unwrap_or(0.0);
        spans.extend(bar_spans(p, ratio, bar_w));
        spans.push(Span::raw("  "));
    }
    if !reset.is_empty() {
        spans.push(Span::styled(reset, Style::default().fg(p.text_secondary)));
    }
    Line::from(spans)
}

/// SPEC 12.4: Extra Usage line — balance value by three-state, then the
/// optional monthly line ("Used ¥x this month / ¥y limit").
fn extra_lines(app: &App, p: &Palette) -> Vec<Line<'static>> {
    let extra = app.quota.as_ref().and_then(|q| q.extra.as_ref());
    let balance = match extra {
        None => "--".to_string(),
        Some(e) => match e.state {
            ExtraState::Ready => e.balance_cents.map(fmt_yuan).unwrap_or_else(|| "--".to_string()),
            ExtraState::NoData => "No data".to_string(),
            ExtraState::NotActivated => "Not activated".to_string(),
        },
    };
    let mut lines = vec![Line::from(vec![
        Span::styled(
            format!("{:<LABEL_W$}", "Extra Usage"),
            Style::default().fg(p.text_secondary),
        ),
        Span::styled(
            balance,
            Style::default().fg(p.text_primary).add_modifier(Modifier::BOLD),
        ),
    ])];

    // Monthly sub-line (SPEC 12.4): only when monthly enabled with a real
    // limit and a known used value.
    if let Some(e) = extra {
        if e.monthly_enabled && e.monthly_limit_cents.unwrap_or(0) > 0 && e.monthly_used_cents.is_some() {
            lines.push(Line::from(Span::styled(
                format!(
                    "  Used {} this month / {} limit",
                    fmt_yuan(e.monthly_used_cents.unwrap_or(0)),
                    fmt_yuan(e.monthly_limit_cents.unwrap_or(1))
                ),
                Style::default().fg(p.text_secondary),
            )));
        }
    }
    lines
}

/// SPEC 12.6: version line with the "Update available" badge (SPEC 17.4).
fn version_line(app: &App, p: &Palette) -> Line<'static> {
    let version = match &app.update {
        None => "--".to_string(),
        Some(u) => u.local_version.clone().unwrap_or_else(|| "Not detected".to_string()),
    };
    let mut spans = vec![
        Span::styled(
            format!("{:<LABEL_W$}", "Kimi Code CLI"),
            Style::default().fg(p.text_secondary),
        ),
        Span::styled(version, Style::default().fg(p.text_primary)),
    ];
    if app.update.as_ref().map(|u| u.update_available).unwrap_or(false) {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(
            " Update available ",
            Style::default().fg(p.badge_fg).bg(p.badge_bg),
        ));
    }
    Line::from(spans)
}

pub fn draw(f: &mut Frame, app: &App, p: &Palette) {
    let monthly_shown = app
        .quota
        .as_ref()
        .and_then(|q| q.extra.as_ref())
        .map(|e| e.monthly_enabled && e.monthly_limit_cents.unwrap_or(0) > 0 && e.monthly_used_cents.is_some())
        .unwrap_or(false);
    let monthly_h = if monthly_shown { 1 } else { 0 };

    let chunks = Layout::vertical([
        Constraint::Length(1),          // title
        Constraint::Length(1),          // blank
        Constraint::Length(1),          // 5-hour usage
        Constraint::Length(1),          // weekly usage
        Constraint::Length(1),          // blank
        Constraint::Length(1),          // Extra Usage
        Constraint::Length(monthly_h),  // monthly sub-line (optional)
        Constraint::Length(1),          // blank
        Constraint::Length(1),          // Kimi Code CLI version
        Constraint::Min(0),             // spacer
        Constraint::Length(1),          // footer
    ])
    .split(f.area());

    draw_title(f, app, p, chunks[0]);

    let (five_hour, week) = match &app.quota {
        Some(q) => (q.five_hour.as_ref(), q.week.as_ref()),
        None => (None, None),
    };
    f.render_widget(
        Paragraph::new(usage_line(p, chunks[2].width as usize, "5-hour usage", five_hour)),
        chunks[2],
    );
    f.render_widget(
        Paragraph::new(usage_line(p, chunks[3].width as usize, "Weekly usage", week)),
        chunks[3],
    );

    // Render into the layout chunks directly (never hand-computed coordinates:
    // layout rects are always inside the frame, even on tiny terminals).
    let mut extra = extra_lines(app, p).into_iter();
    if let Some(line) = extra.next() {
        f.render_widget(Paragraph::new(line), chunks[5]);
    }
    if monthly_shown {
        if let Some(line) = extra.next() {
            f.render_widget(Paragraph::new(line), chunks[6]);
        }
    }

    f.render_widget(Paragraph::new(version_line(app, p)), chunks[8]);
    f.render_widget(
        Paragraph::new(FOOTER).style(Style::default().fg(p.text_secondary)),
        chunks[10],
    );
}
