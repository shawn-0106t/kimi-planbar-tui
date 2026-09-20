// Rust text-semantics layer shared by every core module (SPEC 16.4, 19).
//
// The TS edition must be able to emit byte-identical `--test-fetch` output to the
// Rust edition so the two can be diffed field by field, and it must parse
// server strings the way `str::parse::<f64/i64>()` does. Neither comes out of
// JS naturally: serde_json always prints a fraction for an f64 (`68.0`), chrono
// prints RFC 3339 with the AutoSi fraction rule, `Number()` and `parseInt()`
// are far more permissive than Rust's parsers, and JS `trim()` strips U+FEFF
// while Rust's `char::is_whitespace` does not. Everything here is a literal
// transcription of those rules; goldens come from the Rust oracle (docs/
// the Rust-oracle golden mechanism now lives in SPEC §22.1).

// ---------------------------------------------------------------------------
// serde_json pretty output
// ---------------------------------------------------------------------------

/** A node in the same shape serde would print. JS `null` means JSON `null`,
 *  which is also how `Option::None` is printed — never omitted. */
export type SerNode =
  | { kind: "obj"; pairs: [string, SerNode | null][] }
  | { kind: "arr"; items: (SerNode | null)[] }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "i64"; value: bigint }
  | { kind: "f64"; value: number }
  | { kind: "dt"; value: RustDateTime }
  | null;

export const serObj = (pairs: [string, SerNode | null][]): SerNode => ({ kind: "obj", pairs });
export const serArr = (items: (SerNode | null)[]): SerNode => ({ kind: "arr", items });
export const serStr = (value: string): SerNode => ({ kind: "str", value });
export const serBool = (value: boolean): SerNode => ({ kind: "bool", value });
export const serI64 = (value: bigint | number): SerNode => ({
  kind: "i64",
  value: typeof value === "bigint" ? value : BigInt(Math.trunc(value)),
});
export const serF64 = (value: number): SerNode => ({ kind: "f64", value });
export const serDt = (value: RustDateTime): SerNode => ({ kind: "dt", value });

/** `serde_json::to_string_pretty`: 2-space indent, insertion order preserved,
 *  empty containers as `{}` / `[]`, one space after `:`. */
export function serdePrettyJson(node: SerNode | null): string {
  return serToString(node, 0);
}

const hexDigit = (n: number): string => "0123456789abcdef".charAt(n & 0xf);

/** serde_json's escape table: only `"`, `\` and the C0 controls. Non-ASCII,
 *  `/`, U+2028/2029 and DEL are written out raw — so JSON.stringify is unusable. */
function escapeJsonString(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20) {
      out += "\\u00" + hexDigit(code >> 4) + hexDigit(code);
    } else out += ch;
  }
  return out;
}

function serToString(node: SerNode | null, indent: number): string {
  const pad = "  ".repeat(indent);
  if (node === null) return `${pad}null`;
  switch (node.kind) {
    case "str":
      return `${pad}"${escapeJsonString(node.value)}"`;
    case "bool":
      return `${pad}${node.value ? "true" : "false"}`;
    case "i64":
      return `${pad}${node.value.toString()}`;
    case "f64":
      return `${pad}${formatF64(node.value) ?? "null"}`;
    case "dt":
      return `${pad}"${formatDateTimeLocal(node.value)}"`;
    case "arr": {
      if (node.items.length === 0) return `${pad}[]`;
      const body = node.items.map((item) => serToString(item, indent + 1)).join(",\n");
      return `${pad}[\n${body}\n${pad}]`;
    }
    case "obj": {
      if (node.pairs.length === 0) return `${pad}{}`;
      const innerPad = "  ".repeat(indent + 1);
      const body = node.pairs
        .map(
          ([key, value]) =>
            `${innerPad}"${escapeJsonString(key)}": ${serToString(value, indent + 1).replace(/^ +/, "")}`,
        )
        .join(",\n");
      return `${pad}{\n${body}\n${pad}}`;
    }
  }
}

// ---------------------------------------------------------------------------
// f64 text (ryu through serde_json)
// ---------------------------------------------------------------------------

