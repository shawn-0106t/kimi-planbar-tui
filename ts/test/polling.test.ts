import { describe, expect, test } from "bun:test";
import { createPolling } from "../src/core/polling.ts";
import { createAppState } from "../src/core/state.ts";
import { defaultSettings } from "../src/core/settings.ts";
import { dtFromParts, serdePrettyJson } from "../src/core/json.ts";
import { quotaResultToSerde, type QuotaResult } from "../src/core/quota.ts";

const AT = dtFromParts(1_893_456_000_000, 0);

const result = (error: string | null, label: string): QuotaResult => ({
  fiveHour: error === null ? { percent: 21, resetAt: null } : null,
  week: error === null ? { percent: 18, resetAt: null } : null,
  extra: error === null ? { state: "Ready", balanceCents: 1n, monthlyEnabled: false, monthlyUsedCents: null, monthlyLimitCents: null } : null,
  fetchedAt: AT,
  error,
});

interface Harness {
  scheduled: { ms: number; run: () => void }[];
  published: QuotaResult[];
  fire: () => Promise<void>;
  polling: ReturnType<typeof createPolling>;
  state: ReturnType<typeof createAppState>;
  queue: (r: QuotaResult) => void;
}

const harness = (first: QuotaResult = result(null, "a")): Harness => {
  const scheduled: { ms: number; run: () => void }[] = [];
  const published: QuotaResult[] = [];
  const queue: QuotaResult[] = [first];
  const state = createAppState(defaultSettings(), "light");
  const polling = createPolling({
    state,
    fetchQuota: async () => queue.shift() ?? result(null, "x"),
    publish: (r) => void published.push(r),
    setTimer: (ms, run) => {
      scheduled.push({ ms, run });
      return () => {
        const at = scheduled.findIndex((s) => s.run === run);
        if (at >= 0) scheduled.splice(at, 1);
      };
    },
  });
  return {
    scheduled,
    published,
    polling,
    state,
    queue: (r) => void queue.push(r),
    fire: async () => {
      const next = scheduled.shift();
      // A macrotask flush: the serialized refresh chain takes a few more
      // microtask hops than a bare await can drain before the tick re-arms.
      if (next) await next.run();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
};

const lastDelay = (h: Harness): number => h.scheduled[h.scheduled.length - 1]!.ms;

describe("polling schedule (SPEC 16.5)", () => {
  test("the first refresh fires two seconds after start", () => {
    const h = harness();
    h.polling.start();
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]!.ms).toBe(2000);
    expect(h.published).toHaveLength(0);
  });

  test("a success re-arms at the configured period", async () => {
    const h = harness();
    h.polling.start();
    await h.fire();
    expect(lastDelay(h)).toBe(5 * 60_000);
    expect(h.published).toHaveLength(1);
    expect(h.state.lastQuota).not.toBeNull();
  });

  test("a failure re-arms after 30 seconds", async () => {
    const h = harness(result("HttpRequestException", "bad"));
    h.polling.start();
    await h.fire();
    expect(lastDelay(h)).toBe(30_000);
  });

  test("the period is read when the tick is scheduled, so a save takes effect", async () => {
    const h = harness();
    h.polling.start();
    await h.fire();
    h.state.settings.refreshMinutes = 30;
    await h.fire();
    expect(lastDelay(h)).toBe(30 * 60_000);
  });

  test("refresh_minutes below one is floored to one minute", async () => {
    const h = harness();
    h.state.settings.refreshMinutes = 0;
    h.polling.start();
    await h.fire();
    expect(lastDelay(h)).toBe(60_000);
  });

  test("an above-ceiling period clamps to the setTimeout maximum", async () => {
    const h = harness();
    h.state.settings.refreshMinutes = Number.MAX_SAFE_INTEGER;
    h.polling.start();
    await h.fire();
    // Unclamped, 2^53 * 60_000 overflows the int32 setTimeout and would
    // reschedule at 1 ms — a hot loop hammering the API.
    expect(lastDelay(h)).toBe(2_147_483_647);
  });
});

describe("keep-last-good (SPEC 16.5 step 2)", () => {
  test("a failed refresh keeps the previous data and the new stamp", async () => {
    const h = harness();
    h.polling.start();
    await h.fire(); // good
    h.queue(result("HttpRequestException", "bad"));
    await h.fire();
    const last = h.published[h.published.length - 1]!;
    expect(last.error).toBe("HttpRequestException");
    expect(last.fiveHour?.percent).toBe(21); // filled from last-good
    expect(last.fetchedAt).toBe(AT);
  });

  test("the first failure with nothing cached stays empty", async () => {
    const h = harness(result("no-token", "none"));
    h.polling.start();
    await h.fire();
    const last = h.published[0]!;
    expect(last.fiveHour).toBeNull();
    expect(last.error).toBe("no-token");
  });
});

