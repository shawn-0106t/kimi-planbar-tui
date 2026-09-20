// Quota fetch + defensive parsing, a 1:1 port of rust/src/quota.rs (SPEC 16).
// Traps kept:
//  - server JSON numbers are modeled as strings, numeric fallback tolerated
//  - amountLeft is 1e-8 yuan -> cents = (raw + 500000) / 1000000
//  - isEnabled == false must read as NotActivated, not as a balance

import { loadToken } from "./credentials.ts";
import {
  jAsArray,
  jAsBool,
  jAsI64,
  jIsObject,
  parseF64Strict,
  parseI64Strict,
  parseJsonValue,
  rustTrim,
  saturatingAddI64,
  serBool,
  serDt,
  serF64,
  serI64,
  serObj,
  serStr,
  dtFromNow,
  type JValue,
  type RustDateTime,
  type SerNode,
} from "./json.ts";

const USAGES_URL = "https://api.kimi.com/coding/v1/usages";
const HTTP_TIMEOUT_MS = 10_000;

export interface QuotaSegment {
  percent: number;
  resetAt: RustDateTime | null;
}

/** PascalCase on purpose: the enum has no rename_all, so serde prints the
 *  variant names verbatim and --test-fetch diffs against them (SPEC 16.4). */
export type ExtraState = "NotActivated" | "NoData" | "Ready";

export interface ExtraInfo {
  state: ExtraState;
  balanceCents: bigint | null;
  monthlyEnabled: boolean;
  monthlyUsedCents: bigint | null;
  monthlyLimitCents: bigint | null;
}

export interface QuotaResult {
  fiveHour: QuotaSegment | null;
  week: QuotaSegment | null;
  extra: ExtraInfo | null;
  fetchedAt: RustDateTime;
  error: string | null;
}

const failed = (kind: string): QuotaResult => ({
  fiveHour: null,
  week: null,
  extra: null,
  fetchedAt: dtFromNow(),
  error: kind,
});

/** On failure keep last-known-good data (SPEC 16.5 step 2). `fetchedAt` and
 *  `error` are never replaced, so the stamp stays the failure time. */
export function fillMissingFrom(result: QuotaResult, last: QuotaResult): void {
  if (result.fiveHour === null) result.fiveHour = last.fiveHour;
  if (result.week === null) result.week = last.week;
  if (result.extra === null) result.extra = last.extra;
}

/** JSON number-or-string -> f64, missing or junk -> 0. */
function getF64(v: JValue | undefined, key: string): number {
  if (v?.kind !== "obj") return 0;
  const field = v.members.get(key);
  if (field?.kind === "num") return field.value;
  if (field?.kind === "str") return parseF64Strict(rustTrim(field.value)) ?? 0;
  return 0;
}

/** JSON number-or-string -> i64, anything else -> nothing. */
function getI64(v: JValue | undefined): bigint | null {
  if (v === undefined) return null;
  if (v.kind === "num") return jAsI64(v);
  if (v.kind === "str") return parseI64Strict(rustTrim(v.value));
  return null;
}

function parseCents(money: JValue | undefined): bigint | null {
  if (!jIsObject(money)) return null;
  return getI64(money.members.get("priceInCents"));
}

const pad9 = (fraction: string | undefined): number =>
  Number((fraction ? fraction.slice(1).padEnd(9, "0") : "0").slice(0, 9));

interface DateTimeFields {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  nanos: number;
  offsetMinutes: number | null;
}

/** Both patterns below share one group layout: 1..3 date, 4..6 time,
 *  7 fraction, 8 offset sign, 9..10 offset hours/minutes. */
const fieldsOf = (groups: string[], offsetMinutes: number | null): DateTimeFields => ({
  y: Number(groups[1]),
  mo: Number(groups[2]),
  d: Number(groups[3]),
  h: Number(groups[4]),
  mi: Number(groups[5]),
  s: Number(groups[6]),
  nanos: pad9(groups[7]),
  offsetMinutes,
});

