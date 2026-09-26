//go:build windows

// Owned-console launch probe — the automatable stand-in for the PLAN-GO §7
// acceptance matrix (items 1/2/6). Launches the built TUI exe in a fresh
// console (CREATE_NEW_CONSOLE: the only attached process, i.e. the
// double-click / `start /wait` scenario), waits for the TUI to boot, then
// attaches to that console and checks, in order:
//
//  1. SIZE: the startup shrink ran — the console viewport is exactly 72x13
//     (SPEC 20);
//  2. INPUT: injected keys reach the app — 's' must switch to the Settings
//     view (a visible row-0 change);
//  3. EXIT: the requested exit path ends the process with code 0 — 'q'
//     injected as key events (the primary quit key) or GenerateConsoleCtrlEvent
//     (the OS SIGINT channel).
//
// A PowerShell draft of this probe injected no-op events (PowerShell mutates
// a copy when assigning into a nested struct field), which is why this probe
// is written in Go with the exact Win32 record layouts.
//
// Usage:
//
//	go run ./scripts/probe-owned-console [-exe dist/kpt-tui-go.exe] [-wait 8s] [-exit q|ctrlc]
package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	minWinCols = 72
	minWinRows = 13
)

// kernel32 entry points not exported by x/sys/windows, resolved lazily; every
// failure is reported as a probe failure, never a crash.
var (
	kernel32                  = windows.NewLazySystemDLL("kernel32.dll")
	procAttachConsole         = kernel32.NewProc("AttachConsole")
	procFreeConsole           = kernel32.NewProc("FreeConsole")
	procGetConsoleScreenBuf   = kernel32.NewProc("GetConsoleScreenBufferInfo")
	procReadConsoleOutputChar = kernel32.NewProc("ReadConsoleOutputCharacterW")
	procWriteConsoleInput     = kernel32.NewProc("WriteConsoleInputW")
	procPeekConsoleInput      = kernel32.NewProc("PeekConsoleInputW")
	procGenerateCtrlEvent     = kernel32.NewProc("GenerateConsoleCtrlEvent")
	procGetConsoleWindow      = kernel32.NewProc("GetConsoleWindow")

	user32                 = windows.NewLazySystemDLL("user32.dll")
	procGetWindowThreadPid = user32.NewProc("GetWindowThreadProcessId")
)

// consoleBufferInfo mirrors CONSOLE_SCREEN_BUFFER_INFO (x/sys supplies the
// Coord and SmallRect layouts).
type consoleBufferInfo struct {
	Size              windows.Coord
	CursorPosition    windows.Coord
	Attributes        uint16
	Window            windows.SmallRect
	MaximumWindowSize windows.Coord
}

// keyEventRecord mirrors KEY_EVENT_RECORD (16 bytes).
type keyEventRecord struct {
	bKeyDown          int32
	wRepeatCount      uint16
	wVirtualKeyCode   uint16
	wVirtualScanCode  uint16
	uChar             uint16
	dwControlKeyState uint32
}

// inputRecord mirrors INPUT_RECORD (20 bytes; the union is keyed to the key
// event layout, the only record type this probe injects).
type inputRecord struct {
	eventType uint16
	_         uint16
	event     keyEventRecord
}

func init() {
	if unsafe.Sizeof(inputRecord{}) != 20 || unsafe.Sizeof(keyEventRecord{}) != 16 {
		panic("Win32 input record layout mismatch")
	}
}

func fail(format string, args ...any) {
	fmt.Printf("FAIL: "+format+"\n", args...)
	os.Exit(1)
}

func coord(x, y int16) uintptr {
	return uintptr(uint16(x)) | uintptr(uint16(y))<<16
}

// readRow reads one visible row of the attached console.
func readRow(hOut windows.Handle, y int16, width int) string {
	buf := make([]uint16, width)
	var read uint32
	r, _, _ := procReadConsoleOutputChar.Call(
		uintptr(hOut),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(width),
		coord(0, y),
		uintptr(unsafe.Pointer(&read)))
	if r == 0 {
		return ""
	}
	return strings.TrimRight(windows.UTF16ToString(buf[:read]), " ")
}

// injectKey writes one key down+up pair into the console input buffer.
func injectKey(hIn windows.Handle, ch rune) bool {
	vk := uint16(0)
	if ch >= 'a' && ch <= 'z' {
		vk = uint16(strings.ToUpper(string(ch))[0])
	}
	recs := []inputRecord{
		{eventType: 1, event: keyEventRecord{bKeyDown: 1, wRepeatCount: 1, wVirtualKeyCode: vk, uChar: uint16(ch)}},
		{eventType: 1, event: keyEventRecord{bKeyDown: 0, wRepeatCount: 1, wVirtualKeyCode: vk, uChar: uint16(ch)}},
	}
	var written uint32
	r, _, _ := procWriteConsoleInput.Call(
		uintptr(hIn),
		uintptr(unsafe.Pointer(&recs[0])),
		uintptr(len(recs)),
		uintptr(unsafe.Pointer(&written)))
	return r != 0 && written == uint32(len(recs))
}

