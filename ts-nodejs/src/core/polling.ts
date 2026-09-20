// Refresh scheduling, a 1:1 port of rust/src/polling.rs (SPEC 16.5):
// first refresh 2 s after start, period = max(1, refresh_minutes), a failure
// keeps the last-known-good data and retries after 30 s, and every refresh moves
// the next tick. The clock is injected so the timing rules are testable.

import { fillMissingFrom, type QuotaResult } from "./quota.ts";
import type { AppState } from "./state.ts";

const FIRST_DELAY_MS = 2_000;
const FAILURE_RETRY_MS = 30_000;

export interface PollingDeps {
  state: AppState;
  fetchQuota: () => Promise<QuotaResult>;
  publish: (result: QuotaResult) => void;
  now?: () => number;
  setTimer?: (ms: number, run: () => void) => () => void;
}

export interface Polling {
  start(): void;
  stop(): void;
  /** One refresh + keep-last-good + publish + retime; used by the timer and `r`. */
  safeRefresh(): Promise<QuotaResult>;
  /** Settings saved: restart the cycle with the 2 s first delay. */
  reschedule(): void;
  nextDelayMs(): number;
}

const realTimer = (ms: number, run: () => void): (() => void) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

export function createPolling(deps: PollingDeps): Polling {
  const setTimer = deps.setTimer ?? realTimer;
  let cancel: (() => void) | null = null;
  let next = FIRST_DELAY_MS;
  let staleRetimeMs: number | null = null;
  let running = false;

  const periodMs = (): number =>
    Math.max(1, deps.state.settings.refreshMinutes) * 60_000;

  const arm = (ms: number): void => {
    if (cancel !== null) cancel();
    next = ms;
    cancel = running ? setTimer(ms, () => void tick()) : null;
  };

  const tick = async (): Promise<void> => {
    const result = await safeRefresh();
    if (!running) return;
    // The retime hint a refresh leaves behind is the same delay this computes
    // (polling.rs:65-70); draining it keeps a reschedule from being overwritten.
    staleRetimeMs = null;
    arm(result.error !== null ? FAILURE_RETRY_MS : periodMs());
  };

  async function safeRefresh(): Promise<QuotaResult> {
    const result = await deps.fetchQuota();
    if (result.error !== null && deps.state.lastQuota !== null) {
      fillMissingFrom(result, deps.state.lastQuota);
    }
    deps.state.lastQuota = result;
    deps.publish(result);
    staleRetimeMs = result.error !== null ? FAILURE_RETRY_MS : periodMs();
    return result;
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      arm(FIRST_DELAY_MS);
    },
    stop(): void {
      running = false;
      if (cancel !== null) cancel();
      cancel = null;
    },
    async safeRefresh(): Promise<QuotaResult> {
      const result = await safeRefresh();
      // A manual refresh moves the scheduled tick, like the retime notify does.
      if (running) arm(staleRetimeMs ?? next);
      return result;
    },
    reschedule(): void {
      staleRetimeMs = null;
      if (running) arm(FIRST_DELAY_MS);
      else next = FIRST_DELAY_MS;
    },
    nextDelayMs(): number {
      return next;
    },
  };
}
