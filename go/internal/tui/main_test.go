package tui

import (
	"fmt"
	"os"
	"testing"
	"time"

	// Zone lookups must work regardless of the machine's tzdata.
	_ "time/tzdata"
)

// TestMain pins the process timezone to Asia/Shanghai, the zone the Rust
// oracle goldens were produced in — FormatUpdated prints DateTime<Local>
// stamps, so view snapshots are only deterministic under a fixed zone
// (PLAN-GO §5.1).
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

// TestTimezoneGuard fails loudly instead of passing against the wrong zone.
func TestTimezoneGuard(t *testing.T) {
	if _, off := time.Now().Zone(); off != 480*60 {
		t.Fatalf("tests must run in Asia/Shanghai (+08:00); got offset %d s", off)
	}
}
