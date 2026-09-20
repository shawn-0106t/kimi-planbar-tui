// Regenerates test/golden/*.txt from the *real* Rust parsing code.
//
// The TS edition must print serde_json's text and follow Rust's parse grammar,
// and the only honest oracle for that is Rust itself. This script assembles a
// throwaway cargo project out of rust/src/quota.rs (DTOs and parsers copied
// verbatim by marker anchors, so it cannot drift) plus a driver that walks the
// hostile-input space, builds it, and drops the results into test/golden/.
//
//   node test/parity/make-oracle.ts        # writes test/golden/*.txt
// Requires: cargo with the crate deps already fetched. Not part of the app.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const OUT = process.env["KPT_ORACLE_DIR"] ?? join(process.env["TEMP"] ?? "/tmp", "kpt-oracle");

const src = readFileSync(`${REPO}/rust/src/quota.rs`, "utf8").split("\n").map((l) => l.replace(/\r$/, ""));
const idx = (pred: (l: string) => boolean, from = 0) => {
  for (let i = from; i < src.length; i++) if (pred(src[i]!)) return i;
  throw new Error(`marker not found from line ${from + 1}`);
};

const headerEnd = idx((l) => l.startsWith("use "));
const deriveStart = idx((l) => l.startsWith("#[derive("));
const testsStart = idx((l) => l.startsWith("#[cfg(test)]"));
const httpStart = idx((l) => l.startsWith("fn http_client("), deriveStart);
const parserStart = idx((l) => l.startsWith("/// JSON number-or-string"), deriveStart);

const ported = [
  src.slice(0, headerEnd).join("\n"),
  src.slice(headerEnd, deriveStart).filter((l) => /^(use (chrono|serde::Serialize|serde_json))/.test(l)).join("\n"),
  src.slice(deriveStart, httpStart).filter((l) => !l.startsWith("const USAGES_URL")).join("\n"),
  src.slice(parserStart, testsStart).join("\n"),
].join("\n");

