// Entry point. The headless self-checks come first and print, then exit
// (SPEC 19); they never touch the terminal. `--test-fetch` is checked before
// `--test-update`, exactly like the Rust main, and the flags match at any
// position in the argument list. Unlike the tray editions there is no
// single-instance mutex — multiple TUI instances are allowed (SPEC 20).
package main

import (
	"fmt"
	"os"

	"github.com/shawn-0106t/kimi-planbar-tui/go/internal/core"
	"github.com/shawn-0106t/kimi-planbar-tui/go/internal/tui"
)

func hasArg(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

func strOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func main() {
	args := os.Args[1:]

	// Headless quota self-check: fetch once, print indented JSON, exit.
	if hasArg(args, "--test-fetch") {
		r := core.FetchQuota(core.QuotaDeps{})
		fmt.Println(core.SerdePretty(core.QuotaResultToSerde(&r)))
		return
	}

	// Headless update-check self-check: single-line summary, exit. The
	// .NET-style booleans keep the output diffable against the tray editions
	// (SPEC 19).
	if hasArg(args, "--test-update") {
		st := core.CheckUpdate(core.UpdateDeps{})
		fmt.Printf("local=%s latest=%s updateAvailable=%s checkFailed=%s\n",
			strOrEmpty(st.LocalVersion), strOrEmpty(st.LatestVersion),
			core.DotnetBool(st.UpdateAvailable), core.DotnetBool(st.CheckFailed))
		return
	}

	// SPEC 19: unrecognized arguments are ignored and the TUI starts normally.
	// The bootstrap restores the terminal on every exit path (SPEC 20).
	if err := tui.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}
