// Refresh scheduling, a port of QuotaService.SafeRefresh/Reschedule
// (SPEC 16.5): first refresh 2 s after start, period = max(1,
// RefreshMinutes), failure keeps last-known-good data and retries fast after
// 30 s, and every refresh moves the next tick. The clock and timer are
// injected so the timing rules are testable.
//
// Completion-vs-reschedule rule: a refresh that finishes after a Reschedule
// must not re-arm over it (the Rust reference drains its stale retime hint,
// polling.rs:48-62), but between two serialized refreshes the LATER finisher
// decides the next delay, exactly like Rust's retime notify (polling.rs:24-36)
// — the 2026-09-25 M1 review caught an epoch guard here that silently dropped
// the queued refresh's retime, deviating from the oracle.
//
// Go has no setTimeout-style 24.8-day / 32-bit ceiling: a huge RefreshMinutes
// saturates through msToDuration instead of wrapping negative — the Rust
// "big number = long sleep" direction (REVIEW-M1 Major A / PLAN-GO §4.4).
package core

import (
	"math"
	"sync"
	"time"
)

const (
	firstDelayMs   = int64(2_000)
	failureRetryMs = int64(30_000)
	msPerMinute    = int64(60_000)
)

// msToDuration saturates instead of overflowing int64 nanoseconds.
func msToDuration(ms int64) time.Duration {
	if ms > int64(math.MaxInt64)/int64(time.Millisecond) {
		return time.Duration(math.MaxInt64)
	}
	return time.Duration(ms) * time.Millisecond
}

// periodMs: minutes clamped to at least 1, then saturating * 60_000.
func periodMs(refreshMinutes int64) int64 {
	if refreshMinutes < 1 {
		refreshMinutes = 1
	}
	if refreshMinutes > math.MaxInt64/msPerMinute {
		return math.MaxInt64
	}
	return refreshMinutes * msPerMinute
}

// PollingDeps carries the injected seams.
type PollingDeps struct {
	State      *AppState
	FetchQuota func() QuotaResult                         // may block; the real one wraps quota.FetchQuota
	Publish    func(QuotaResult)                          // pushes the result to the UI
	SetTimer   func(ms int64, run func()) (cancel func()) // nil -> a real timer
}

// Polling owns the refresh schedule.
type Polling struct {
	deps PollingDeps

	mu           sync.Mutex
	running      bool
	next         int64
	cancelTimer  func()
	staleRetime  *int64
	reschedEpoch uint64 // bumped by Reschedule; late completions yield to it

	fetchMu sync.Mutex // serializes fetches: a manual refresh queues behind a tick
}

// NewPolling builds a Polling; call Start to arm the first 2 s tick.
func NewPolling(deps PollingDeps) *Polling {
	return &Polling{deps: deps}
}

func realSetTimer(ms int64, run func()) (cancel func()) {
	timer := time.AfterFunc(msToDuration(ms), run)
	return func() { timer.Stop() }
}

// arm replaces the pending tick. Callers must hold p.mu.
func (p *Polling) arm(ms int64) {
	if p.cancelTimer != nil {
		p.cancelTimer()
		p.cancelTimer = nil
	}
	p.next = ms
	if p.running {
		set := p.deps.SetTimer
		if set == nil {
			set = realSetTimer
		}
		p.cancelTimer = set(ms, p.tick)
	}
}

func (p *Polling) retimeFor(result QuotaResult) int64 {
	if result.Error != nil {
		return failureRetryMs
	}
	return periodMs(p.deps.State.Settings().RefreshMinutes)
}

// tick runs on the timer (a goroutine in production, synchronous in tests
// that inject SetTimer): refresh, then re-arm at the retime rule unless a
// reschedule superseded this cycle.
func (p *Polling) tick() {
	p.mu.Lock()
	resched := p.reschedEpoch
	p.mu.Unlock()

	result := p.refreshSerialized()

	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.running || p.reschedEpoch != resched {
		return
	}
	p.staleRetime = nil
	p.arm(p.retimeFor(result))
}

// fetchAndPublish is one refresh: fetch, keep-last-good on failure, publish,
// leave the retime hint. Callers must hold p.fetchMu.
func (p *Polling) fetchAndPublish() QuotaResult {
	result := p.deps.FetchQuota()
	if last := p.deps.State.LastQuota(); result.Error != nil && last != nil {
		FillMissingFrom(&result, last)
	}
	p.deps.State.SetLastQuota(&result)
	if p.deps.Publish != nil {
		p.deps.Publish(result)
	}
	hint := p.retimeFor(result)
	p.mu.Lock()
	h := hint
	p.staleRetime = &h
	p.mu.Unlock()
	return result
}

func (p *Polling) refreshSerialized() QuotaResult {
	p.fetchMu.Lock()
	defer p.fetchMu.Unlock()
	return p.fetchAndPublish()
}

// Start arms the first refresh 2 s out; idempotent.
func (p *Polling) Start() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running {
		return
	}
	p.running = true
	p.arm(firstDelayMs)
}

// Stop cancels the pending tick; a running fetch still finishes.
func (p *Polling) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.running = false
	if p.cancelTimer != nil {
		p.cancelTimer()
		p.cancelTimer = nil
	}
}

// SafeRefresh is one refresh + keep-last-good + publish + retime; used by the
// timer and the manual `r` key. It moves the scheduled tick to its own retime
// rule — later finisher wins between serialized refreshes — unless a
// reschedule happened while it was in flight.
func (p *Polling) SafeRefresh() QuotaResult {
	p.mu.Lock()
	resched := p.reschedEpoch
	p.mu.Unlock()

	result := p.refreshSerialized()

	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.running || p.reschedEpoch != resched || p.staleRetime == nil {
		return result
	}
	p.arm(*p.staleRetime)
	return result
}

// Reschedule is "settings saved": restart the cycle with the 2 s first delay
// and drain a stale retime hint (a leftover delay would otherwise overwrite
// the 2 s first-refresh tick).
func (p *Polling) Reschedule() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reschedEpoch++
	p.staleRetime = nil
	if p.running {
		p.arm(firstDelayMs)
	} else {
		p.next = firstDelayMs
	}
}

// NextDelayMs reports the currently armed delay (test seam).
func (p *Polling) NextDelayMs() int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.next
}