// injectCtrlC writes the raw-mode Ctrl+C key event a real terminal delivers:
// the ETX character (0x03) with LEFT_CTRL_PRESSED — in raw mode the console
// never raises a signal for real Ctrl+C presses, they arrive as key records
// and bubbletea decodes ETX into a ctrl+c KeyMsg (SPEC 20).
func injectCtrlC(hIn windows.Handle) bool {
	recs := []inputRecord{
		{eventType: 1, event: keyEventRecord{bKeyDown: 1, wRepeatCount: 1, wVirtualKeyCode: 0x43, uChar: 0x03, dwControlKeyState: 0x8}},
		{eventType: 1, event: keyEventRecord{bKeyDown: 0, wRepeatCount: 1, wVirtualKeyCode: 0x43, uChar: 0x03}},
	}
	var written uint32
	r, _, _ := procWriteConsoleInput.Call(
		uintptr(hIn),
		uintptr(unsafe.Pointer(&recs[0])),
		uintptr(len(recs)),
		uintptr(unsafe.Pointer(&written)))
	return r != 0 && written == uint32(len(recs))
}

// consoleHost reports the image name of the process owning the console
// window (conhost.exe for a classic console, OpenConsole/WindowsTerminal
// under the ConPTY delegation).
func consoleHost() string {
	hwnd, _, _ := procGetConsoleWindow.Call()
	if hwnd == 0 {
		return "none"
	}
	var ownerPid uint32
	procGetWindowThreadPid.Call(hwnd, uintptr(unsafe.Pointer(&ownerPid)))
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, ownerPid)
	if err != nil {
		return fmt.Sprintf("pid=%d (unresolvable)", ownerPid)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var name [260]uint16
	var size uint32 = uint32(len(name))
	if err := windows.QueryFullProcessImageName(h, 0, &name[0], &size); err != nil {
		return fmt.Sprintf("pid=%d (unresolvable)", ownerPid)
	}
	parts := strings.Split(windows.UTF16ToString(name[:size]), string(os.PathSeparator))
	return fmt.Sprintf("%s (pid=%d)", parts[len(parts)-1], ownerPid)
}