/**
 * Text of an f64 the way serde_json writes it (ryu's shortest round-trip form).
 * Pinned by the Rust oracle golden `float_grid.txt`:
 *  - always carries a fraction or an exponent (`68.0`, never `68`)
 *  - fixed notation while the decimal exponent is in -5..=15 (`0.00001`,
 *    `1000000000000000.0`); scientific outside it (`1e-6`, `1e+16`)
 *  - a positive exponent keeps its `+`, a single-digit mantissa takes no `.0`
 *  - negative zero prints as `-0.0`
 *  - non-finite values are not printable: serde_json writes JSON `null`, which
 *    is what the caller gets when this returns null
 */
export function formatF64(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";

  // Shortest round-trip digits and the decimal exponent, via toExponential.
  // 1e21 needs 22 significant digits, so widen until the digits parse back.
  let digits = "";
  let exp10 = 0;
  for (let p = 0; p < 18; p++) {
    const text = value.toExponential(p);
    const m = /^([+-]?)(\d+(?:\.\d+)?)e([+-]\d+)$/.exec(text);
    if (!m) continue;
    const sign = m[1] === "-" ? "-" : "";
    const candidate = m[2]!.replace(".", "");
    const exponent = Number(m[3]);
    if (Number(`${sign}${insertDot(candidate, exponent + 1)}`) === value) {
      digits = candidate.replace(/0+$/, "") || "0";
      exp10 = exponent;
      break;
    }
  }
  if (digits === "") return String(value);
  const sign = value < 0 ? "-" : "";
  if (exp10 >= -5 && exp10 <= 15) {
    const fixed = insertDot(digits, exp10 + 1);
    return `${sign}${fixed.includes(".") ? fixed : `${fixed}.0`}`;
  }
  const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  const expSign = exp10 < 0 ? "-" : "+";
  return `${sign}${mantissa}e${expSign}${Math.abs(exp10)}`;
}

