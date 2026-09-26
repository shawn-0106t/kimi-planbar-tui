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
use crate::quota::{ExtraInfo, ExtraState, QuotaSegment};
use crate::theme::Palette;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

const FOOTER: &str = "r Refresh · s Settings · k Skills · c Console · g Releases · q Quit";
/// Column width for the row labels ("5-hour usage" / "Kimi Code CLI" fit).
const LABEL_W: usize = 14;
/// Column width for the percent value (SPEC 12.2 `{percent:0}%`). 5 cells
/// keep e.g. "5000%" intact — at 4 the % suffix was truncated away
/// (REVIEW-RUST Minor 4).
const PCT_W: usize = 5;
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
    // The column budget is PCT_W cells; truncate rather than overflow the line
    // (a broken payload could otherwise push the reset text off-screen).
    let pct_text: String = pct_text.chars().take(PCT_W).collect();
    let reset = seg
        .and_then(|s| s.reset_at)
        .map(format_reset)
        .unwrap_or_default();

    let mut spans = vec![
        Span::styled(format!("{label:<LABEL_W$}"), Style::default().fg(p.text_secondary)),
        Span::styled(
            format!("{pct_text:>PCT_W$}"),
            Style::default().fg(p.text_primary).add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
    ];

    // Bar takes the space left after label + percent + reset text. The reset
    // budget counts chars, not bytes (REVIEW-RUST Suggestion 9: format_reset
    // is ASCII-only today, but a localized text would silently understate the
    // bar width at byte length).
    let used = LABEL_W + PCT_W + 2 + if reset.is_empty() { 0 } else { reset.chars().count() + 2 };
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

/// Monthly sub-line visibility (SPEC 12.4): monthly charging enabled, a real
/// limit, and a known used value. Single source for `extra_lines` (push the
/// line) and `draw` (reserve the layout row) — REVIEW-RUST Suggestion 20: the
/// predicate lived in two hand-synced copies that could drift apart.
fn monthly_subline_shown(extra: Option<&ExtraInfo>) -> bool {
    extra.is_some_and(|e| {
        e.monthly_enabled && e.monthly_limit_cents.unwrap_or(0) > 0 && e.monthly_used_cents.is_some()
    })
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

    // Monthly sub-line (SPEC 12.4): only when monthly_subline_shown holds.
    if let Some(e) = extra {
        if monthly_subline_shown(Some(e)) {
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
    let show_monthly = monthly_subline_shown(app.quota.as_ref().and_then(|q| q.extra.as_ref()));
    let monthly_h = if show_monthly { 1 } else { 0 };

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
    if show_monthly {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// REVIEW-RUST Suggestion 20: the SPEC 12.4 monthly-subline predicate now
    /// has a single source consumed by both `extra_lines` and `draw`.
    #[test]
    fn monthly_subline_predicate() {
        let info = |enabled: bool, limit: i64, used: Option<i64>| ExtraInfo {
            state: ExtraState::Ready,
            balance_cents: None,
            monthly_enabled: enabled,
            monthly_used_cents: used,
            monthly_limit_cents: Some(limit),
        };
        assert!(monthly_subline_shown(Some(&info(true, 10000, Some(4567)))));
        assert!(!monthly_subline_shown(Some(&info(false, 10000, Some(4567))))); // isEnabled=false
        assert!(!monthly_subline_shown(Some(&info(true, 0, Some(4567))))); // limit<=0
        assert!(!monthly_subline_shown(Some(&info(true, 10000, None)))); // used unknown
        let limit_none = ExtraInfo {
            state: ExtraState::Ready,
            balance_cents: None,
            monthly_enabled: true,
            monthly_used_cents: Some(4567),
            monthly_limit_cents: None,
        };
        assert!(!monthly_subline_shown(Some(&limit_none))); // limit unknown (unwrap_or(0) path)
        assert!(!monthly_subline_shown(None)); // no wallet at all
    }

    /// REVIEW-RUST Minor 4 regression: 5000% must keep its % suffix — the
    /// old 4-cell budget truncated it away (limit<=0 guard can yield large
    /// raw percents, SPEC 12.2 displays them unclamped).
    #[test]
    fn usage_line_keeps_percent_suffix() {
        let seg = QuotaSegment { percent: 5000.0, reset_at: None };
        let line = usage_line(&crate::theme::MOONDARK, 80, "5-hour usage", Some(&seg));
        assert_eq!(line.spans[1].content, "5000%");

        let seg = QuotaSegment { percent: 68.0, reset_at: None };
        let line = usage_line(&crate::theme::MOONDARK, 80, "5-hour usage", Some(&seg));
        assert_eq!(line.spans[1].content, "  68%");

        let line = usage_line(&crate::theme::MOONDARK, 80, "5-hour usage", None);
        assert_eq!(line.spans[1].content, "   --");
    }
}
