import { describe, expect, test } from "bun:test";
import {
  fillMissingFrom,
  parseExtra,
  parseQuotaPayload,
  parseResetTime,
  parseSegment,
  quotaResultToSerde,
  fetchQuota,
  type QuotaResult,
} from "../src/core/quota.ts";
import { dtFromParts, parseJsonValue, serdePrettyJson, type JValue, type RustDateTime } from "../src/core/json.ts";
import { goldenPairs, goldenRows, goldenText, timezoneMatchesGolden } from "./goldens.ts";

const parse = (text: string): JValue => parseJsonValue(text);
const AT = dtFromParts(1_893_456_000_000, 123_456_789);
const AT_ZERO = dtFromParts(1_893_456_000_000, 0);

describe("parseSegment (SPEC 16.3)", () => {
  test("segment_accepts_mixed_string_and_number_fields", () => {
    const asStrings = parseSegment(
      parse('{"used":"68","limit":"100","resetTime":"2030-01-01T00:00:00+08:00"}'),
    );
    const asNumbers = parseSegment(
      parse('{"used":68,"limit":100,"resetTime":"2030-01-01T00:00:00+08:00"}'),
    );
    expect(asStrings.percent).toBe(68);
    expect(asNumbers.percent).toBe(68);
    expect(asStrings.resetAt).not.toBeNull();
    expect(asNumbers.resetAt).not.toBeNull();
  });

  test("segment_guards_division_by_zero", () => {
    expect(parseSegment(parse('{"used":"50","limit":"0"}')).percent).toBe(5000);
    expect(parseSegment(parse('{"used":"1e999","limit":1}')).percent).toBe(0);
    const missing = parseSegment(parse("{}"));
    expect(missing.percent).toBe(0);
    expect(missing.resetAt).toBeNull();
  });
});

describe("parseExtra (SPEC 16.3)", () => {
  test("disabled_wallet_is_not_activated", () => {
    const info = parseExtra(parse('{"isEnabled":false,"balance":{"amountLeft":"123456789"}}'));
    expect(info.state).toBe("NotActivated");
    expect(info.balanceCents).toBeNull();
    expect(parseExtra(undefined).state).toBe("NotActivated");
    expect(parseExtra(parse('"nope"')).state).toBe("NotActivated");
    expect(parseExtra(parse("null")).state).toBe("NotActivated");
  });

  test("amount_left_unit_conversion_rounds", () => {
    const str = parseExtra(parse('{"isEnabled":true,"balance":{"amountLeft":"123456789"}}'));
    expect(str.state).toBe("Ready");
    expect(str.balanceCents).toBe(123n);
    const num = parseExtra(parse('{"isEnabled":true,"balance":{"amountLeft":1500000}}'));
    expect(num.balanceCents).toBe(2n);
    const junk = parseExtra(parse('{"isEnabled":true,"balance":{"amountLeft":"not-a-number"}}'));
    expect(junk.state).toBe("NoData");
    expect(junk.balanceCents).toBeNull();
  });

  test("monthly_charge_fields", () => {
    const on = parseExtra(
      parse(
        '{"isEnabled":true,"balance":{"amountLeft":"100000000"},"monthlyChargeLimitEnabled":true,"monthlyUsed":{"priceInCents":"4567"},"monthlyChargeLimit":{"priceInCents":10000}}',
      ),
    );
    expect(on.monthlyEnabled).toBe(true);
    expect(on.monthlyUsedCents).toBe(4567n);
    expect(on.monthlyLimitCents).toBe(10000n);
    const off = parseExtra(
      parse('{"isEnabled":true,"balance":{"amountLeft":"100000000"},"monthlyChargeLimitEnabled":false}'),
    );
    expect(off.monthlyEnabled).toBe(false);
    expect(off.monthlyUsedCents).toBeNull();
  });
});

describe("parseResetTime (SPEC 16.3)", () => {
  test("reset_time_formats, ported from rust/src/quota.rs", () => {
    expect(parseResetTime("2030-01-01T00:00:00+08:00")).not.toBeNull();
    expect(parseResetTime("2030-01-01 00:00:00 +08:00")).not.toBeNull();
    expect(parseResetTime("2030-01-01 00:00:00")).not.toBeNull();
    expect(parseResetTime("not a date")).toBeNull();
  });

  test("the whole acceptance ladder prints chrono's text", () => {
    if (!timezoneMatchesGolden()) throw new Error("goldens need TZ=Asia/Shanghai");
    for (const [raw, printed] of goldenRows("reset_time")) {
      const parsed = parseResetTime(raw!);
      const expected = printed!.replace(/^"|"$/g, "");
      if (raw === "2030-01-01T00:00:00.5") {
        // chrono's naive patterns carry no %.f, so a fraction without offset fails
        expect(parsed).toBeNull();
        continue;
      }
      if (expected === "None") {
        expect(parsed).toBeNull();
        continue;
      }
      expect(parsed).not.toBeNull();
      expect(serdePrettyJson({ kind: "dt", value: parsed! })).toBe(printed);
    }
  });
});

