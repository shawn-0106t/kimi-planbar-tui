package core

import (
	"math"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSetTimer records scheduled ticks; the test fires them manually.
type scheduledTick struct {
	id  int
	ms  int64
	run func()
}

type fakeTimer struct {
	mu     sync.Mutex
	ticks  []*scheduledTick
	nextID int
}

func (f *fakeTimer) setTimer(ms int64, run func()) func() {
	f.mu.Lock()
	f.nextID++
	tick := &scheduledTick{id: f.nextID, ms: ms, run: run}
	f.ticks = append(f.ticks, tick)
	f.mu.Unlock()
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		for i, t := range f.ticks {
			if t.id == tick.id {
				f.ticks = append(f.ticks[:i], f.ticks[i+1:]...)
				return
			}
		}
	}
}

func (f *fakeTimer) lastDelay() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.ticks) == 0 {
		return -1
	}
	return f.ticks[len(f.ticks)-1].ms
}

func (f *fakeTimer) shift() *scheduledTick {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.ticks) == 0 {
		return nil
	}
	t := f.ticks[0]
	f.ticks = f.ticks[1:]
	return t
}

func (f *fakeTimer) pending() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.ticks)
}

type pollingHarness struct {
	timer     *fakeTimer
	published []QuotaResult
	polling   *Polling
	state     *AppState
	queue     []QuotaResult
}

func goodResult(label string) QuotaResult {
	return QuotaResult{
		FiveHour:  &QuotaSegment{Percent: 21},
		Week:      &QuotaSegment{Percent: 18},
		Extra:     &ExtraInfo{State: ExtraReady, BalanceCents: ptrI64(1)},
		FetchedAt: atZero,
	}
}

func failedResult(kind string) QuotaResult {
	return QuotaResult{FetchedAt: atZero, Error: &kind}
}

func newHarness(first QuotaResult) *pollingHarness {
	h := &pollingHarness{
		timer: &fakeTimer{},
		queue: []QuotaResult{first},
		state: NewAppState(DefaultSettings(), "light"),
	}
	h.polling = NewPolling(PollingDeps{
		State: h.state,
		FetchQuota: func() QuotaResult {
			if len(h.queue) == 0 {
				return goodResult("x")
			}
			r := h.queue[0]
			h.queue = h.queue[1:]
			return r
		},
		Publish:  func(r QuotaResult) { h.published = append(h.published, r) },
		SetTimer: h.timer.setTimer,
	})
	return h
}

func (h *pollingHarness) fire() {
	if tick := h.timer.shift(); tick != nil {
		tick.run()
	}
}

func TestPollingFirstRefreshFiresTwoSecondsAfterStart(t *testing.T) {
	h := newHarness(goodResult("a"))
	h.polling.Start()
	if h.timer.pending() != 1 || h.timer.lastDelay() != 2000 {
		t.Errorf("start arms one 2 s tick: pending=%d delay=%d", h.timer.pending(), h.timer.lastDelay())
	}
	if len(h.published) != 0 {
		t.Error("no refresh runs before the tick fires")
	}
}

func TestPollingSuccessRearmsAtPeriod(t *testing.T) {
	h := newHarness(goodResult("a"))
	h.polling.Start()
	h.fire()
	if h.timer.lastDelay() != 5*60_000 {
		t.Errorf("success re-arms at the period, got %d", h.timer.lastDelay())
	}
	if len(h.published) != 1 || h.state.LastQuota() == nil {
		t.Errorf("published=%d lastQuota=%+v", len(h.published), h.state.LastQuota())
	}
}

func TestPollingFailureRearmsAfter30Seconds(t *testing.T) {
	h := newHarness(failedResult("HttpRequestException"))
	h.polling.Start()
	h.fire()
	if h.timer.lastDelay() != 30_000 {
		t.Errorf("failure re-arms at 30 s, got %d", h.timer.lastDelay())
	}
}

func TestPollingPeriodReadAtTickTime(t *testing.T) {
	h := newHarness(goodResult("a"))
	h.polling.Start()
	h.fire()
	{
		s := h.state.Settings()
		s.RefreshMinutes = 30
		h.state.SetSettings(s)
	}
	h.fire()
	if h.timer.lastDelay() != 30*60_000 {
		t.Errorf("a save must take effect on the next tick, got %d", h.timer.lastDelay())
	}
}

func TestPollingRefreshMinutesBelowOneFlooredToOneMinute(t *testing.T) {
	h := newHarness(goodResult("a"))
	{
		s := h.state.Settings()
		s.RefreshMinutes = 0
		h.state.SetSettings(s)
	}
	h.polling.Start()
	h.fire()
	if h.timer.lastDelay() != 60_000 {
		t.Errorf("minutes 0 floors to one minute, got %d", h.timer.lastDelay())
	}
}