const driver = String.raw`
// ---------------------------------------------------------------------------
// oracle driver (not part of the ported code)
// ---------------------------------------------------------------------------

use serde_json::json;
use chrono::TimeZone;

/// Same body as quota::fetch() after a successful response, with a fixed
/// fetched_at so the emitted text is deterministic.
fn probe(root: &Value, at: DateTime<Local>) -> QuotaResult {
    let mut r = QuotaResult {
        five_hour: None,
        week: None,
        extra: None,
        fetched_at: at,
        error: None,
    };
    if let Some(detail) = root
        .get("limits")
        .and_then(|l| l.as_array())
        .and_then(|a| a.first())
        .and_then(|first| first.get("detail"))
    {
        r.five_hour = Some(parse_segment(detail));
    }
    if let Some(u) = root.get("usage") {
        if u.is_object() {
            r.week = Some(parse_segment(u));
        }
    }
    r.extra = Some(parse_extra(root.get("boosterWallet")));
    r
}

fn failed_at(kind: &str, at: DateTime<Local>) -> QuotaResult {
    QuotaResult { five_hour: None, week: None, extra: None, fetched_at: at, error: Some(kind.to_string()) }
}

fn write_raw(name: &str, text: &str) {
    std::fs::create_dir_all("golden").unwrap();
    std::fs::write(format!("golden/{name}.txt"), text).unwrap();
    println!("wrote golden/{name}.txt");
}

fn pretty<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string_pretty(v).unwrap()
}

fn main() {
    let at = Local.timestamp_opt(1_893_456_000, 123_456_789).single().unwrap();
    let at_zero = Local.timestamp_opt(1_893_456_000, 0).single().unwrap();

    // --- f64 text shapes (ryu through serde_json) ---
    let floats: Vec<(&str, f64)> = vec![
        ("int_like", 68.0),
        ("zero", 0.0),
        ("neg_zero", -0.0),
        ("half", 1.5),
        ("repeat", 2266.6666666666665),
        ("tenth", 0.1),
        ("e15", 1e15),
        ("e16", 1e16),
        ("e17", 1e17),
        ("e21", 1e21),
        ("e_minus4", 1e-4),
        ("e_minus5", 1e-5),
        ("e_minus7", 1e-7),
        ("three_thousand", 5000.0),
        ("big_int", 123456789.0),
        ("hundred", 100.0),
        ("third", 100.0 / 3.0),
        ("neg_half", -21.5),
        ("max", f64::MAX),
    ];
    write_raw("floats", &pretty(&floats));

    // --- dense grid to pin ryu's fixed/scientific switch point ---
    let mut grid: Vec<(&str, f64)> = Vec::new();
    for e in -12..=24 {
        grid.push((format!("10pow{e}").leak(), 10f64.powi(e)));
        grid.push((format!("7pow{e}").leak(), 7f64 * 10f64.powi(e)));
    }
    for v in [
        9_999_999_999_999_999.0f64,
        10_000_000_000_000_000.0,
        99_999_999_999_999_992.0,
        1_234_567_890_123_456.0,
        12_345_678_901_234_567.0,
        0.000_001,
        0.000_000_1,
        0.000_000_01,
        f64::MIN_POSITIVE,
        5e-324,
        4.9e-324,
    ] {
        grid.push((format!("v{v}").leak(), v));
    }
    write_raw("float_grid", &pretty(&grid.iter().map(|(k, v)| (*k, *v)).collect::<Vec<_>>()));

    // --- chrono RFC 3339 text (AutoSi fraction rule + offset form) ---
    let dts: Vec<(&str, DateTime<Local>)> = vec![
        ("nanos_0", at_zero),
        ("nanos_123456789", at),
        ("nanos_123000000", Local.timestamp_opt(1_893_456_000, 123_000_000).single().unwrap()),
        ("nanos_123456000", Local.timestamp_opt(1_893_456_000, 123_456_000).single().unwrap()),
        ("nanos_500000000", Local.timestamp_opt(1_893_456_000, 500_000_000).single().unwrap()),
        ("whole_minute", Local.timestamp_opt(1_893_456_060, 0).single().unwrap()),
    ];
    write_raw("datetime", &pretty(&dts));

    // --- Rust from_str grammar ---
    let inputs = [
        "68", " 68 ", "", "+68", "-68", "0x10", "1e5", "1E+5", "123.5", "1.", ".5", ".x",
        "68abc", "1_000", "inf", "-inf", "infinity", "NaN", "nan", "1e999", "-1e999",
        "9223372036854775807", "9223372036854775808", "-9223372036854775808",
        "-9223372036854775809", "007", "-", "1.2.3", "1 000", "\u{feff}68", "\u{85}68",
    ];
    let mut lines: Vec<String> = Vec::new();
    for s in inputs {
        let f = s.trim().parse::<f64>();
        let i = s.trim().parse::<i64>();
        lines.push(format!(
            "{}|f64={}|i64={}",
            s.escape_debug(),
            match f { Ok(v) => format!("{v}"), Err(_) => "ERR".to_string() },
            match i { Ok(v) => v.to_string(), Err(_) => "ERR".to_string() },
        ));
    }
    write_raw("parse_matrix", &lines.join("\n"));

    // --- serde_json parsing of hostile numeric literals + Number::as_i64 ---
    let mut as_i64: Vec<String> = Vec::new();
    for text in [
        r#"{"v":1500000}"#, r#"{"v":1500000.7}"#, r#"{"v":1.0}"#, r#"{"v":1e5}"#, r#"{"v":-0.0}"#,
        r#"{"v":9223372036854775807}"#, r#"{"v":9223372036854775808}"#, r#"{"v":18446744073709551616}"#,
        r#"{"v":1e400}"#, r#"{"v":0.1}"#, r#"{"v":1e-400}"#,
    ] {
        let parsed: Result<Value, _> = serde_json::from_str(text);
        match parsed {
            Ok(v) => {
                let n = v.get("v").unwrap();
                let i = match n { Value::Number(x) => x.as_i64(), _ => None };
                let f = match n { Value::Number(x) => x.as_f64(), _ => None };
                as_i64.push(format!(
                    "{}|as_i64={}|as_f64={}|repr={}",
                    text,
                    i.map(|x| x.to_string()).unwrap_or("None".to_string()),
                    f.map(|x| x.to_string()).unwrap_or("None".to_string()),
                    n.to_string(),
                ));
            }
            Err(e) => as_i64.push(format!("{}|PARSE_ERR={}", text, e)),
        }
    }
    write_raw("as_i64", &as_i64.join("\n"));

    // --- resetTime acceptance ladder, as serialized text ---
    let times = [
        "2030-01-01T00:00:00+08:00",
        "2030-01-01T00:00:00.123456789+08:00",
        "2030-01-01T00:00:00.123Z",
        "2030-01-01T00:00:00Z",
        "2030-01-01 00:00:00 +08:00",
        "2030-01-01 00:00:00+0800",
        "2030-01-01T00:00:00 +08:00",
        "2030-01-01 00:00:00.123456 +08:00",
        "2030-01-01 00:00:00",
        "2030-01-01T00:00:00",
        "2030-01-01T00:00:00.5",
        "not a date",
        "2030-13-45T00:00:00+08:00",
    ];
    let mut tlines: Vec<String> = Vec::new();
    for s in times {
        let parsed = parse_reset_time(s);
        tlines.push(format!(
            "{s}|{}",
            match parsed { Some(d) => pretty(&d), None => "None".to_string() }
        ));
    }
    write_raw("reset_time", &tlines.join("\n"));

    // --- QuotaResult goldens ---
    let cases: Vec<(&str, Value)> = vec![
        ("success_full", json!({
            "limits": [{ "detail": { "used": "21", "limit": "100", "resetTime": "2030-01-01T00:00:00+08:00" } }],
            "usage": { "used": 18.5, "limit": 100, "resetTime": "2030-01-08 00:00:00 +08:00" },
            "boosterWallet": {
                "isEnabled": true,
                "balance": { "amountLeft": "1234567890" },
                "monthlyChargeLimitEnabled": true,
                "monthlyUsed": { "priceInCents": "4567" },
                "monthlyChargeLimit": { "priceInCents": 10000 }
            }
        })),
        ("mixed_string_number", json!({
            "limits": [{ "detail": { "used": "68", "limit": "100", "resetTime": "2030-01-01T00:00:00+08:00" } }],
            "usage": { "used": 68, "limit": 100 }
        })),
        ("div_zero", json!({ "limits": [{ "detail": { "used": "50", "limit": "0" } }] })),
        ("neg_limit", json!({ "limits": [{ "detail": { "used": "50", "limit": -100 } }] })),
        ("hostile_inf", json!({ "usage": { "used": "1e999", "limit": 1 } })),
        ("hostile_nan", json!({ "usage": { "used": "NaN", "limit": 1 } })),
        ("nan_limit", json!({ "usage": { "used": "5", "limit": "NaN" } })),
        ("empty", json!({})),
        ("limits_not_array", json!({ "limits": { "detail": { "used": "1", "limit": "2" } } })),
        ("detail_string", json!({ "limits": [{ "detail": "nope" }] })),
        ("usage_null", json!({ "usage": null })),
        ("usage_string", json!({ "usage": "nope" })),
        ("disabled_wallet", json!({
            "boosterWallet": { "isEnabled": false, "balance": { "amountLeft": "123456789" } }
        })),
        ("isenabled_string_false", json!({
            "boosterWallet": { "isEnabled": "false", "balance": { "amountLeft": "123456789" } }
        })),
        ("isenabled_zero", json!({
            "boosterWallet": { "isEnabled": 0, "balance": { "amountLeft": "1500000" } }
        })),
        ("no_wallet", json!({ "boosterWallet": null })),
        ("wallet_string", json!({ "boosterWallet": "nope" })),
        ("amount_frac_number", json!({
            "boosterWallet": { "isEnabled": true, "balance": { "amountLeft": 1500000.7 } }
        })),
        ("amount_negative_round", json!({
            "boosterWallet": { "isEnabled": true, "balance": { "amountLeft": "-1499999" } }
        })),
        ("amount_negative_round2", json!({
            "boosterWallet": { "isEnabled": true, "balance": { "amountLeft": "-1500001" } }
        })),
        ("amount_huge", json!({
            "boosterWallet": { "isEnabled": true, "balance": { "amountLeft": "9223372036854775807" } }
        })),
        ("nodata_monthly_on", json!({
            "boosterWallet": {
                "isEnabled": true,
                "balance": { "amountLeft": "not-a-number" },
                "monthlyChargeLimitEnabled": true,
                "monthlyUsed": { "priceInCents": "4567" },
                "monthlyChargeLimit": { "priceInCents": 10000 }
            }
        })),
        ("monthly_off_but_present", json!({
            "boosterWallet": {
                "isEnabled": true,
                "balance": { "amountLeft": "100000000" },
                "monthlyUsed": { "priceInCents": "4567" }
            }
        })),
        ("monthly_string_true", json!({
            "boosterWallet": {
                "isEnabled": true,
                "balance": { "amountLeft": "100000000" },
                "monthlyChargeLimitEnabled": "true",
                "monthlyUsed": { "priceInCents": "4567" }
            }
        })),
        ("reset_fraction", json!({
            "limits": [{ "detail": { "used": "1", "limit": "3", "resetTime": "2030-01-01T00:00:00.123456789+08:00" } }],
            "usage": { "used": "1", "limit": "3", "resetTime": "2030-01-02T00:00:00.500Z" }
        })),
    ];
    for (name, v) in &cases {
        write_raw(&format!("quota-{name}"), &pretty(&probe(v, at)));
    }
    for kind in ["no-token", "HttpRequestException", "TaskCanceledException", "JsonException"] {
        write_raw(&format!("quota-error-{kind}"), &pretty(&failed_at(kind, at_zero)));
    }

    // --- fill_missing_from (keep-last-good) shape ---
    let last = probe(&cases[0].1, at);
    let mut fresh = failed_at("HttpRequestException", at_zero);
    fresh.fill_missing_from(&last);
    write_raw("quota-fill-missing", &pretty(&fresh));

    // --- settings.json byte shape (PascalCase, no trailing newline) ---
    #[derive(serde::Serialize)]
    #[serde(rename_all = "PascalCase")]
    struct SettingsData { theme: String, refresh_minutes: i64, auto_start: bool }
    write_raw(
        "settings-default",
        &pretty(&SettingsData { theme: "system".into(), refresh_minutes: 5, auto_start: false }),
    );
}
`;

