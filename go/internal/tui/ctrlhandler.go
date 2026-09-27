// Windows console ctrl handler (SPEC 20; the Go counterpart of the
// REVIEW-RUST Minor 15 + Suggestion 21 fix in rust/src/app.rs): Ctrl+Break
// arrives as CTRL_BREAK_EVENT regardless of raw mode, closing the console
// window delivers CTRL_CLOSE_EVENT, and an out-of-band
// GenerateConsoleCtrlEvent can deliver CTRL_C_EVENT — none of these run
// bubbletea's restore, so without this handler the terminal would strand
// (SPEC 20: every exit path restores). Keyboard Ctrl+C is unaffected: raw
// mode clears ENABLE_PROCESSED_INPUT, so it still arrives as a plain key
// event routed through handleKey (the q / Ctrl+C branch). Best-effort: run
// the same restore sequence as the normal exit path — exactly once, guarded
// by the shared atomic on terminalRestore — then return FALSE so the default
// termination proceeds. The OS invokes the handler on its own thread while
// the event loop may be mid-draw: it must not touch the bubbletea Model (it
// only writes the restore escapes to stdout and restores the captured stdin
// state), and interleaved output on a dying process is acceptable.
// CTRL_LOGOFF_EVENT / CTRL_SHUTDOWN_EVENT are deliberately not handled:
// session teardown destroys the console with the process, leaving nothing to
// strand (SPEC 20).
package tui

import (
	"golang.org/x/sys/windows"
)

// Win32 console ctrl event kinds (REVIEW-RUST Minor 15).
const (
	ctrlCEvent     uintptr = 0
	ctrlBreakEvent uintptr = 1
	ctrlCloseEvent uintptr = 2
)

// SetConsoleCtrlHandler is not exported by x/sys/windows (the shrink.go
// precedent), so it is resolved lazily from kernel32.
var procSetConsoleCtrlHandler = kernel32.NewProc("SetConsoleCtrlHandler")

// handlesCtrlEvent reports whether the handler consumes the event kind: the
// three forced-exit paths that could strand the terminal. Everything else —
// notably LOGOFF/SHUTDOWN — falls through unhandled (SPEC 20).
func handlesCtrlEvent(ctrl uintptr) bool {
	switch ctrl {
	case ctrlCEvent, ctrlBreakEvent, ctrlCloseEvent:
		return true
	}
	return false
}

// installConsoleCtrlHandler registers the forced-exit restore handler and
// reports whether the registration succeeded (BOOL from SetConsoleCtrlHandler).
// Best-effort, like the Rust oracle's `let _ = SetConsoleCtrlHandler(...)`: a
// failed install only trades a stranded-terminal risk for a plain exit, never
// a crash (SPEC 20) — the boolean exists so the install contract is testable
// instead of silently absorbed.
func installConsoleCtrlHandler(restore *terminalRestore) bool {
	if err := procSetConsoleCtrlHandler.Find(); err != nil {
		return false
	}
	handler := windows.NewCallback(func(ctrl uintptr) uintptr {
		if handlesCtrlEvent(ctrl) {
			restore.run()
		}
		return 0 // FALSE: let the default termination proceed
	})
	r, _, _ := procSetConsoleCtrlHandler.Call(handler, 1) // TRUE = add
	return r != 0
}