/** `1797` + 5 -> `1.797e+3`-style placement for the fixed branch. */
function insertDot(digits: string, pointIndex: number): string {
  if (pointIndex <= 0) return `0.${"0".repeat(-pointIndex)}${digits}`;
  if (pointIndex >= digits.length) return `${digits}${"0".repeat(pointIndex - digits.length)}`;
  return `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
}

// ---------------------------------------------------------------------------
// chrono RFC 3339 (DateTime<Local>)
// ---------------------------------------------------------------------------

/** An instant plus the *nanosecond* text chrono would print for it.
 *  `ms` is Unix epoch milliseconds; `nanos` is 0..999_999_999. */
export interface RustDateTime {
  ms: number;
  nanos: number;
}

const NANOS_PER_MS = 1_000_000;

/** `Local::now()`: JS only knows milliseconds, so the sub-ms digits are zeros
 *  and the printed form still has chrono's 9 fractional digits. */
export function dtFromNow(nowMs: number = Date.now()): RustDateTime {
  return { ms: nowMs, nanos: (nowMs % 1000) * NANOS_PER_MS };
}

/** A time parsed out of the API: keep the source nanoseconds so the printed
 *  fraction follows chrono's AutoSi rule exactly. */
export function dtFromParts(ms: number, nanos: number): RustDateTime {
  return { ms, nanos };
}

/** chrono `SecondsFormat::AutoSi`, pinned by the oracle golden `datetime.txt`:
 *  no fraction when nanos is zero, else the 9-digit text with whole trailing
 *  `000` groups removed (so `.500000000` prints `.500`, not `.5` and not `.500000`). */
export function autoSiFraction(nanos: number): string {
  if (nanos === 0) return "";
  let digits = String(nanos).padStart(9, "0");
  while (digits.length > 3 && digits.endsWith("000")) digits = digits.slice(0, -3);
  return `.${digits}`;
}

const pad2 = (n: number): string => String(Math.trunc(n)).padStart(2, "0");

/** Offset of the machine's local zone at a given instant, in minutes east of UTC. */
export function localOffsetMinutes(ms: number): number {
  return -new Date(ms).getTimezoneOffset();
}

/** `DateTime<Local>` as serde prints it: `YYYY-MM-DDTHH:MM:SS[.frac]±HH:MM`. */
export function formatDateTimeLocal(dt: RustDateTime): string {
  const d = new Date(dt.ms);
  const offset = localOffsetMinutes(dt.ms);
  const abs = Math.abs(offset);
  // Render in *local* wall time, which is what DateTime<Local> shows.
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const sign = offset < 0 ? "-" : "+";
  return `${date}T${time}${autoSiFraction(dt.nanos)}${sign}${pad2(abs / 60)}:${pad2(abs % 60)}`;
}

/** `NaiveDateTime::and_local_timezone(Local).single()` — a local wall time that
 *  does not exist or is ambiguous (DST) has no single mapping and is rejected.
 *  Round-tripping the wall fields through Date proves which side of that we are on. */
export function localizeNaiveSingle(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  nanos: number,
): RustDateTime | null {
  const probe = new Date(y, mo - 1, d, h, mi, s);
  if (
    probe.getFullYear() !== y ||
    probe.getMonth() !== mo - 1 ||
    probe.getDate() !== d ||
    probe.getHours() !== h ||
    probe.getMinutes() !== mi ||
    probe.getSeconds() !== s
  ) {
    return null;
  }
  return { ms: probe.getTime(), nanos };
}

// ---------------------------------------------------------------------------
// Rust string-parsing semantics
// ---------------------------------------------------------------------------

/** Rust's `char::is_whitespace` = the Unicode White_Space property. Deliberately
 *  not JS whitespace: Rust excludes the BOM codepoint and includes U+0085. */
const RUST_WS_CODEPOINTS = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
]);

const isRustWs = (ch: string): boolean => RUST_WS_CODEPOINTS.has(ch.codePointAt(0) ?? -1);

function trimEdges(s: string, start: boolean, end: boolean): string {
  const chars = [...s];
  let lo = 0;
  let hi = chars.length;
  if (start) while (lo < hi && isRustWs(chars[lo]!)) lo++;
  if (end) while (hi > lo && isRustWs(chars[hi - 1]!)) hi--;
  return chars.slice(lo, hi).join("");
}

/** `str::trim` under Rust's whitespace set. */
export const rustTrim = (s: string): string => trimEdges(s, true, true);
/** `str::trim_end`. */
export const rustTrimEnd = (s: string): string => trimEdges(s, false, true);
/** `str::trim_start`. */
export const rustTrimStart = (s: string): string => trimEdges(s, true, false);

/** `str::trim_start_matches('\u{feff}')` — strips *all* leading BOM codepoints. */
export const rustStripLeadingBoms = (s: string): string => {
  let start = 0;
  while (s.codePointAt(start) === 0xfeff) start += 1;
  return start === 0 ? s : s.slice(start);
};

/** `str::trim_matches('"')` / `('\'')` — strips all leading and trailing repeats. */
export const rustTrimMatchesChar = (s: string, ch: string): string => {
  let lo = 0;
  let hi = s.length;
  while (lo < hi && s[lo] === ch) lo++;
  while (hi > lo && s[hi - 1] === ch) hi--;
  return s.slice(lo, hi);
};

/** `str::trim_matches(closure)` — e.g. the `[`/`]` strip around a TOML section. */
export const rustTrimMatchesAny = (s: string, chars: string[]): string => {
  const set = new Set(chars);
  let lo = 0;
  let hi = s.length;
  while (lo < hi && set.has(s[lo]!)) lo++;
  while (hi > lo && set.has(s[hi - 1]!)) hi--;
  return s.slice(lo, hi);
};

/** The Rust whitespace set as a regex class source, for patterns that must match
 *  `regex::Regex`'s `\s`-equivalent over Rust's `char::is_whitespace`. */
export const RUST_WS_REGEX_CLASS =
  "[\\t\\n\\u000b\\u000c\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

/** `str::lines()`: split on `\n`, one trailing `\r` dropped, no trailing empty item. */
export function rustLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
}

/** `str::chars()` — code points, which is what Rust indexing and `count()` mean. */
export const rustRunes = (s: string): string[] => [...s];

export const runeLen = (s: string): number => [...s].length;

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;

const F64_RE =
  /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)$/i;
const INT_RE = /^[+-]?\d+$/;

/** `str::parse::<f64>()`: whole-string match, no separators, no hex; `inf`,
 *  `infinity` and `nan` are accepted case-insensitively, and an out-of-range
 *  magnitude saturates to ±inf instead of failing. */
export function parseF64Strict(input: string): number | null {
  if (!F64_RE.test(input)) return null;
  const lowered = input.toLowerCase();
  const sign = lowered.startsWith("-") ? -1 : 1;
  const body = lowered.replace(/^[+-]/, "");
  if (body === "nan") return Number.NaN;
  if (body === "inf" || body === "infinity") return sign * Number.POSITIVE_INFINITY;
  const value = Number(input);
  return Number.isNaN(value) ? null : value;
}

/** `str::parse::<i64>()`: optional sign, digits only, no fraction or exponent. */
export function parseI64Strict(input: string): bigint | null {
  if (!INT_RE.test(input)) return null;
  const value = BigInt(input);
  return value < I64_MIN || value > I64_MAX ? null : value;
}

/** `str::parse::<u64>()`: no sign, digits only. */
export function parseU64Strict(input: string): bigint | null {
  const text = input.startsWith("+") ? input.slice(1) : input;
  if (!/^\d+$/.test(text)) return null;
  const value = BigInt(text);
  return value > U64_MAX ? null : value;
}

/** Rust's `/` on integers: truncation toward zero (BigInt already does this,
 *  JS number division does not). */
export const truncDiv = (a: number, b: number): number => Math.trunc(a / b);

/** Rust's `i64::saturating_add`. */
export function saturatingAddI64(a: bigint, b: bigint): bigint {
  const sum = a + b;
  if (sum > I64_MAX) return I64_MAX;
  if (sum < I64_MIN) return I64_MIN;
  return sum;
}

// ---------------------------------------------------------------------------
// serde_json::Value with number-token fidelity
// ---------------------------------------------------------------------------

/** Thrown where `resp.json()` would fail, i.e. the `JsonException` path (SPEC 16.4). */
export class RustJsonError extends Error {}

/**
 * A parsed JSON value that keeps the original number token. `Number::as_i64()`
 * only answers for a token that was written as an integer: the oracle golden
 * `as_i64.txt` shows `1.0`, `1e5` and `-0.0` all yield nothing even though the
 * value is integral, so `JSON.parse` alone cannot reproduce that. It is also
 * exact for integer tokens beyond 2^53, which `JSON.parse` would round.
 */
export type JValue =
  | { kind: "null" }
  | { kind: "bool"; value: boolean }
  | { kind: "num"; value: number; token: string }
  | { kind: "str"; value: string }
  | { kind: "arr"; items: JValue[] }
  | { kind: "obj"; members: Map<string, JValue> };

type JNull = Extract<JValue, { kind: "null" }>;
type JObj = Extract<JValue, { kind: "obj" }>;
type JArr = Extract<JValue, { kind: "arr" }>;

export const jIsNull = (v: JValue | undefined): v is JNull => v?.kind === "null";
export const jIsObject = (v: JValue | undefined): v is JObj => v?.kind === "obj";
export const jIsArray = (v: JValue | undefined): v is JArr => v?.kind === "arr";
export const jGet = (v: JValue | undefined, key: string): JValue | undefined =>
  v?.kind === "obj" ? v.members.get(key) : undefined;
export const jAsStr = (v: JValue | undefined): string | undefined =>
  v?.kind === "str" ? v.value : undefined;
export const jAsBool = (v: JValue | undefined): boolean | undefined =>
  v?.kind === "bool" ? v.value : undefined;
export const jAsArray = (v: JValue | undefined): JValue[] | undefined =>
  v?.kind === "arr" ? v.items : undefined;
export const jAsF64 = (v: JValue | undefined): number | undefined =>
  v?.kind === "num" ? v.value : undefined;

/** `serde_json::Number::as_i64()` — an integer-formatted token inside the i64 range. */
export function jAsI64(v: JValue | undefined): bigint | null {
  if (v?.kind !== "num") return null;
  if (!/^[+-]?\d+$/.test(v.token)) return null;
  const value = BigInt(v.token);
  return value < I64_MIN || value > I64_MAX ? null : value;
}

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

/** Strict JSON parsing in serde_json's image: no trailing garbage, no comments,
 *  and a numeric literal beyond f64 range is an error (`number out of range`),
 *  which is how a `1e400` payload reaches the `JsonException` branch. */
export function parseJsonValue(text: string): JValue {
  let pos = 0;

  const fail = (where: string): never => {
    throw new RustJsonError(`${where} at line 1 column ${pos + 1}`);
  };

  const ws = (): void => {
    while (pos < text.length && text[pos] !== undefined && " \t\n\r".includes(text[pos]!)) pos++;
  };

  const value = (): JValue => {
    ws();
    const start = text[pos];
    if (start === undefined) return fail("expected value");
    if (start === "{") return object();
    if (start === "[") return array();
    if (start === '"') return { kind: "str", value: jsonString() };
    if (start === "t") return literal("true", { kind: "bool", value: true } as JValue);
    if (start === "f") return literal("false", { kind: "bool", value: false } as JValue);
    if (start === "n") return literal("null", { kind: "null" } as JValue);
    return number();
  };

  const literal = (word: string, result: JValue): JValue => {
    if (!text.startsWith(word, pos)) return fail("expected value");
    pos += word.length;
    return result;
  };

  const number = (): JValue => {
    const rest = text.slice(pos);
    const m = JSON_NUMBER.exec(rest);
    if (!m) return fail("expected value");
    const token = m[0]!;
    const parsed = Number(token);
    if (!Number.isFinite(parsed)) throw new RustJsonError("number out of range");
    pos += token.length;
    return { kind: "num", value: parsed, token };
  };

  const ESCAPES: Record<string, string> = {
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    '"': '"',
    "\\": "\\",
    "/": "/",
  };

  const jsonString = (): string => {
    pos++; // opening quote
    let out = "";
    let from = pos;
    while (pos < text.length) {
      const ch = text[pos]!;
      if (ch === '"') {
        out += text.slice(from, pos);
        pos++;
        return out;
      }
      if (ch === "\\") {
        out += text.slice(from, pos);
        pos++;
        const esc = text[pos];
        pos++;
        if (esc === undefined) return fail("EOF while escaping");
        if (esc === "u") {
          const hex = text.slice(pos, pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail("invalid escape");
          pos += 4;
          out += String.fromCharCode(Number.parseInt(hex, 16));
        } else {
          const mapped = ESCAPES[esc];
          if (mapped === undefined) return fail("invalid escape");
          out += mapped;
        }
        from = pos;
        continue;
      }
      if (ch.codePointAt(0)! < 0x20) return fail("control character in string");
      pos++;
    }
    return fail("EOF while parsing a string");
  };

  const object = (): JValue => {
    pos++; // {
    const members = new Map<string, JValue>();
    ws();
    if (text[pos] === "}") {
      pos++;
      return { kind: "obj", members };
    }
    for (;;) {
      ws();
      if (text[pos] !== '"') return fail("key of an object");
      const key = jsonString();
      ws();
      if (text[pos] !== ":") return fail("colon after object key");
      pos++;
      members.set(key, value()); // a duplicate key keeps the last value, as serde does
      ws();
      const next = text[pos];
      if (next === ",") {
        pos++;
        continue;
      }
      if (next === "}") {
        pos++;
        return { kind: "obj", members };
      }
      return fail("comma or closing brace");
    }
  };

  const array = (): JValue => {
    pos++; // [
    const items: JValue[] = [];
    ws();
    if (text[pos] === "]") {
      pos++;
      return { kind: "arr", items };
    }
    for (;;) {
      items.push(value());
      ws();
      const next = text[pos];
      if (next === ",") {
        pos++;
        continue;
      }
      if (next === "]") {
        pos++;
        return { kind: "arr", items };
      }
      return fail("comma or closing bracket");
    }
  };

  const root = value();
  ws();
  if (pos !== text.length) throw new RustJsonError("trailing characters");
  return root;
}
