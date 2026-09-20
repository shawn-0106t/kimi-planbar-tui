// Display formatting, a 1:1 port of rust/src/format.rs (SPEC 12.2, 12.3, 12.5).

import { autoSiFraction, formatDateTimeLocal, truncDiv, type RustDateTime } from "./json.ts";

const I64_MIN = -(2 ** 63);
const I64_MAX = 2 ** 63 - 1;

/** `f64::round` — half away from zero, where JS `Math.round` rounds half up. */
export function rustRound(value: number): number {
  const rounded = Math.round(Math.abs(value));
  return value < 0 ? -rounded : rounded;
}

/** `x as i64` in Rust saturates; NaN and non-finite become 0 (what serde would
 *  have printed as `null`, but the callers never feed it non-finite). */
export function f64ToI64Sat(value: number): number {
  if (!Number.isFinite(value)) return value > 0 ? I64_MAX : value < 0 ? I64_MIN : 0;
  return Math.trunc(Math.min(Math.max(value, I64_MIN), I64_MAX));
}

/** FormatReset: span = at - now, English countdown text (SPEC 12.3). */
export function formatReset(at: RustDateTime, nowMs: number): string {
  const spanMs = at.ms - nowMs;
  if (spanMs < 0) return "Resets soon";
  const totalSec = truncDiv(spanMs, 1000);
  const days = truncDiv(totalSec, 86400);
  if (days >= 1) {
    const hours = truncDiv(totalSec, 3600) % 24;
    return `Resets in ${days}d ${hours}h`;
  }
  const totalHours = truncDiv(totalSec, 3600);
  if (totalHours >= 1) {
    const minutes = truncDiv(totalSec, 60) % 60;
    return `Resets in ${totalHours}h ${minutes}m`;
  }
  return `Resets in ${Math.max(1, truncDiv(totalSec, 60))}m`;
}

/** FmtYuan: cents -> yuan text, fraction omitted for whole yuan (SPEC 12.5). */
export function fmtYuan(cents: bigint): string {
  if (cents < 0n) return `-${fmtYuan(-cents)}`;
  const yuan = cents / 100n;
  const frac = cents % 100n;
  return frac > 0n ? `¥${yuan}.${frac.toString().padStart(2, "0")}` : `¥${yuan}`;
}

/** `{percent:0}%` — display uses the raw (unclamped) percent (SPEC 12.2). */
export function fmtPercent(percent: number): string {
  return `${f64ToI64Sat(rustRound(percent))}%`;
}

/** Gauge fill ratio input: clamp to 0..=100 (SPEC 12.2). Rust's `f64::clamp`
 *  panics on NaN; `parseSegment` already guarantees a finite percent. */
export function clampPercent(percent: number): number {
  if (Number.isNaN(percent)) return 0;
  return Math.min(Math.max(percent, 0), 100);
}

/** The title-row timestamp, `Updated HH:mm` (SPEC 12.1). */
export function formatUpdated(at: RustDateTime): string {
  const text = formatDateTimeLocal(at);
  return `Updated ${text.slice(11, 16)}`;
}

export { autoSiFraction };
