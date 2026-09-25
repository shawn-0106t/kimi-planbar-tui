// Display formatting, a 1:1 port of rust/src/format.rs (SPEC 12.2, 12.3, 12.5).
// The fmt_yuan port implements the i64::MIN fix recommended by REVIEW-RUST
// Major A (the oracle's `-cents` overflows and recurses forever); normal
// values are byte-identical to the Rust output.
package core

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// RustRound is `f64::round` — half away from zero (Go's math.Round matches;
// the named helper documents the intent at call sites).
func RustRound(v float64) float64 { return math.Round(v) }

// F64ToI64Sat is `x as i64` in Rust: the cast truncates and saturates; NaN
// becomes 0.
func F64ToI64Sat(v float64) int64 {
	if math.IsNaN(v) {
		return 0
	}
	if math.IsInf(v, 1) {
		return math.MaxInt64
	}
	if math.IsInf(v, -1) {
		return math.MinInt64
	}
	if v >= math.MaxInt64 {
		return math.MaxInt64
	}
	if v <= math.MinInt64 {
		return math.MinInt64
	}
	return int64(v) // truncation toward zero
}

// FormatReset: span = at - now, English countdown text (SPEC 12.3). The span
// spans full nanosecond precision before truncation, matching chrono's
// `num_milliseconds()` over the complete Duration (M1 review Suggestion 8).
func FormatReset(at RustDateTime, nowMs int64) string {
	spanNs := (at.Ms-nowMs)*1_000_000 + int64(at.Nanos)
	if spanNs < 0 {
		return "Resets soon"
	}
	totalSec := spanNs / 1_000_000_000
	days := TruncDiv(totalSec, 86400)
	if days >= 1 {
		hours := TruncDiv(totalSec, 3600) % 24
		return fmt.Sprintf("Resets in %dd %dh", days, hours)
	}
	totalHours := TruncDiv(totalSec, 3600)
	if totalHours >= 1 {
		minutes := TruncDiv(totalSec, 60) % 60
		return fmt.Sprintf("Resets in %dh %dm", totalHours, minutes)
	}
	minutes := TruncDiv(totalSec, 60)
	if minutes < 1 {
		minutes = 1
	}
	return fmt.Sprintf("Resets in %dm", minutes)
}

// FmtYuan: cents -> yuan text, fraction omitted for whole yuan (SPEC 12.5).
// The magnitude is widened to uint64 through the sign boundary so i64::MIN
// cannot overflow (REVIEW-RUST Major A).
func FmtYuan(cents int64) string {
	if cents < 0 {
		var mag uint64
		if cents == math.MinInt64 {
			mag = uint64(math.MaxInt64) + 1
		} else {
			mag = uint64(-cents)
		}
		return "-" + fmtYuanU(mag)
	}
	return fmtYuanU(uint64(cents))
}

func fmtYuanU(cents uint64) string {
	yuan := cents / 100
	frac := cents % 100
	if frac > 0 {
		return fmt.Sprintf("¥%s.%02d", strconv.FormatUint(yuan, 10), frac)
	}
	return "¥" + strconv.FormatUint(yuan, 10)
}

// FmtPercent is `{percent:0}%` — display uses the raw (unclamped) percent
// (SPEC 12.2). Rust prints the rounded value `as i64` (saturating cast).
func FmtPercent(percent float64) string {
	return strconv.FormatInt(F64ToI64Sat(RustRound(percent)), 10) + "%"
}

// ClampPercent is the gauge fill ratio input: clamp to 0..=100 (SPEC 12.2).
// Rust's `f64::clamp` panics on NaN; parseSegment already guarantees a finite
// percent, and the NaN arm mirrors the TS defense.
func ClampPercent(percent float64) float64 {
	if math.IsNaN(percent) {
		return 0
	}
	if percent < 0 {
		return 0
	}
	if percent > 100 {
		return 100
	}
	return percent
}

// FormatUpdated is the title-row timestamp, `Updated HH:mm` (SPEC 12.1).
func FormatUpdated(at RustDateTime) string {
	text := FormatDateTimeLocal(at)
	return "Updated " + strings.Split(text, "T")[1][:5]
}
