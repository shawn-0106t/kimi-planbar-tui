package core

import (
	"fmt"
	"os"
	"testing"
	"time"

	// The goldens carry DateTime<Local> stamps, so zone lookups must work
	// regardless of the machine's tzdata; the embedded copy guarantees it.
	_ "time/tzdata"
)

// TestMain pins the process timezone to Asia/Shanghai (+08:00, no DST), the
// zone the Rust oracle produced the goldens in (PLAN-GO §5.1).
func TestMain(m *testing.M) {
	os.Setenv("TZ", "Asia/Shanghai")
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		fmt.Fprintln(os.Stderr, "fatal: cannot load Asia/Shanghai:", err)
		os.Exit(1)
	}
	time.Local = loc
	os.Exit(m.Run())
}

// TestGoldenTimezoneGuard fails loudly instead of silently passing golden
// assertions against the wrong zone (the TS guard throws for the same
// reason; REVIEW-M1 Major E: skips must be visible, not fake green).
func TestGoldenTimezoneGuard(t *testing.T) {
	if _, off := time.Now().Zone(); off != 480*60 {
		t.Fatalf("tests must run in Asia/Shanghai (+08:00); got offset %d s", off)
	}
}