describe("fillMissingFrom (SPEC 16.5 step 2)", () => {
  test("only the three data fields are filled; stamp and error stay", () => {
    const last = parseQuotaPayload(
      parse('{"limits":[{"detail":{"used":"21","limit":"100"}}],"usage":{"used":"18","limit":"100"}}'),
      AT,
    );
    const fresh: QuotaResult = {
      fiveHour: null,
      week: null,
      extra: null,
      fetchedAt: AT_ZERO,
      error: "HttpRequestException",
    };
    fillMissingFrom(fresh, last);
    expect(fresh.fiveHour).not.toBeNull();
    expect(fresh.week).not.toBeNull();
    expect(fresh.extra).not.toBeNull(); // last.extra is Some on a successful fetch
    expect(fresh.fetchedAt).toBe(AT_ZERO);
    expect(fresh.error).toBe("HttpRequestException");
  });
});

describe("--test-fetch text equals the Rust oracle byte for byte", () => {
  const goldenFiles = [
    "quota-success_full",
    "quota-mixed_string_number",
    "quota-div_zero",
    "quota-neg_limit",
    "quota-hostile_inf",
    "quota-hostile_nan",
    "quota-nan_limit",
    "quota-empty",
    "quota-limits_not_array",
    "quota-detail_string",
    "quota-usage_null",
    "quota-usage_string",
    "quota-disabled_wallet",
    "quota-isenabled_string_false",
    "quota-isenabled_zero",
    "quota-no_wallet",
    "quota-wallet_string",
    "quota-amount_frac_number",
    "quota-amount_negative_round",
    "quota-amount_negative_round2",
    "quota-amount_huge",
    "quota-nodata_monthly_on",
    "quota-monthly_off_but_present",
    "quota-monthly_string_true",
    "quota-reset_fraction",
    "quota-error-no-token",
    "quota-error-HttpRequestException",
    "quota-error-TaskCanceledException",
    "quota-error-JsonException",
    "quota-fill-missing",
  ];

  const payloads = new Map<string, string>([
    ["quota-success_full", '{"limits":[{"detail":{"used":"21","limit":"100","resetTime":"2030-01-01T00:00:00+08:00"}}],"usage":{"used":18.5,"limit":100,"resetTime":"2030-01-08 00:00:00 +08:00"},"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"1234567890"},"monthlyChargeLimitEnabled":true,"monthlyUsed":{"priceInCents":"4567"},"monthlyChargeLimit":{"priceInCents":10000}}}'],
    ["quota-mixed_string_number", '{"limits":[{"detail":{"used":"68","limit":"100","resetTime":"2030-01-01T00:00:00+08:00"}}],"usage":{"used":68,"limit":100}}'],
    ["quota-div_zero", '{"limits":[{"detail":{"used":"50","limit":"0"}}]}'],
    ["quota-neg_limit", '{"limits":[{"detail":{"used":"50","limit":-100}}]}'],
    ["quota-hostile_inf", '{"usage":{"used":"1e999","limit":1}}'],
    ["quota-hostile_nan", '{"usage":{"used":"NaN","limit":1}}'],
    ["quota-nan_limit", '{"usage":{"used":"5","limit":"NaN"}}'],
    ["quota-empty", "{}"],
    ["quota-limits_not_array", '{"limits":{"detail":{"used":"1","limit":"2"}}}'],
    ["quota-detail_string", '{"limits":[{"detail":"nope"}]}'],
    ["quota-usage_null", '{"usage":null}'],
    ["quota-usage_string", '{"usage":"nope"}'],
    ["quota-disabled_wallet", '{"boosterWallet":{"isEnabled":false,"balance":{"amountLeft":"123456789"}}}'],
    ["quota-isenabled_string_false", '{"boosterWallet":{"isEnabled":"false","balance":{"amountLeft":"123456789"}}}'],
    ["quota-isenabled_zero", '{"boosterWallet":{"isEnabled":0,"balance":{"amountLeft":"1500000"}}}'],
    ["quota-no_wallet", '{"boosterWallet":null}'],
    ["quota-wallet_string", '{"boosterWallet":"nope"}'],
    ["quota-amount_frac_number", '{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":1500000.7}}}'],
    ["quota-amount_negative_round", '{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"-1499999"}}}'],
    ["quota-amount_negative_round2", '{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"-1500001"}}}'],
    ["quota-amount_huge", '{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"9223372036854775807"}}}'],
    ["quota-nodata_monthly_on", '{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"not-a-number"},"monthlyChargeLimitEnabled":true,"monthlyUsed":{"priceInCents":"4567"},"monthlyChargeLimit":{"priceInCents":10000}}}'],
    ["quota-monthly_off_but_present", '{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"100000000"},"monthlyUsed":{"priceInCents":"4567"}}}'],
    ["quota-monthly_string_true", '{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"100000000"},"monthlyChargeLimitEnabled":"true","monthlyUsed":{"priceInCents":"4567"}}}'],
    ["quota-reset_fraction", '{"limits":[{"detail":{"used":"1","limit":"3","resetTime":"2030-01-01T00:00:00.123456789+08:00"}}],"usage":{"used":"1","limit":"3","resetTime":"2030-01-02T00:00:00.500Z"}}'],
  ]);

  for (const name of goldenFiles) {
    test(name, () => {
      if (!timezoneMatchesGolden()) throw new Error("goldens need TZ=Asia/Shanghai");
      const expected = goldenText(name);
      let got: string;
      if (name.startsWith("quota-error-")) {
        const kind = name.slice("quota-error-".length);
        got = serdePrettyJson(
          quotaResultToSerde({ fiveHour: null, week: null, extra: null, fetchedAt: AT_ZERO, error: kind }),
        );
      } else if (name === "quota-fill-missing") {
        const last = parseQuotaPayload(parse(payloads.get("quota-success_full")!), AT);
        const fresh: QuotaResult = {
          fiveHour: null,
          week: null,
          extra: null,
          fetchedAt: AT_ZERO,
          error: "HttpRequestException",
        };
        fillMissingFrom(fresh, last);
        got = serdePrettyJson(quotaResultToSerde(fresh));
      } else {
        got = serdePrettyJson(
          quotaResultToSerde(parseQuotaPayload(parse(payloads.get(name)!), AT)),
        );
      }
      expect(got).toBe(expected);
    });
  }
});