describe("reschedule and manual refresh", () => {
  test("reschedule forces the 2 second delay and drains a stale hint", async () => {
    const h = harness(result("HttpRequestException", "bad"));
    h.polling.start();
    await h.fire(); // failure => 30s pending
    expect(lastDelay(h)).toBe(30_000);
    h.polling.reschedule();
    expect(lastDelay(h)).toBe(2000);
    await h.fire();
    expect(h.published).toHaveLength(2);
  });

  test("a manual refresh moves the next tick to the same rule", async () => {
    const h = harness();
    h.polling.start();
    expect(lastDelay(h)).toBe(2000);
    await h.polling.safeRefresh();
    expect(lastDelay(h)).toBe(5 * 60_000);
    expect(h.published).toHaveLength(1);
  });

  test("a manual refresh after a failure arms the fast retry", async () => {
    const h = harness(result("TaskCanceledException", "slow"));
    h.polling.start();
    await h.polling.safeRefresh();
    expect(lastDelay(h)).toBe(30_000);
  });

  test("stop cancels the pending tick", async () => {
    const h = harness();
    h.polling.start();
    h.polling.stop();
    await h.fire();
    expect(h.published).toHaveLength(0);
  });
});

describe("arm epoch and in-flight serialization (SPEC 16.5)", () => {
  /** A harness whose fetches stay in flight until the test resolves them. */
  const blockingHarness = () => {
    const scheduled: { ms: number; run: () => void }[] = [];
    const published: QuotaResult[] = [];
    const resolvers: ((r: QuotaResult) => void)[] = [];
    const state = createAppState(defaultSettings(), "light");
    const polling = createPolling({
      state,
      fetchQuota: () => new Promise<QuotaResult>((res) => resolvers.push(res)),
      publish: (r) => void published.push(r),
      setTimer: (ms, run) => {
        scheduled.push({ ms, run });
        return () => {
          const at = scheduled.findIndex((s) => s.run === run);
          if (at >= 0) scheduled.splice(at, 1);
        };
      },
    });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { scheduled, published, resolvers, state, polling, flush };
  };

  test("an in-flight tick must not cancel a reschedule armed while it awaited", async () => {
    const h = blockingHarness();
    h.polling.start();
    const first = h.scheduled.shift()!;
    expect(first.ms).toBe(2000);
    first.run(); // the tick's fetch is now in flight
    // Settings saved mid-fetch: reschedule arms a fresh 2s tick.
    h.polling.reschedule();
    expect(lastDelayMs(h.scheduled)).toBe(2000);
    // The in-flight tick completes; without the epoch guard it would re-arm
    // 30s/period over the reschedule's 2s tick.
    h.resolvers[0]!(result(null, "late"));
    await h.flush();
    expect(lastDelayMs(h.scheduled)).toBe(2000);
  });

  test("an in-flight manual refresh must not re-arm over a reschedule", async () => {
    const h = blockingHarness();
    h.polling.start();
    const manual = h.polling.safeRefresh();
    h.polling.reschedule();
    expect(lastDelayMs(h.scheduled)).toBe(2000);
    h.resolvers[0]!(result(null, "late"));
    await manual;
    expect(lastDelayMs(h.scheduled)).toBe(2000);
  });

  test("a manual refresh queues behind an in-flight tick instead of racing it", async () => {
    const h = blockingHarness();
    h.polling.start();
    h.scheduled.shift()!.run(); // tick fetch #1 in flight
    const manual = h.polling.safeRefresh();
    // No second fetch while the first is still in flight.
    expect(h.resolvers).toHaveLength(1);
    const a = result(null, "a");
    a.fiveHour!.percent = 1;
    h.resolvers[0]!(a);
    await h.flush(); // the queued manual fetch starts now
    expect(h.resolvers).toHaveLength(2);
    const b = result(null, "b");
    b.fiveHour!.percent = 2;
    h.resolvers[1]!(b);
    await manual;
    // Publish order follows fetch order — the older result can never land last.
    expect(h.published.map((r) => r.fiveHour!.percent)).toEqual([1, 2]);
    expect(h.state.lastQuota!.fiveHour!.percent).toBe(2);
  });
});

const lastDelayMs = (scheduled: { ms: number }[]): number => scheduled[scheduled.length - 1]!.ms;

test("the published shape is what --test-fetch prints", async () => {
  const h = harness();
  h.polling.start();
  await h.fire();
  expect(serdePrettyJson(quotaResultToSerde(h.published[0]!))).toContain('"percent": 21.0');
});
