// Formatting helpers, ported from the tray edition's rust/src/common.ts
// (SPEC 12.3 FormatReset / 12.5 FmtYuan / percent display rules).

use chrono::{DateTime, Local};

/// FormatReset: span = at - now, English countdown text (SPEC 12.3).
pub fn format_reset(at: DateTime<Local>) -> String {
    format_reset_span((at - Local::now()).num_milliseconds())
}

/// Ladder core, split out so the SPEC 12.3 branches are unit-testable
/// without clock skew; the public input is `reset_at - now` as before.
fn format_reset_span(span_ms: i64) -> String {
    if span_ms < 0 {
        return "Resets soon".to_string();
    }
    let total_sec = span_ms / 1000;
    let days = total_sec / 86400;
    if days >= 1 {
        let hours = (total_sec / 3600) % 24;
        return format!("Resets in {days}d {hours}h");
    }
    let total_hours = total_sec / 3600;
    if total_hours >= 1 {
        let minutes = (total_sec / 60) % 60;
        return format!("Resets in {total_hours}h {minutes}m");
    }
    let minutes = total_sec / 60;
    format!("Resets in {}m", minutes.max(1))
}

/// FmtYuan: cents -> yuan text, fraction omitted for whole yuan (SPEC 12.5).
pub fn fmt_yuan(cents: i64) -> String {
    // The absolute value is taken in i128: negating i64::MIN in i64 wraps
    // back to i64::MIN (release builds have no overflow checks), which used
    // to recurse forever and abort with a stranded terminal (REVIEW-RUST A).
    let sign = if cents < 0 { "-" } else { "" };
    let abs = (cents as i128).abs();
    let yuan = abs / 100;
    let frac = abs % 100;
    if frac > 0 {
        format!("{sign}¥{yuan}.{frac:02}")
    } else {
        format!("{sign}¥{yuan}")
    }
}

/// {Percent:0}% — display uses the raw (unclamped) percent (SPEC 12.2).
pub fn fmt_percent(percent: f64) -> String {
    format!("{}%", percent.round() as i64)
}

/// Gauge fill ratio input: clamp to 0..=100 (SPEC 12.2).
pub fn clamp_percent(percent: f64) -> f64 {
    percent.clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmt_yuan_examples() {
        assert_eq!(fmt_yuan(1234), "¥12.34");
        assert_eq!(fmt_yuan(10000), "¥100");
        assert_eq!(fmt_yuan(0), "¥0");
        assert_eq!(fmt_yuan(5), "¥0.05");
        assert_eq!(fmt_yuan(-1234), "-¥12.34");
    }

    /// REVIEW-RUST Major A regression: i64::MIN must format and terminate
    /// (it used to negate-wrap and recurse until the stack overflowed).
    #[test]
    fn fmt_yuan_negation_extremes() {
        assert_eq!(fmt_yuan(i64::MIN), "-¥92233720368547758.08");
        assert_eq!(fmt_yuan(i64::MAX), "¥92233720368547758.07");
        assert_eq!(fmt_yuan(-1), "-¥0.01");
    }

    /// SPEC 12.3 ladder on the exact span: >= 1 day -> "Xd Yh", >= 1 hour ->
    /// "Xh Ym", else whole minutes floored at 1; negative spans read "Resets soon".
    #[test]
    fn format_reset_ladder() {
        assert_eq!(format_reset_span(-1), "Resets soon");
        assert_eq!(format_reset_span(0), "Resets in 1m");
        assert_eq!(format_reset_span(30_000), "Resets in 1m"); // < 1 min floored to 1
        assert_eq!(format_reset_span(119_999), "Resets in 1m");
        assert_eq!(format_reset_span(120_000), "Resets in 2m");
        assert_eq!(format_reset_span(3_600_000), "Resets in 1h 0m");
        assert_eq!(format_reset_span(3_660_000), "Resets in 1h 1m");
        assert_eq!(format_reset_span(86_400_000), "Resets in 1d 0h");
        assert_eq!(format_reset_span(5 * 86_400_000 + 3 * 3_600_000), "Resets in 5d 3h");
    }

    /// The public entry re-derives the span from the wall clock. The far-future
    /// case asserts the day prefix only: chrono's TimeDelta arithmetic on
    /// DateTime<Local> can shift the instant by the DST delta, so the hour
    /// digit is not stable across timezones (the exact ladder is pinned by
    /// format_reset_ladder above).
    #[test]
    fn format_reset_end_to_end() {
        let now = Local::now();
        assert_eq!(format_reset(now - chrono::Duration::seconds(1)), "Resets soon");
        let far = format_reset(now + chrono::Duration::days(5) + chrono::Duration::hours(3));
        assert!(far.starts_with("Resets in 5d"), "got: {far}");
    }

    /// {Percent:0}% renders the raw, unclamped percent (SPEC 12.2).
    #[test]
    fn fmt_percent_raw_value() {
        assert_eq!(fmt_percent(21.4), "21%");
        assert_eq!(fmt_percent(-3.6), "-4%");
        assert_eq!(fmt_percent(5000.0), "5000%");
    }

    #[test]
    fn clamp_percent_bounds() {
        assert_eq!(clamp_percent(150.0), 100.0);
        assert_eq!(clamp_percent(-5.0), 0.0);
        assert_eq!(clamp_percent(42.0), 42.0);
    }
}