// RFC 3339 first, then the looser shapes chrono's format list accepts: a space
// or `T` between date and time, an optional fraction, and an offset written
// `+08:00` or `+0800` with or without a preceding space (chrono's literal space
// matches zero whitespace). No offset at all means local wall time.
const WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)? ?([+-])(\d{2}):?(\d{2})$/;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})$/;

/** The instant as UTC epoch ms, or null when the calendar date does not exist. */
function instantOf(fields: DateTimeFields): number | null {
  const utc = Date.UTC(fields.y, fields.mo - 1, fields.d, fields.h, fields.mi, fields.s);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== fields.y ||
    check.getUTCMonth() !== fields.mo - 1 ||
    check.getUTCDate() !== fields.d
  ) {
    return null;
  }
  return utc - (fields.offsetMinutes ?? 0) * 60_000;
}

/** The ladder from `parse_reset_time`: an offset-bearing form first (its offset
 *  fixes the instant), then a naive form interpreted as local wall time. */
export function parseResetTime(raw: string): RustDateTime | null {
  // `Z` is just a zero offset for the pattern above.
  const normalized = /[Zz]$/.test(raw) ? `${raw.slice(0, -1)}+00:00` : raw;
  const withOffset = WITH_OFFSET.exec(normalized) as unknown as string[] | null;
  if (withOffset) {
    const minutes = Number(withOffset[9]) * 60 + Number(withOffset[10]);
    const fields = fieldsOf(withOffset, withOffset[8] === "-" ? -minutes : minutes);
    const ms = instantOf(fields);
    if (ms !== null) return { ms, nanos: fields.nanos };
  }
  const naive = NAIVE.exec(raw) as unknown as string[] | null;
  if (naive) {
    const fields = fieldsOf(naive, null);
    // and_local_timezone(Local).single(): the wall time must map to one instant
    const probe = new Date(fields.y, fields.mo - 1, fields.d, fields.h, fields.mi, fields.s);
    const exists =
      probe.getFullYear() === fields.y &&
      probe.getMonth() === fields.mo - 1 &&
      probe.getDate() === fields.d &&
      probe.getHours() === fields.h &&
      probe.getMinutes() === fields.mi &&
      probe.getSeconds() === fields.s;
    if (exists) return { ms: probe.getTime(), nanos: fields.nanos };
  }
  return null;
}

export function parseSegment(v: JValue): QuotaSegment {
  const used = getF64(v, "used");
  let limit = getF64(v, "limit");
  if (limit <= 0) limit = 1; // Rust's guard leaves NaN alone, which floors percent to 0 below
  const resetTime = v.kind === "obj" ? v.members.get("resetTime") : undefined;
  const resetAt = resetTime?.kind === "str" ? parseResetTime(resetTime.value) : null;
  const percent = (used / limit) * 100;
  return { percent: Number.isFinite(percent) ? percent : 0, resetAt };
}

export function parseExtra(wallet: JValue | undefined): ExtraInfo {
  const info: ExtraInfo = {
    state: "NotActivated",
    balanceCents: null,
    monthlyEnabled: false,
    monthlyUsedCents: null,
    monthlyLimitCents: null,
  };
  if (!jIsObject(wallet)) return info; // missing or non-object -> NotActivated

  // isEnabled defense: with the booster disabled, amountLeft is an estimate
  // (limit minus used), not a balance -> the whole card must read NotActivated.
  if (jAsBool(wallet.members.get("isEnabled")) === false) return info;

  const balance = wallet.members.get("balance");
  const raw = jIsObject(balance) ? getI64(balance.members.get("amountLeft")) : null;
  if (raw !== null) {
    info.state = "Ready";
    info.balanceCents = saturatingAddI64(raw, 500_000n) / 1_000_000n; // 1e-8 yuan -> cents
  } else {
    info.state = "NoData";
  }

  if (jAsBool(wallet.members.get("monthlyChargeLimitEnabled")) === true) {
    info.monthlyEnabled = true;
    info.monthlyUsedCents = parseCents(wallet.members.get("monthlyUsed"));
    info.monthlyLimitCents = parseCents(wallet.members.get("monthlyChargeLimit"));
  }
  return info;
}

