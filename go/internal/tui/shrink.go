// Startup console shrink (SPEC 20): on a fresh-window launch the process
// owns its console outright, so the window is shrunk to the wireframe's
// minimal size — the Go counterpart of rust/src/app.rs resize_owned_console.
// Two channels, both best-effort and fired in the same order: the xterm
// window-size escape (Windows Terminal 1.22+, a graceful no-op where ConPTY
// does not forward it) and the conhost shrink-viewport / grow-buffer /
// fit-viewport Win32 sequence. A console shared with a shell is never
// touched (GetConsoleProcessList > 1), so launching from an existing
// terminal session leaves the user's window alone.
//
// kernel32's three console entry points used here are not exported by
// x/sys/windows v0.48, so they are resolved lazily; the SMALL_RECT / COORD
// layouts come from x/sys itself (SetConsoleWindowInfo takes a *SmallRect,
// SetConsoleScreenBufferSize takes COORD by value packed as (y<<16)|x —
// a by-value struct in a pointer slot is impossible: types reject it, the
// 2026-09-25 Bun-edition segfault class, SPEC 22.6). Deviation register
// (SPEC 22.7, M5): Go additionally requires stdout to be a real console
// (GetConsoleMode probe) before shrinking — Rust relies on
// GetConsoleProcessList alone; the divergence only affects the
// owned-console-with-redirected-stdout corner where Rust shrinks an
// invisible window.
package tui

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// minWinCols / minWinRows are the minimal window size (character cells)
// applied on fresh-window launch (SPEC 20), matching rust/src/app.rs
// MIN_WIN_COLS / MIN_WIN_ROWS: the wireframe's 9 content rows + footer with
// the ~66-cell footer hint.
const (
	minWinCols = 72
	minWinRows = 13
)

var (
	kernel32                       = windows.NewLazySystemDLL("kernel32.dll")
	procGetConsoleProcessList      = kernel32.NewProc("GetConsoleProcessList")
	procSetConsoleWindowInfo       = kernel32.NewProc("SetConsoleWindowInfo")
	procSetConsoleScreenBufferSize = kernel32.NewProc("SetConsoleScreenBufferSize")
)

// mayShrink decides whether the startup shrink may run (SPEC 20): the
// process must own its console outright — exactly one attached process. When
// the Win32 probe is unavailable, the TS editions' terminal-host heuristic
// stands in (SPEC 22.6): an inherited WT_SESSION / TERM_PROGRAM / ConEmuPID
// means the console is shared — never resize.
func mayShrink(procCount uint32, win32OK bool, getenv func(string) string) bool {
	if win32OK {
		return procCount == 1
	}
	for _, v := range []string{"WT_SESSION", "TERM_PROGRAM", "ConEmuPID"} {
		if getenv(v) != "" {
			return false
		}
	}
	return true
}

// consoleProcCount asks kernel32 how many processes share this console.
// ok is false only when the Win32 probe itself is unavailable (never on a
// supported Windows); a zero count with ok true means no console is
// attached at all (pipes, MinTTY, detached runs).
func consoleProcCount() (count uint32, ok bool) {
	if err := procGetConsoleProcessList.Find(); err != nil {
		return 0, false
	}
	var procs [8]uint32
	n, _, _ := procGetConsoleProcessList.Call(
		uintptr(unsafe.Pointer(&procs[0])), uintptr(len(procs)))
	return uint32(n), true
}

// resizeOwnedConsole is the launch-time shrink; every failure is silently
// swallowed — the worst case is a window left at its original size.
func resizeOwnedConsole() {
	count, ok := consoleProcCount()
	if !mayShrink(count, ok, os.Getenv) {
		return
	}
	out, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE)
	if err != nil || out == 0 {
		return
	}
	// stdout must be a real console (PLAN-GO §4.2: a piped or redirected
	// stdout never shrinks) — GetConsoleMode fails on every non-console
	// handle.
	if procSetConsoleWindowInfo.Find() != nil || procSetConsoleScreenBufferSize.Find() != nil {
		return
	}
	// Enable VT processing on the output handle before the escape: at this
	// point bubbletea has not touched the console yet, and a classic conhost
	// would otherwise echo the escape as literal text into the primary buffer
	// (the Go counterpart of REVIEW-RUST Minor 1). On failure skip channel
	// (a) and shrink through the Win32 sequence only.
	var mode uint32
	if err := windows.GetConsoleMode(out, &mode); err != nil {
		return
	}
	vtEnabled := windows.SetConsoleMode(out, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING) == nil
	// Channel (a): xterm window ops escape, written while still in cooked
	// mode, before any terminal setup.
	if vtEnabled {
		fmt.Fprintf(os.Stdout, "\x1b[8;%d;%dt", minWinRows, minWinCols)
	}
	// Channel (b): the conhost sequence — shrink the viewport to 1×1, resize
	// the screen buffer to the minimum, then fit the viewport (the
	// rust/src/app.rs order).
	tiny := windows.SmallRect{}
	_, _, _ = procSetConsoleWindowInfo.Call(uintptr(out), 1, uintptr(unsafe.Pointer(&tiny)))
	_, _, _ = procSetConsoleScreenBufferSize.Call(uintptr(out),
		uintptr(uint16(minWinCols))|uintptr(uint16(minWinRows))<<16)
	fit := windows.SmallRect{Left: 0, Top: 0, Right: minWinCols - 1, Bottom: minWinRows - 1}
	_, _, _ = procSetConsoleWindowInfo.Call(uintptr(out), 1, uintptr(unsafe.Pointer(&fit)))
}