const full = `// GENERATED by kpt-s0/make-oracle.ts from rust/src/quota.rs — do not edit by hand.\n#![allow(dead_code)]\n\n${ported}\n${driver}\n`;

mkdirSync(`${OUT}/src`, { recursive: true });
writeFileSync(
  `${OUT}/Cargo.toml`,
  [
    "[package]",
    'name = "kpt-oracle"',
    'version = "0.0.0"',
    'edition = "2021"',
    "",
    "[dependencies]",
    'serde = { version = "1.0.229", features = ["derive"] }',
    'serde_json = "1.0.151"',
    'chrono = { version = "0.4.45", features = ["serde"] }',
    "",
  ].join("\n"),
  "utf8",
);
writeFileSync(`${OUT}/src/main.rs`, full, "utf8");
console.log(`oracle written: ${OUT}/src/main.rs (${full.split("\n").length} lines)`);
console.log(
  [
    "next:",
    `  cd ${OUT.replaceAll("\\", "/")} && cargo run --offline`,
    `  cp ${OUT.replaceAll("\\", "/")}/golden/*.txt ${join(REPO, "ts-nodejs", "test", "golden").replaceAll("\\", "/")}/`,
    "  # the goldens embed DateTime<Local>, so regenerate on a +08:00 machine",
  ].join("\n"),
);
