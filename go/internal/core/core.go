// Package core hosts the UI-agnostic business layer of the Go edition:
// credentials, quota, polling, settings, skills, update, theme, state,
// format, and defensive JSON parsing (SPEC chapters 16-21).
//
// Layering rules (PLAN-GO §3):
//   - this package never imports the tui package;
//   - semantics oracle is rust/src/*.rs, the defensive-parsing base text is
//     ts/src/core/json.ts, and byte-exact output is pinned by the Rust-oracle
//     goldens in ../../testdata/golden (SPEC §22.1);
//   - REVIEW-M1's fixes are part of the baseline semantics, not follow-ups
//     (128-level JSON depth cap, 4 KiB skills read window, the resetTime
//     ladder, no setTimeout overflow class at all, U+FFFD escapes in tests).
package core