describe("fetchQuota error taxonomy (SPEC 16.4)", () => {
  const ok = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } });

  test("no token short-circuits before any request", async () => {
    let called = 0;
    const r = await fetchQuota({
      token: null,
      fetchImpl: (async () => {
        called++;
        return ok("{}");
      }) as typeof fetch,
      nowMs: () => 1_893_456_000_000,
    });
    expect(called).toBe(0);
    expect(r.error).toBe("no-token");
    expect(r.fiveHour).toBeNull();
    expect(r.extra).toBeNull();
  });

  test("non-2xx is an HttpRequestException and the body is never read", async () => {
    const response = new Response("junk", { status: 500 });
    const r = await fetchQuota({
      token: "t",
      fetchImpl: (async () => response) as typeof fetch,
    });
    expect(r.error).toBe("HttpRequestException");
    expect(response.bodyUsed).toBe(false);
  });

  test("a rejected request maps by timeout-ness", async () => {
    const timeout = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    const other = Object.assign(new Error("bad gateway"), { name: "TypeError" });
    for (const [err, expected] of [
      [timeout, "TaskCanceledException"],
      [other, "HttpRequestException"],
    ] as const) {
      const r = await fetchQuota({
        token: "t",
        fetchImpl: (async () => {
          throw err;
        }) as typeof fetch,
      });
      expect(r.error).toBe(expected);
    }
  });

  test("unparseable JSON is a JsonException", async () => {
    const r = await fetchQuota({ token: "t", fetchImpl: (async () => ok("<html>")) as typeof fetch });
    expect(r.error).toBe("JsonException");
  });

  test("a success payload fills all three data fields", async () => {
    const r = await fetchQuota({
      token: "t",
      url: "http://127.0.0.1:9/usages",
      fetchImpl: (async (input) => {
        expect(String(input)).toBe("http://127.0.0.1:9/usages");
        return ok(payloadsForFetch());
      }) as typeof fetch,
      nowMs: () => 1_893_456_000_000,
    });
    expect(r.error).toBeNull();
    expect(r.fiveHour?.percent).toBe(21);
    expect(r.extra?.state).toBe("Ready");
    expect(r.fetchedAt).toEqual({ ms: 1_893_456_000_000, nanos: 0 });
  });
});

const payloadsForFetch = (): string =>
  '{"limits":[{"detail":{"used":"21","limit":"100"}}],"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"1000000"}}}';

describe("the bearer header is built the way SPEC 16.1 says", () => {
  test("Authorization and Accept headers, GET only", async () => {
    let seen: Headers | null = null;
    let method = "";
    await fetchQuota({
      token: "abc123",
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        method = init?.method ?? "";
        return ok("{}");
      }) as typeof fetch,
    });
    expect(method).toBe("GET");
    expect(seen?.get("Authorization")).toBe("Bearer abc123");
    expect(seen?.get("Accept")).toBe("application/json");
  });
});