/** The success-path half of `fetch()`, split out so a stub server can drive it. */
export function parseQuotaPayload(root: JValue, fetchedAt: RustDateTime): QuotaResult {
  const result: QuotaResult = {
    fiveHour: null,
    week: null,
    extra: null,
    fetchedAt,
    error: null,
  };
  const limits = jAsArray(root.kind === "obj" ? root.members.get("limits") : undefined);
  const first = limits?.[0];
  const detail = first?.kind === "obj" ? first.members.get("detail") : undefined;
  if (detail !== undefined) result.fiveHour = parseSegment(detail);
  const usage = root.kind === "obj" ? root.members.get("usage") : undefined;
  if (jIsObject(usage)) result.week = parseSegment(usage);
  result.extra = parseExtra(root.kind === "obj" ? root.members.get("boosterWallet") : undefined);
  return result;
}

export interface FetchDeps {
  fetchImpl?: typeof fetch;
  url?: string;
  token?: string | null;
  timeoutMs?: number;
  nowMs?: () => number;
}

const isTimeout = (err: unknown): boolean => {
  const name = err instanceof Error ? err.name : "";
  return name === "TimeoutError" || name === "AbortError";
};

/** `GET https://api.kimi.com/coding/v1/usages` (SPEC 16.1) with the .NET-style
 *  error names the SPEC keeps for cross-edition diffing (SPEC 16.4). */
export async function fetchQuota(deps: FetchDeps = {}): Promise<QuotaResult> {
  const url = deps.url ?? USAGES_URL;
  const token = deps.token !== undefined ? deps.token : loadToken();
  if (token === null) return failed("no-token");

  const timeoutMs = deps.timeoutMs ?? HTTP_TIMEOUT_MS;
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return failed(isTimeout(err) ? "TaskCanceledException" : "HttpRequestException");
  }
  if (!response.ok) return failed("HttpRequestException");

  // reqwest surfaces a body-read failure inside .json(); the same holds here, so
  // a timeout after the headers arrived is a JsonException, not a cancellation.
  let text: string;
  try {
    text = await response.text();
  } catch {
    return failed("JsonException");
  }
  let root: JValue;
  try {
    root = parseJsonValue(text);
  } catch {
    return failed("JsonException");
  }
  return parseQuotaPayload(root, dtFromNow((deps.nowMs ?? Date.now)()));
}

export const quotaResultToSerde = (r: QuotaResult): SerNode =>
  serObj([
    [
      "fiveHour",
      r.fiveHour === null
        ? null
        : serObj([
            ["percent", serF64(r.fiveHour.percent)],
            ["resetAt", r.fiveHour.resetAt === null ? null : serDt(r.fiveHour.resetAt)],
          ]),
    ],
    [
      "week",
      r.week === null
        ? null
        : serObj([
            ["percent", serF64(r.week.percent)],
            ["resetAt", r.week.resetAt === null ? null : serDt(r.week.resetAt)],
          ]),
    ],
    [
      "extra",
      r.extra === null
        ? null
        : serObj([
            ["state", serStr(r.extra.state)],
            ["balanceCents", r.extra.balanceCents === null ? null : serI64(r.extra.balanceCents)],
            ["monthlyEnabled", serBool(r.extra.monthlyEnabled)],
            [
              "monthlyUsedCents",
              r.extra.monthlyUsedCents === null ? null : serI64(r.extra.monthlyUsedCents),
            ],
            [
              "monthlyLimitCents",
              r.extra.monthlyLimitCents === null ? null : serI64(r.extra.monthlyLimitCents),
            ],
          ]),
    ],
    ["fetchedAt", serDt(r.fetchedAt)],
    ["error", r.error === null ? null : serStr(r.error)],
  ]);