// REVIEW-M1 Major A / PLAN-GO §4.4: a huge refreshMinutes must mean "long
// sleep", not an overflow to a short hot loop. Go has no int32 setTimeout
// ceiling, so the correct answer is the saturating maximum, not 2^31-1.
func TestPollingHugeRefreshMinutesNeverShortDelays(t *testing.T) {
	if got := periodMs(math.MaxInt64); got != math.MaxInt64 {
		t.Errorf("periodMs(i64::MAX) = %d, want i64::MAX", got)
	}
	if got := periodMs(0); got != 60_000 {
		t.Errorf("periodMs(0) = %d, want one minute", got)
	}
	if d := msToDuration(math.MaxInt64); d <= 0 {
		t.Errorf("msToDuration must saturate, got %v", d)
	}
	h := newHarness(goodResult("a"))
	{
		s := h.state.Settings()
		s.RefreshMinutes = math.MaxInt64
		h.state.SetSettings(s)
	}
	h.polling.Start()
	h.fire()
	if h.timer.lastDelay() != math.MaxInt64 {
		t.Errorf("huge period saturates, got %d", h.timer.lastDelay())
	}
}

func TestPollingKeepsLastGoodOnFailure(t *testing.T) {
	h := newHarness(goodResult("a"))
	h.polling.Start()
	h.fire() // good
	h.queue = append(h.queue, failedResult("HttpRequestException"))
	h.fire()
	last := h.published[len(h.published)-1]
	if last.ErrorKind() != "HttpRequestException" {
		t.Errorf("error = %q", last.ErrorKind())
	}
	if last.FiveHour == nil || last.FiveHour.Percent != 21 {
		t.Errorf("filled from last-good: %+v", last.FiveHour)
	}
	if last.FetchedAt != atZero {
		t.Errorf("fetchedAt = %+v", last.FetchedAt)
	}
}

func TestPollingFirstFailureStaysEmpty(t *testing.T) {
	h := newHarness(failedResult("no-token"))
	h.polling.Start()
	h.fire()
	if len(h.published) != 1 || h.published[0].FiveHour != nil || h.published[0].ErrorKind() != "no-token" {
		t.Errorf("first failure stays empty: %+v", h.published[0])
	}
}

func TestPollingRescheduleDrainsStaleHint(t *testing.T) {
	h := newHarness(failedResult("HttpRequestException"))
	h.polling.Start()
	h.fire() // failure => 30 s pending
	if h.timer.lastDelay() != 30_000 {
		t.Fatalf("precondition: 30 s pending, got %d", h.timer.lastDelay())
	}
	h.polling.Reschedule()
	if h.timer.lastDelay() != 2000 {
		t.Errorf("reschedule forces 2 s, got %d", h.timer.lastDelay())
	}
	h.fire()
	if len(h.published) != 2 {
		t.Errorf("published=%d, want 2", len(h.published))
	}
}

func TestPollingManualRefreshMovesNextTick(t *testing.T) {
	h := newHarness(goodResult("a"))
	h.polling.Start()
	if h.timer.lastDelay() != 2000 {
		t.Fatalf("precondition 2 s, got %d", h.timer.lastDelay())
	}
	h.polling.SafeRefresh()
	if h.timer.lastDelay() != 5*60_000 {
		t.Errorf("manual refresh moves the tick to the period, got %d", h.timer.lastDelay())
	}
	if len(h.published) != 1 {
		t.Errorf("published=%d, want 1", len(h.published))
	}
}

func TestPollingManualRefreshAfterFailureArmsFastRetry(t *testing.T) {
	h := newHarness(failedResult("TaskCanceledException"))
	h.polling.Start()
	h.polling.SafeRefresh()
	if h.timer.lastDelay() != 30_000 {
		t.Errorf("manual refresh after failure arms 30 s, got %d", h.timer.lastDelay())
	}
}

func TestPollingStopCancelsPendingTick(t *testing.T) {
	h := newHarness(goodResult("a"))
	h.polling.Start()
	h.polling.Stop()
	h.fire()
	if len(h.published) != 0 {
		t.Errorf("stop cancels the pending tick, published=%d", len(h.published))
	}
}

// ---------------------------------------------------------------------------
// arm epoch and in-flight serialization (SPEC 16.5)
// ---------------------------------------------------------------------------

type blockingHarness struct {
	timer     *fakeTimer
	published []QuotaResult
	resolvers []chan QuotaResult
	polling   *Polling
	state     *AppState
	mu        sync.Mutex
	done      []chan struct{}
}

func newBlockingHarness() *blockingHarness {
	b := &blockingHarness{
		timer: &fakeTimer{},
		state: NewAppState(DefaultSettings(), "light"),
	}
	b.polling = NewPolling(PollingDeps{
		State: b.state,
		FetchQuota: func() QuotaResult {
			ch := make(chan QuotaResult, 1)
			b.mu.Lock()
			b.resolvers = append(b.resolvers, ch)
			b.mu.Unlock()
			r := <-ch
			return r
		},
		Publish: func(r QuotaResult) {
			b.mu.Lock()
			b.published = append(b.published, r)
			b.mu.Unlock()
		},
		SetTimer: b.timer.setTimer,
	})
	return b
}

func (b *blockingHarness) resolve(idx int, r QuotaResult) {
	b.mu.Lock()
	ch := b.resolvers[idx]
	b.mu.Unlock()
	ch <- r
}

