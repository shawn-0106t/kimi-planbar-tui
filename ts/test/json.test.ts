import { describe, expect, test } from "bun:test";
import {
  autoSiFraction,
  dtFromNow,
  dtFromParts,
  formatDateTimeLocal,
  formatF64,
  jAsF64,
  jAsI64,
  parseF64Strict,
  parseI64Strict,
  parseU64Strict,
  parseJsonValue,
  RustJsonError,
  rustLines,
  rustRunes,
  rustStripLeadingBoms,
  rustTrim,
  rustTrimEnd,
  rustTrimMatchesChar,
  saturatingAddI64,
  serdePrettyJson,
  serArr,
  serBool,
  serDt,
  serF64,
  serI64,
  serObj,
  serStr,
  truncDiv,
  RustJsonError,
} from "../src/core/json.ts";
import { goldenPairs, goldenRows, timezoneMatchesGolden } from "./goldens.ts";

const rustDisplayToNumber = (text: string): number => {
  if (text === "inf") return Number.POSITIVE_INFINITY;
  if (text === "-inf") return Number.NEGATIVE_INFINITY;
  if (text === "NaN") return Number.NaN;
  return Number(text);
};

describe("formatF64 matches serde_json (ryu) text", () => {
  for (const name of ["floats", "float_grid"]) {
    test(`${name} golden`, () => {
      const pairs = goldenPairs(name);
      expect(pairs.length).toBeGreaterThan(5);
      for (const [, rustText] of pairs) {
        expect(formatF64(Number(rustText))).toBe(rustText);
      }
    });
  }

  test("non-finite has no float text; the serializer writes null", () => {
    expect(formatF64(Number.NaN)).toBeNull();
    expect(formatF64(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatF64(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  test("negative zero keeps its sign", () => {
    expect(formatF64(-0)).toBe("-0.0");
    expect(formatF64(0)).toBe("0.0");
  });
});

describe("formatDateTimeLocal matches chrono", () => {
  const SECS = 1_893_456_000;
  const cases: [string, number, number][] = [
    ["nanos_0", SECS, 0],
    ["nanos_123456789", SECS, 123_456_789],
    ["nanos_123000000", SECS, 123_000_000],
    ["nanos_123456000", SECS, 123_456_000],
    ["nanos_500000000", SECS, 500_000_000],
    ["whole_minute", SECS + 60, 0],
  ];

  for (const [label, secs, nanos] of cases) {
    test(`${label} (AutoSi fraction)`, () => {
      if (!timezoneMatchesGolden()) throw new Error("goldens need TZ=Asia/Shanghai");
      const rust = goldenPairs("datetime").find(([name]) => name === label)?.[1];
      expect(rust).toBeDefined();
      expect(formatDateTimeLocal(dtFromParts(secs * 1000, nanos))).toBe(rust?.replace(/^"|"$/g, ""));
    });
  }

  test("now-shaped stamp keeps a fraction and a numeric offset, never Z", () => {
    const text = formatDateTimeLocal(dtFromNow(1_893_456_000_594));
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3,9})?[+-]\d{2}:\d{2}$/);
    expect(text).not.toContain("Z");
  });

  test("autoSiFraction strips whole three-digit groups only", () => {
    expect(autoSiFraction(0)).toBe("");
    expect(autoSiFraction(500_000_000)).toBe(".500");
    expect(autoSiFraction(123_000_000)).toBe(".123");
    expect(autoSiFraction(123_456_000)).toBe(".123456");
    expect(autoSiFraction(123_456_789)).toBe(".123456789");
    expect(autoSiFraction(100_000)).toBe(".000100");
    expect(autoSiFraction(1)).toBe(".000000001");
  });
});

describe("Rust from_str grammar", () => {
  test("parse matrix golden", () => {
    for (const [input, f64Field, i64Field] of goldenRows("parse_matrix")) {
      // The golden ran the input through Rust's escape_debug, so restore it.
      const decoded = input!.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_m, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      );
      const trimmed = rustTrim(decoded);
      const expectedF64 = f64Field!.replace(/^f64=/, "");
      const expectedI64 = i64Field!.replace(/^i64=/, "");
      const gotF64 = parseF64Strict(trimmed);
      const gotF64Text = gotF64 === null ? "ERR" : String(gotF64);
      const wantF64Text = expectedF64 === "ERR" ? "ERR" : String(rustDisplayToNumber(expectedF64));
      expect(gotF64Text).toBe(wantF64Text);
      expect(expectedI64 === "ERR" ? null : parseI64Strict(trimmed)?.toString()).toBe(
        expectedI64 === "ERR" ? null : expectedI64,
      );
    }
  });

  test("rejects what Rust rejects, accepts what Rust accepts", () => {
    expect(parseF64Strict("68abc")).toBeNull();
    expect(parseF64Strict("0x10")).toBeNull();
    expect(parseF64Strict("1_000")).toBeNull();
    expect(parseF64Strict("")).toBeNull();
    expect(parseF64Strict("1.")).toBe(1);
    expect(parseF64Strict(".5")).toBe(0.5);
    expect(parseF64Strict("1E+5")).toBe(100000);
    expect(parseF64Strict("-Infinity")).toBe(Number.NEGATIVE_INFINITY);
    expect(parseF64Strict("1e999")).toBe(Number.POSITIVE_INFINITY);
    expect(parseI64Strict("1e5")).toBeNull();
    expect(parseI64Strict("123.5")).toBeNull();
    expect(parseI64Strict("+68")).toBe(68n);
    expect(parseI64Strict("007")).toBe(7n);
    expect(parseI64Strict("9223372036854775807")).toBe(9223372036854775807n);
    expect(parseI64Strict("9223372036854775808")).toBeNull();
    expect(parseU64Strict("-1")).toBeNull();
    expect(parseU64Strict("18446744073709551615")).toBe(18446744073709551615n);
    expect(parseU64Strict("18446744073709551616")).toBeNull();
  });
});

describe("serde_json::Value parity", () => {
  test("as_i64 golden: only an integer-shaped token answers", () => {
    for (const row of goldenRows("as_i64")) {
      const [source, i64Field, f64Field] = row;
      const expected = i64Field!.replace(/^as_i64=/, "");
      if (expected.startsWith("PARSE_ERR")) {
        expect(() => parseJsonValue(source!)).toThrow(RustJsonError);
        continue;
      }
      const parsed = parseJsonValue(source!);
      const member = parsed.kind === "obj" ? parsed.members.get("v") : undefined;
      const asI64 = jAsI64(member);
      expect(asI64 === null ? "None" : asI64.toString()).toBe(expected);
      expect(jAsF64(member)).toBe(Number(f64Field!.replace(/^as_f64=/, "")));
    }
  });

  test("out-of-range numbers and trailing garbage fail the document", () => {
    expect(() => parseJsonValue('{"v":1e400}')).toThrow("number out of range");
    expect(() => parseJsonValue("{} {}")).toThrow("trailing characters");
    expect(() => parseJsonValue('{"a":1,}')).toThrow();
    expect(() => parseJsonValue("nullx")).toThrow();
    expect(() => parseJsonValue('{"a":"\\q"}')).toThrow("invalid escape");
    expect(() => parseJsonValue('{"a":"x')).toThrow();
  });

  test("duplicate keys keep the last value", () => {
    const value = parseJsonValue('{"a":1,"a":2}');
    expect(jAsI64(value.kind === "obj" ? value.members.get("a") : undefined)).toBe(2n);
  });

  test("escapes decode as JSON requires", () => {
    const value = parseJsonValue('{"s":"A\\u00e9\\t\\/\\\\"}');
    const member = value.kind === "obj" ? value.members.get("s") : undefined;
    expect(member?.kind === "str" ? member.value : null).toBe("Aé\t/\\");
  });
});

describe("serdePrettyJson", () => {
  test("key order, indent, nulls, float and int text", () => {
    const stamp = dtFromParts(1_893_456_000_000, 0);
    const json = serdePrettyJson(
      serObj([
        ["fiveHour", serObj([["percent", serF64(21)], ["resetAt", serDt(stamp)]])],
        ["week", null],
        [
          "extra",
          serObj([
            ["state", serStr("Ready")],
            ["balanceCents", serI64(1235n)],
            ["monthlyEnabled", serBool(true)],
          ]),
        ],
        ["error", serStr("no-token")],
      ]),
    );
    const lines = json.split("\n");
    expect(lines[0]).toBe("{");
    expect(lines[1]).toBe('  "fiveHour": {');
    expect(lines[2]).toBe('    "percent": 21.0,');
    expect(lines[3]).toBe(`    "resetAt": "${formatDateTimeLocal(stamp)}"`);
    expect(lines[4]).toBe("  },");
    expect(lines[5]).toBe('  "week": null,');
    expect(lines[6]).toBe('  "extra": {');
    expect(lines[7]).toBe('    "state": "Ready",');
    expect(lines[8]).toBe('    "balanceCents": 1235,');
    expect(lines[9]).toBe('    "monthlyEnabled": true');
    expect(lines[10]).toBe("  },");
    expect(lines[11]).toBe('  "error": "no-token"');
    expect(lines[12]).toBe("}");
    expect(lines).toHaveLength(13);
  });

  test("empty containers, arrays and the null root", () => {
    expect(serdePrettyJson(serObj([["a", serObj([])], ["b", serArr([])]]))).toBe(
      '{\n  "a": {},\n  "b": []\n}',
    );
    expect(serdePrettyJson(serArr([serI64(1), null, serArr([serBool(false)])]))).toBe(
      "[\n  1,\n  null,\n  [\n    false\n  ]\n]",
    );
    expect(serdePrettyJson(null)).toBe("null");
  });

  test("escape table: quotes, backslash and C0 controls only", () => {
    expect(serdePrettyJson(serStr('a"b\\c'))).toBe('"a\\"b\\\\c"');
    expect(serdePrettyJson(serStr("x\ty\nz\x01"))).toBe('"x\\ty\\nz\\u0001"');
    // Non-ASCII, slash and U+2028 are written raw, exactly like serde_json.
    const raw = serdePrettyJson(serStr("é中\\n"));
    expect(raw).toContain("é");
    expect(raw).toContain("中");
    expect(raw).not.toContain("\\u00e9");
    expect(raw).not.toContain("\\/");
  });
});

describe("Rust text idioms", () => {
  test("trim uses the Unicode White_Space set, not JS whitespace", () => {
    expect(rustTrim("  x  ")).toBe("x");
    expect(rustTrim("\t\n\rx")).toBe("x");
    expect(rustTrim("x")).toBe("x");
    expect(rustTrim("﻿x")).toBe("﻿x"); // BOM is not whitespace for Rust
    expect(rustTrimEnd("x  ")).toBe("x");
    expect(rustTrimEnd("x﻿")).toBe("x﻿");
    expect(rustTrim("　x")).toBe("x"); // ideographic space
  });

  test("lines drops the CR and has no trailing empty item", () => {
    expect(rustLines("a\r\nb\nc\n")).toEqual(["a", "b", "c"]);
    expect(rustLines("a\n\nb")).toEqual(["a", "", "b"]);
    expect(rustLines("")).toEqual([]);
    expect(rustLines("only")).toEqual(["only"]);
  });

  test("BOM and quote stripping follow trim_matches semantics", () => {
    expect(rustStripLeadingBoms("﻿﻿---")).toBe("---");
    expect(rustStripLeadingBoms("---﻿")).toBe("---﻿");
    expect(rustTrimMatchesChar('"quoted"', '"')).toBe("quoted");
    expect(rustTrimMatchesChar(`''a''`, "'")).toBe("a");
    expect(rustTrimMatchesChar(`"'mixed"'`, '"')).toBe(`'mixed"'`);
    expect(rustTrimMatchesChar(`  x  `, " ")).toBe("x");
  });

  test("runes count code points, not UTF-16 units", () => {
    expect(rustRunes("éab")).toEqual(["é", "a", "b"]);
    expect(rustRunes("😀x")).toEqual(["😀", "x"]);
    expect(rustRunes("中文")).toHaveLength(2);
  });

  test("integer arithmetic truncates toward zero and saturates on add", () => {
    expect(truncDiv(-1499999, 1000000)).toBe(-1);
    expect(truncDiv(1499999, 1000000)).toBe(1);
    expect(-1499999n / 1000000n).toBe(-1n);
    expect(saturatingAddI64(9223372036854775807n, 500000n)).toBe(9223372036854775807n);
    expect(saturatingAddI64(-9223372036854775808n, -1n)).toBe(-9223372036854775808n);
  });
});

describe("recursion limit (serde_json parity)", () => {
  test("128 levels parse and 129 is a parse error, not a stack overflow", () => {
    const within = "[".repeat(128) + "]".repeat(128);
    expect(() => parseJsonValue(within)).not.toThrow();
    const beyond = "[".repeat(129) + "]".repeat(129);
    expect(() => parseJsonValue(beyond)).toThrow(RustJsonError);
  });
});

