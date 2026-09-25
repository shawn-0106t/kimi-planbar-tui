package core

import (
	"math"
	"strings"
	"testing"
)

const nowMs = int64(1_893_456_000_000)

func at(offsetMs int64) RustDateTime { return DtFromParts(nowMs+offsetMs, 0) }

func TestFmtYuanExamples(t *testing.T) {
	cases := map[int64]string{
		1234:      "¥12.34",
		10000:     "¥100",
		0:         "¥0",
		5:         "¥0.05",
		-1234:     "-¥12.34",
		100:       "¥1",
		1105:      "¥11.05",
		1100:      "¥11",
		-5:        "-¥0.05",
		100000000: "¥1000000",
	}
	for cents, want := range cases {
		if got := FmtYuan(cents); got != want {
			t.Errorf("FmtYuan(%d) = %q, want %q", cents, got, want)
		}
	}
}

// REVIEW-RUST Major A: the oracle's i64::MIN negation overflows and recurses
// forever (stranding the terminal). The Go port implements the fixed
// semantics; this is the regression test the Rust ledger calls for.
func TestFmtYuanI64MinDoesNotOverflow(t *testing.T) {
	want := "-¥92233720368547758.08"
	if got := FmtYuan(math.MinInt64); got != want {
		t.Errorf("FmtYuan(i64::MIN) = %q, want %q", got, want)
	}
	if got := FmtYuan(math.MaxInt64); got != "¥92233720368547758.07" {
		t.Errorf("FmtYuan(i64::MAX) = %q", got)
	}
}

func TestClampPercentBounds(t *testing.T) {
	cases := []struct {
		in, want float64
	}{
		{150, 100},
		{-5, 0},
		{42, 42},
		{math.Inf(1), 100},
		{math.Inf(-1), 0},
		{math.NaN(), 0},
	}
	for _, c := range cases {
		if got := ClampPercent(c.in); got != c.want {
			t.Errorf("ClampPercent(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestRustRoundHalfAwayFromZero(t *testing.T) {
	cases := map[float64]float64{
		21.5: 22, -21.5: -22, 2.5: 3, -2.5: -3,
		0.5: 1, -0.5: -1, 2.4: 2, -2.4: -2,
	}
	for in, want := range cases {
		if got := RustRound(in); got != want {
			t.Errorf("RustRound(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestF64ToI64Sat(t *testing.T) {
	cases := map[float64]int64{
		1e30:          math.MaxInt64,
		-1e30:         math.MinInt64,
		math.NaN():    0,
		7.9:           7,
		math.MaxInt64: math.MaxInt64,
		-9.3e18:       math.MinInt64,
	}
	for in, want := range cases {
		if got := F64ToI64Sat(in); got != want {
			t.Errorf("F64ToI64Sat(%v) = %d, want %d", in, got, want)
		}
	}
}

func TestFmtPercent(t *testing.T) {
	cases := map[float64]string{
		21:         "21%",
		21.5:       "22%",
		-21.5:      "-22%",
		0:          "0%",
		5000:       "5000%",
		math.NaN(): "0%",
	}
	for in, want := range cases {
		if got := FmtPercent(in); got != want {
			t.Errorf("FmtPercent(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestFormatResetLadder(t *testing.T) {
	cases := []struct {
		offsetMs int64
		want     string
	}{
		{-1, "Resets soon"},
		{-86_400_000, "Resets soon"},
		{0, "Resets in 1m"},
		{59_999, "Resets in 1m"},
		{60_000, "Resets in 1m"},
		{119_999, "Resets in 1m"},
		{120_000, "Resets in 2m"},
		{3_599_999, "Resets in 59m"},
		{3_600_000, "Resets in 1h 0m"},
		{3_660_000, "Resets in 1h 1m"},
		{86_399_000, "Resets in 23h 59m"},
		{86_400_000, "Resets in 1d 0h"},
		{90_000_000, "Resets in 1d 1h"},
		{373_500_000, "Resets in 4d 7h"},
		{475_200_000, "Resets in 5d 12h"},
	}
	for _, c := range cases {
		if got := FormatReset(at(c.offsetMs), nowMs); got != c.want {
			t.Errorf("FormatReset(%dms) = %q, want %q", c.offsetMs, got, c.want)
		}
	}
}

func TestFormatUpdated24Hour(t *testing.T) {
	// 2026-01-02T03:04:05Z; the local HH:mm depends on the pinned zone.
	got := FormatUpdated(DtFromParts(1767325445000, 0))
	if !strings.HasPrefix(got, "Updated ") || len(got) != len("Updated 12:34") {
		t.Errorf("FormatUpdated shape = %q", got)
	}
}