func (b *blockingHarness) resolverCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.resolvers)
}

func TestInFlightTickMustNotCancelReschedule(t *testing.T) {
	b := newBlockingHarness()
	b.polling.Start()
	first := b.timer.shift()
	if first == nil || first.ms != 2000 {
		t.Fatalf("precondition: one 2 s tick, got %+v", first)
	}
	go first.run() // the tick's fetch is now in flight
	waitFor(t, func() bool { return b.resolverCount() == 1 })

	// Settings saved mid-fetch: reschedule arms a fresh 2 s tick.
	b.polling.Reschedule()
	if b.timer.lastDelay() != 2000 {
		t.Fatalf("reschedule arms 2 s, got %d", b.timer.lastDelay())
	}

	// The in-flight tick completes; without the epoch guard it would re-arm
	// 30 s/period over the reschedule's 2 s tick.
	b.resolve(0, goodResult("late"))
	waitFor(t, func() bool { return b.timer.lastDelay() == 2000 && b.timer.pending() == 1 })
}

func TestInFlightManualRefreshMustNotRearmOverReschedule(t *testing.T) {
	b := newBlockingHarness()
	b.polling.Start()

	done := make(chan QuotaResult, 1)
	go func() { done <- b.polling.SafeRefresh() }()
	waitFor(t, func() bool { return b.resolverCount() == 1 })

	b.polling.Reschedule()
	if b.timer.lastDelay() != 2000 {
		t.Fatalf("reschedule arms 2 s, got %d", b.timer.lastDelay())
	}
	b.resolve(0, goodResult("late"))
	<-done
	waitFor(t, func() bool { return b.timer.lastDelay() == 2000 && b.timer.pending() == 1 })
}

func TestManualRefreshQueuesBehindInFlightTick(t *testing.T) {
	b := newBlockingHarness()
	b.polling.Start()
	tick := b.timer.shift()
	go tick.run()
	waitFor(t, func() bool { return b.resolverCount() == 1 })

	done := make(chan QuotaResult, 1)
	go func() { done <- b.polling.SafeRefresh() }()

	// No second fetch while the first is still in flight.
	if b.resolverCount() != 1 {
		t.Fatalf("manual refresh must queue, resolvers=%d", b.resolverCount())
	}

	a := goodResult("a")
	a.FiveHour = &QuotaSegment{Percent: 1}
	b.resolve(0, a)
	waitFor(t, func() bool { return b.resolverCount() == 2 })

	b2 := goodResult("b")
	b2.FiveHour = &QuotaSegment{Percent: 2}
	b.resolve(1, b2)
	<-done

	// Publish order follows fetch order — the older result can never land last.
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.published) != 2 || b.published[0].FiveHour.Percent != 1 || b.published[1].FiveHour.Percent != 2 {
		t.Errorf("publish order: %+v", b.published)
	}
	if b.state.LastQuota() == nil || b.state.LastQuota().FiveHour.Percent != 2 {
		t.Errorf("lastQuota must hold the newest result: %+v", b.state.LastQuota())
	}
}

func TestAppStateDefaults(t *testing.T) {
	s := NewAppState(DefaultSettings(), "dark")
	if s.LastQuota() != nil || s.SkillsCache() != nil || s.LastManualRefreshMs() != nil {
		t.Errorf("fresh state must be empty: %+v", s)
	}
	if s.EffectiveTheme() != "dark" || s.Update().CheckFailed || s.Update().UpdateAvailable {
		t.Errorf("fresh state fields: %+v", s)
	}
	if !strings.Contains(SettingsToJSONText(s.Settings()), `"Theme": "system"`) {
		t.Errorf("settings shape: %s", SettingsToJSONText(s.Settings()))
	}
}

// M1 review Minor 3: between two serialized refreshes the LATER finisher
// decides the next delay, exactly like Rust's retime notify — a tick failure
// (30 s) must not survive a queued manual success (period).
func TestQueuedManualRefreshRetimeWins(t *testing.T) {
	b := newBlockingHarness()
	b.polling.Start()
	tick := b.timer.shift()
	go tick.run()
	waitFor(t, func() bool { return b.resolverCount() == 1 })

	done := make(chan QuotaResult, 1)
	go func() { done <- b.polling.SafeRefresh() }()

	// The tick's fetch fails: its own completion arms the 30 s fast retry,
	// and only then does the queued manual fetch start.
	b.resolve(0, failedResult("HttpRequestException"))
	waitFor(t, func() bool { return b.timer.lastDelay() == 30_000 })
	waitFor(t, func() bool { return b.resolverCount() == 2 })

	// The queued manual refresh succeeds: the period must win.
	b.resolve(1, goodResult("manual"))
	<-done
	waitFor(t, func() bool { return b.timer.lastDelay() == 5*60_000 })
}

// waitFor polls cond with a deadline; a plain sleep would make the epoch
// tests flaky, a busy loop without deadline would hang on regression.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(500 * time.Microsecond)
	}
	t.Fatal("condition not reached within 2 s")
}
