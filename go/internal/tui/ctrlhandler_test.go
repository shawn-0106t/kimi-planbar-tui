package tui

import (
	"sync"
	"testing"
)

// TestTerminalRestoreRunsOnce pins the anti-double-restore contract
// (REVIEW-RUST Minor 15): the console ctrl handler (an OS thread) and the
// normal exit path share one restore via the done atomic — the sequence must
// execute exactly once no matter how many times or from how many goroutines
// run() is called.
func TestTerminalRestoreRunsOnce(t *testing.T) {
	r := &terminalRestore{}
	calls := 0
	var mu sync.Mutex
	r.body = func() {
		mu.Lock()
		calls++
		mu.Unlock()
	}
	r.run()
	r.run()
	r.run()
	if calls != 1 {
		t.Fatalf("sequential run() calls executed the restore %d times, want 1", calls)
	}

	// Concurrent callers race to the same atomic: still exactly one restore.
	r2 := &terminalRestore{}
	concurrent := 0
	r2.body = func() {
		mu.Lock()
		concurrent++
		mu.Unlock()
	}
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r2.run()
		}()
	}
	wg.Wait()
	if concurrent != 1 {
		t.Fatalf("concurrent run() calls executed the restore %d times, want 1", concurrent)
	}
}

// TestHandlesCtrlEvent pins the covered event kinds: the three forced-exit
// paths that could strand the terminal (REVIEW-RUST Minor 15). LOGOFF (4) and
// SHUTDOWN (5) are deliberately unhandled — session teardown destroys the
// console with the process, leaving nothing to restore (SPEC 20).
func TestHandlesCtrlEvent(t *testing.T) {
	for _, ctrl := range []uintptr{ctrlCEvent, ctrlBreakEvent, ctrlCloseEvent} {
		if !handlesCtrlEvent(ctrl) {
			t.Errorf("ctrl event %d must be handled", ctrl)
		}
	}
	for _, ctrl := range []uintptr{4, 5, 42, 0xFFFFFFFF} {
		if handlesCtrlEvent(ctrl) {
			t.Errorf("ctrl event %d must not be handled", ctrl)
		}
	}
}

// TestInstallConsoleCtrlHandlerSmoke exercises the lazy resolution and the
// NewCallback signature: a bad callback contract would panic right here.
// The handler is installed with a no-op body so it can never paint over the
// test process's own terminal if a ctrl event ever arrives.
func TestInstallConsoleCtrlHandlerSmoke(t *testing.T) {
	// The entry point must resolve on this machine; only an unresolvable
	// kernel32 would skip the install silently (never on a supported
	// Windows), and the test wants to know about that.
	if err := procSetConsoleCtrlHandler.Find(); err != nil {
		t.Fatalf("SetConsoleCtrlHandler must resolve: %v", err)
	}
	// The registration BOOL must be true: a swallowed failure here would pin
	// an install that silently never happened (code-review Major 2).
	if !installConsoleCtrlHandler(&terminalRestore{body: func() {}}) {
		t.Fatal("installConsoleCtrlHandler must report a successful registration")
	}
}