func main() {
	exe := flag.String("exe", "dist/kpt-tui-go.exe", "path to the built TUI exe")
	wait := flag.Duration("wait", 8*time.Second, "seconds to let the TUI boot")
	exitVia := flag.String("exit", "q", "exit path to exercise: q or ctrlc")
	flag.Parse()

	exePath, err := os.Getwd()
	if err != nil {
		fail("cwd: %v", err)
	}
	exePath, err = syscall.FullPath(exePath + string(os.PathSeparator) + *exe)
	if err != nil {
		fail("path: %v", err)
	}
	if _, err := os.Stat(exePath); err != nil {
		fail("exe not found: %s", exePath)
	}

	// GenerateConsoleCtrlEvent would hit this process too (it is attached to
	// the same console when the signal is raised) — ignore SIGINT here.
	signal.Ignore(syscall.SIGINT)

	// Launch with a fresh console AND default console std handles: without
	// STARTF_USESTDHANDLES the child's stdin/stdout are the new console's
	// input/output buffers — exactly the double-click semantics. (exec.Cmd
	// would wire them to NUL, the TUI's stdout-console guard would correctly
	// refuse to shrink, and the probe would test the wrong scenario.)
	argv := windows.StringToUTF16Ptr(strconv.Quote(exePath))
	si := &windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{}))}
	pi := &windows.ProcessInformation{}
	if err := windows.CreateProcess(nil, argv, nil, nil, false, windows.CREATE_NEW_CONSOLE, nil, nil, si, pi); err != nil {
		fail("CreateProcess %s: %v", exePath, err)
	}
	defer func() { _ = windows.CloseHandle(pi.Process); _ = windows.CloseHandle(pi.Thread) }()

	alive := func() bool {
		s, err := windows.WaitForSingleObject(pi.Process, 0)
		return err == nil && s != windows.WAIT_OBJECT_0
	}
	time.Sleep(*wait)
	if !alive() {
		fail("TUI exited during the wait window")
	}
	pid := pi.ProcessId

	// Detach from our console and attach to the TUI's fresh one; stdout is a
	// pipe and survives the detach.
	if r, _, _ := procFreeConsole.Call(); r == 0 {
		fail("FreeConsole failed")
	}
	if r, _, _ := procAttachConsole.Call(uintptr(pid)); r == 0 {
		_ = windows.TerminateProcess(pi.Process, 1)
		fail("AttachConsole(pid=%d) failed", pid)
	}

	hOut, err := windows.CreateFile(
		windows.StringToUTF16Ptr("CONOUT$"),
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		fail("open CONOUT$: %v", err)
	}
	hIn, err := windows.CreateFile(
		windows.StringToUTF16Ptr("CONIN$"),
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		fail("open CONIN$: %v", err)
	}

	var info consoleBufferInfo
	if r, _, _ := procGetConsoleScreenBuf.Call(
		uintptr(hOut), uintptr(unsafe.Pointer(&info))); r == 0 {
		fail("GetConsoleScreenBufferInfo failed")
	}
	winW := int(info.Window.Right - info.Window.Left + 1)
	winH := int(info.Window.Bottom - info.Window.Top + 1)
	fmt.Printf("viewport=%dx%d buffer=%dx%d\n", winW, winH, info.Size.X, info.Size.Y)

	var modeIn, modeOut uint32
	_ = windows.GetConsoleMode(hIn, &modeIn)
	_ = windows.GetConsoleMode(hOut, &modeOut)
	fmt.Printf("modeIn=0x%X modeOut=0x%X\n", modeIn, modeOut)
	fmt.Println("--- visible rows ---")
	for y := int16(0); y < int16(winH) && y < 20; y++ {
		if row := readRow(hOut, y, winW); row != "" {
			fmt.Printf("row%02d: %s\n", y, row)
		}
	}

	// Input reachability: 's' must open the Settings view. Its title sits on
	// row 1 (the Rust block pads one row at the top), so scan the first rows.
	if !injectKey(hIn, 's') {
		fail("WriteConsoleInput('s') failed")
	}
	time.Sleep(2 * time.Second)
	head := make([]string, 5)
	for i := range head {
		head[i] = readRow(hOut, int16(i), winW)
	}
	row0 := head[0]
	inputOK := false
	for _, r := range head {
		if strings.Contains(r, "Settings") {
			inputOK = true
		}
	}
	fmt.Printf("after 's': row0=%q inputReach=%v\n", row0, inputOK)

	// Escape the Settings view back to the dashboard first (Esc), then exit.
	if inputOK {
		_ = injectKey(hIn, 0x1b) // Esc: back to the dashboard
		time.Sleep(1 * time.Second)
	}

	switch *exitVia {
	case "q":
		if !injectKey(hIn, 'q') {
			fail("WriteConsoleInput('q') failed")
		}
		fmt.Println("exit via: q (injected)")
	case "ctrlc":
		// The OS-signal form first (GenerateConsoleCtrlEvent), then the
		// raw-mode key form a real terminal delivers. Under a ConPTY host the
		// signal form may be absorbed — the key form is the contract path
		// (SPEC 20 / PLAN-GO §4.3).
		host := consoleHost()
		fmt.Printf("console host: %s\n", host)
		r, _, _ := procGenerateCtrlEvent.Call(0, 0)
		fmt.Printf("exit via: ctrlc signal (sent=%v)\n", r != 0)
		time.Sleep(5 * time.Second)
		if alive() {
			fmt.Println("signal form had no effect (expected under ConPTY hosts), injecting the key form")
			if !injectCtrlC(hIn) {
				fail("WriteConsoleInput(Ctrl+C) failed")
			}
			fmt.Println("exit via: ctrlc key (0x03 + LEFT_CTRL_PRESSED)")
		}
	default:
		fail("unknown -exit value %q", *exitVia)
	}

	s, err := windows.WaitForSingleObject(pi.Process, 15000)
	if err != nil || s != windows.WAIT_OBJECT_0 {
		_ = windows.TerminateProcess(pi.Process, 1)
		fail("TUI did not exit within 15 s (wait=%v state=%d)", err, s)
	}
	var code uint32
	if err := windows.GetExitCodeProcess(pi.Process, &code); err != nil {
		fail("GetExitCodeProcess: %v", err)
	}
	fmt.Printf("exitcode=%d\n", code)

	fmt.Printf("SIZE=%s (want %dx%d)\n", verdict(winW == minWinCols && winH == minWinRows), minWinCols, minWinRows)
	fmt.Printf("INPUT=%s (injected 's' opened Settings)\n", verdict(inputOK))
	fmt.Printf("EXIT=%s (-exit %s, code 0)\n", verdict(code == 0), *exitVia)
}

func verdict(ok bool) string {
	if ok {
		return "PASS"
	}
	return "FAIL"
}
