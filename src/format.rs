// Formatting helpers, ported from the tray edition's rust/src/common.ts
// (SPEC 12.3 FormatReset / 12.5 FmtYuan / percent display rules).

use chrono::{DateTime, Local};

/// FormatReset: span = at - now, English countdown text (SPEC 12.3).
pub fn format_reset(at: DateTime<Local>) -> String {
    let span = at - Local::now();
    let span_ms = span.num_milliseconds();
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
    if cents < 0 {
        return format!("-{}", fmt_yuan(-cents));
    }
    let yuan = cents / 100;
    let frac = cents % 100;
    if frac > 0 {
        format!("¥{yuan}.{frac:02}")
    } else {
        format!("¥{yuan}")
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

    #[test]
    fn clamp_percent_bounds() {
        assert_eq!(clamp_percent(150.0), 100.0);
        assert_eq!(clamp_percent(-5.0), 0.0);
        assert_eq!(clamp_percent(42.0), 42.0);
    }
}
