package tui

import (
	"os"
	"testing"
)

func TestMayShrinkRequiresExactlyOneConsoleProcess(t *testing.T) {
	getenv := func(string) string { return "" }
	cases := []struct {
		count uint32
		ok    bool
		want  bool
	}{
		{1, true, true},  // owned console: double-click / fresh window (SPEC 20)
		{0, true, false}, // no console: pipes, MinTTY, detached runs
		{2, true, false}, // shared with a shell — never touch the user's window
		{3, true, false},
		{8, true, false},
		{0, false, true}, // Win32 unavailable + no terminal-host env → heuristic: owned
	}
	for _, c := range cases {
		if got := mayShrink(c.count, c.ok, getenv); got != c.want {
			t.Errorf("mayShrink(count=%d, ok=%v) = %v, want %v", c.count, c.ok, got, c.want)
		}
	}
}

func TestMayShrinkEnvHeuristicFallback(t *testing.T) {
	// Without the Win32 probe, an inherited terminal-host variable means a
	// shared console — never resize (the SPEC 22.6 heuristic).
	for _, v := range []string{"WT_SESSION", "TERM_PROGRAM", "ConEmuPID"} {
		getenv := func(name string) string {
			if name == v {
				return "1"
			}
			return ""
		}
		if mayShrink(0, false, getenv) {
			t.Errorf("heuristic must treat inherited %s as a shared console", v)
		}
	}
}

func TestConsoleProcCountUnderGoTestIsSharedOrAbsent(t *testing.T) {
	// go test always runs with a console shared with its parent toolchain
	// (count >= 2) or none at all (0); the owned-console branch (§7-1/2)
	// needs a fresh-window launch and is covered by the acceptance probe,
	// never by a unit test.
	count, ok := consoleProcCount()
	if ok && count == 1 {
		t.Fatalf("consoleProcCount = 1 under go test — the shrink guard must not fire in tests")
	}
	if !mayShrink(count, ok, os.Getenv) {
		t.Logf("shrink would not fire here (count=%d, ok=%v) — expected under go test", count, ok)
	}
}
