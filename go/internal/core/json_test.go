package core

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// formatF64 vs the Rust oracle goldens
// ---------------------------------------------------------------------------

func TestFormatF64GoldenFloats(t *testing.T) {
	// Exact counts, pinned like the TS harness (M1 review Minor 6): a golden
	// regen or a regex regression must fail loudly, not silently narrow.
	wantCounts := map[string]int{"floats": 19, "float_grid": 85}
	for _, name := range []string{"floats", "float_grid"} {
		pairs := goldenPairs(name)
		if len(pairs) != wantCounts[name] {
			t.Fatalf("golden %s: %d pairs, want exactly %d", name, len(pairs), wantCounts[name])
		}
		for _, pair := range pairs {
			v, err := strconv.ParseFloat(pair[1], 64)
			if err != nil {
				t.Fatalf("golden %s: cannot parse %q: %v", name, pair[1], err)
			}
			got, ok := FormatF64(v)
			if !ok {
				t.Fatalf("%s %s: FormatF64 reported non-finite", name, pair[0])
			}
			if got != pair[1] {
				t.Errorf("%s %s: FormatF64(%v) = %q, want %q", name, pair[0], v, got, pair[1])
			}
		}
	}
}

func TestFormatF64NonFiniteIsNull(t *testing.T) {
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, ok := FormatF64(v); ok {
			t.Errorf("FormatF64(%v) must report no float text", v)
		}
	}
}

func TestFormatF64NegativeZeroKeepsSign(t *testing.T) {
	if got, _ := FormatF64(math.Copysign(0, -1)); got != "-0.0" {
		t.Errorf("FormatF64(-0) = %q, want -0.0", got)
	}
	if got, _ := FormatF64(0); got != "0.0" {
		t.Errorf("FormatF64(0) = %q, want 0.0", got)
	}
}

// ---------------------------------------------------------------------------
// formatDateTimeLocal vs chrono
// ---------------------------------------------------------------------------

const goldenEpochSecs = 1_893_456_000 // 2030-01-01T00:00:00Z

func TestFormatDateTimeLocalGolden(t *testing.T) {
	if pairs := goldenPairs("datetime"); len(pairs) != 6 {
		t.Fatalf("datetime golden: %d rows, want exactly 6 (M1 review Minor 6)", len(pairs))
	}
	nanosCases := map[string]int32{
		"nanos_0":         0,
		"nanos_123456789": 123_456_789,
		"nanos_123000000": 123_000_000,
		"nanos_123456000": 123_456_000,
		"nanos_500000000": 500_000_000,
		"whole_minute":    -1, // handled below: a whole minute later, zero nanos
	}
	for label, nanos := range nanosCases {
		ms := int64(goldenEpochSecs) * 1000
		wantNanos := nanos
		if nanos == -1 {
			ms += 60_000
			wantNanos = 0
		}
		var want string
		for _, pair := range goldenPairs("datetime") {
			if pair[0] == label {
				want = strings.Trim(pair[1], `"`)
			}
		}
		if want == "" {
			t.Fatalf("datetime golden has no row %q", label)
		}
		got := FormatDateTimeLocal(DtFromParts(ms, wantNanos))
		if got != want {
			t.Errorf("%s: FormatDateTimeLocal = %q, want %q", label, got, want)
		}
	}
}

func TestFormatDateTimeLocalNowShape(t *testing.T) {
	text := FormatDateTimeLocal(DtFromNow(goldenEpochSecs*1000 + 594))
	re := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3,9})?[+-]\d{2}:\d{2}$`)
	if !re.MatchString(text) {
		t.Errorf("now-shaped stamp %q does not match the chrono shape", text)
	}
	if strings.Contains(text, "Z") {
		t.Errorf("now-shaped stamp %q must never print Z", text)
	}
}

func TestAutoSiFractionStripsWholeGroups(t *testing.T) {
	cases := map[int32]string{
		0:           "",
		500_000_000: ".500",
		123_000_000: ".123",
		123_456_000: ".123456",
		123_456_789: ".123456789",
		100_000:     ".000100",
		1:           ".000000001",
	}
	for nanos, want := range cases {
		if got := AutoSiFraction(nanos); got != want {
			t.Errorf("AutoSiFraction(%d) = %q, want %q", nanos, got, want)
		}
	}
}

// ---------------------------------------------------------------------------
// Rust from_str grammar
// ---------------------------------------------------------------------------

var goldenEscapeRe = regexp.MustCompile(`\\u\{([0-9a-fA-F]+)\}`)

// rustDisplayToNumber decodes the golden's Rust Debug text of an f64.
func rustDisplayToNumber(t *testing.T, text string) float64 {
	t.Helper()
	switch text {
	case "inf":
		return math.Inf(1)
	case "-inf":
		return math.Inf(-1)
	case "NaN":
		return math.NaN()
	}
	v, err := strconv.ParseFloat(text, 64)
	if err != nil {
		t.Fatalf("golden f64 display %q does not parse: %v", text, err)
	}
	return v
}

func floatEq(a, b float64) bool {
	if math.IsNaN(a) && math.IsNaN(b) {
		return true
	}
	return a == b
}

func TestParseMatrixGolden(t *testing.T) {
	for _, row := range goldenRows("parse_matrix") {
		input, f64Field, i64Field := row[0], row[1], row[2]
		// The golden ran the input through Rust's escape_debug, so restore it.
		decoded := goldenEscapeRe.ReplaceAllStringFunc(input, func(m string) string {
			hex := goldenEscapeRe.FindStringSubmatch(m)[1]
			n, _ := strconv.ParseInt(hex, 16, 32)
			return string(rune(n))
		})
		trimmed := RustTrim(decoded)
		if strings.HasSuffix(f64Field, "ERR") {
			if _, ok := ParseF64Strict(trimmed); ok {
				t.Errorf("parse_matrix %q: f64 should be ERR", input)
			}
		} else {
			want := rustDisplayToNumber(t, strings.TrimPrefix(f64Field, "f64="))
			got, ok := ParseF64Strict(trimmed)
			if !ok || !floatEq(got, want) {
				t.Errorf("parse_matrix %q: f64 = (%v, %v), want %v", input, got, ok, want)
			}
		}
		if strings.HasSuffix(i64Field, "ERR") {
			if _, ok := ParseI64Strict(trimmed); ok {
				t.Errorf("parse_matrix %q: i64 should be ERR", input)
			}
		} else {
			want, _ := strconv.ParseInt(strings.TrimPrefix(i64Field, "i64="), 10, 64)
			if got, ok := ParseI64Strict(trimmed); !ok || got != want {
				t.Errorf("parse_matrix %q: i64 = (%d, %v), want %d", input, got, ok, want)
			}
		}
	}
}

func TestParseStrictRejectAccept(t *testing.T) {
	if _, ok := ParseF64Strict("68abc"); ok {
		t.Error("68abc must be rejected")
	}
	if _, ok := ParseF64Strict("0x10"); ok {
		t.Error("0x10 must be rejected")
	}
	if _, ok := ParseF64Strict("1_000"); ok {
		t.Error("1_000 must be rejected")
	}
	if _, ok := ParseF64Strict(""); ok {
		t.Error("empty string must be rejected")
	}
	if v, ok := ParseF64Strict("1."); !ok || v != 1 {
		t.Error("1. must parse as 1")
	}
	if v, ok := ParseF64Strict(".5"); !ok || v != 0.5 {
		t.Error(".5 must parse as 0.5")
	}
	if v, ok := ParseF64Strict("1E+5"); !ok || v != 100000 {
		t.Error("1E+5 must parse as 100000")
	}
	if v, ok := ParseF64Strict("-Infinity"); !ok || !math.IsInf(v, -1) {
		t.Error("-Infinity must parse as -inf")
	}
	if v, ok := ParseF64Strict("1e999"); !ok || !math.IsInf(v, 1) {
		t.Error("1e999 must saturate to +inf, not fail")
	}
	if _, ok := ParseI64Strict("1e5"); ok {
		t.Error("1e5 must be rejected as i64")
	}
	if _, ok := ParseI64Strict("123.5"); ok {
		t.Error("123.5 must be rejected as i64")
	}
	if v, ok := ParseI64Strict("+68"); !ok || v != 68 {
		t.Error("+68 must parse as 68")
	}
	if v, ok := ParseI64Strict("007"); !ok || v != 7 {
		t.Error("007 must parse as 7")
	}
	if v, ok := ParseI64Strict("9223372036854775807"); !ok || v != math.MaxInt64 {
		t.Error("i64::MAX must parse")
	}
	if _, ok := ParseI64Strict("9223372036854775808"); ok {
		t.Error("i64::MAX+1 must be rejected")
	}
	if _, ok := ParseU64Strict("-1"); ok {
		t.Error("-1 must be rejected as u64")
	}
	if v, ok := ParseU64Strict("18446744073709551615"); !ok || v != math.MaxUint64 {
		t.Error("u64::MAX must parse")
	}
	if _, ok := ParseU64Strict("18446744073709551616"); ok {
		t.Error("u64::MAX+1 must be rejected")
	}
}

// ---------------------------------------------------------------------------
// serde_json::Value parity
// ---------------------------------------------------------------------------

func TestAsI64Golden(t *testing.T) {
	for _, row := range goldenRows("as_i64") {
		source := row[0]
		if strings.HasPrefix(row[1], "PARSE_ERR=") {
			want := strings.TrimPrefix(row[1], "PARSE_ERR=")
			_, err := ParseJSONValue(source)
			if err == nil {
				t.Errorf("as_i64 %q: document should fail", source)
			} else if err.Error() != want {
				t.Errorf("as_i64 %q: error = %q, want %q", source, err.Error(), want)
			}
			continue
		}
		i64Field, f64Field := row[1], row[2]
		expected := strings.TrimPrefix(i64Field, "as_i64=")
		parsed, err := ParseJSONValue(source)
		if err != nil {
			t.Fatalf("as_i64 %q: unexpected error %v", source, err)
		}
		member := JGet(parsed, "v")
		got, ok := JAsI64(member)
		if expected == "None" {
			if ok {
				t.Errorf("as_i64 %q: should be None, got %d", source, got)
			}
		} else {
			want, _ := strconv.ParseInt(expected, 10, 64)
			if !ok || got != want {
				t.Errorf("as_i64 %q: got (%d, %v), want %d", source, got, ok, want)
			}
		}
		wantF64 := rustDisplayToNumber(t, strings.TrimPrefix(f64Field, "as_f64="))
		gotF64, _ := JAsF64(member)
		if !floatEq(gotF64, wantF64) {
			t.Errorf("as_i64 %q: as_f64 = %v, want %v", source, gotF64, wantF64)
		}
	}
}

func TestParseJSONValueFailures(t *testing.T) {
	if _, err := ParseJSONValue(`{"v":1e400}`); err == nil || !strings.Contains(err.Error(), "number out of range") {
		t.Errorf("1e400 must be number out of range, got %v", err)
	}
	if _, err := ParseJSONValue("{} {}"); err == nil || !strings.Contains(err.Error(), "trailing characters") {
		t.Errorf("trailing garbage must fail, got %v", err)
	}
	for _, bad := range []string{`{"a":1,}`, "nullx", `{"a":"\q"}`, `{"a":"x`} {
		if _, err := ParseJSONValue(bad); err == nil {
			t.Errorf("%q must fail to parse", bad)
		}
	}
	// The oracle golden pins the serde column for the range error.
	if _, err := ParseJSONValue(`{"v":1e400}`); err != nil && err.Error() != "number out of range at line 1 column 10" {
		t.Errorf("range error text = %q", err.Error())
	}
}

func TestDuplicateKeysKeepLast(t *testing.T) {
	value, err := ParseJSONValue(`{"a":1,"a":2}`)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := JAsI64(JGet(value, "a"))
	if !ok || got != 2 {
		t.Errorf("duplicate key must keep the last value, got %d", got)
	}
}

func TestEscapesDecodeAsJSONRequires(t *testing.T) {
	value, err := ParseJSONValue(`{"s":"A\u00e9\t\/\\"}`)
	if err != nil {
		t.Fatal(err)
	}
	member := JGet(value, "s")
	if member == nil || member.Kind != JStr || member.Str != "Aé\t/\\" {
		t.Errorf("escape decode = %v", member)
	}
}

// ---------------------------------------------------------------------------
// SerdePretty
// ---------------------------------------------------------------------------

func TestSerdePrettyKeyOrderIndentNullsFloatAndInt(t *testing.T) {
	stamp := DtFromParts(goldenEpochSecs*1000, 0)
	json := SerdePretty(SerObj{Pairs: []SerPair{
		{Key: "fiveHour", Val: SerObj{Pairs: []SerPair{
			{Key: "percent", Val: SerF64{Value: 21}},
			{Key: "resetAt", Val: SerDt{Value: stamp}},
		}}},
		{Key: "week", Val: nil},
		{Key: "extra", Val: SerObj{Pairs: []SerPair{
			{Key: "state", Val: SerStr{Value: "Ready"}},
			{Key: "balanceCents", Val: SerI64{Value: 1235}},
			{Key: "monthlyEnabled", Val: SerBool{Value: true}},
		}}},
		{Key: "error", Val: SerStr{Value: "no-token"}},
	}})
	lines := strings.Split(json, "\n")
	want := []string{
		"{",
		`  "fiveHour": {`,
		`    "percent": 21.0,`,
		`    "resetAt": "` + FormatDateTimeLocal(stamp) + `"`,
		`  },`,
		`  "week": null,`,
		`  "extra": {`,
		`    "state": "Ready",`,
		`    "balanceCents": 1235,`,
		`    "monthlyEnabled": true`,
		`  },`,
		`  "error": "no-token"`,
		"}",
	}
	if len(lines) != len(want) {
		t.Fatalf("pretty json has %d lines, want %d:\n%s", len(lines), len(want), json)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Errorf("line %d = %q, want %q", i, lines[i], want[i])
		}
	}
}

func TestSerdePrettyContainersAndNullRoot(t *testing.T) {
	if got := SerdePretty(SerObj{Pairs: []SerPair{
		{Key: "a", Val: SerObj{}},
		{Key: "b", Val: SerArr{}},
	}}); got != "{\n  \"a\": {},\n  \"b\": []\n}" {
		t.Errorf("empty containers: %q", got)
	}
	if got := SerdePretty(SerArr{Items: []SerNode{
		SerI64{Value: 1}, nil, SerArr{Items: []SerNode{SerBool{Value: false}}},
	}}); got != "[\n  1,\n  null,\n  [\n    false\n  ]\n]" {
		t.Errorf("nested array: %q", got)
	}
	if got := SerdePretty(nil); got != "null" {
		t.Errorf("null root: %q", got)
	}
}

func TestSerdePrettyEscapeTable(t *testing.T) {
	if got := SerdePretty(SerStr{Value: "a\"b\\c"}); got != `"a\"b\\c"` {
		t.Errorf("quote escape: %q", got)
	}
	if got := SerdePretty(SerStr{Value: "x\ty\nz\x01"}); got != `"x\ty\nz\u0001"` {
		t.Errorf("control escape: %q", got)
	}
	// Non-ASCII, slash and U+2028 are written raw, exactly like serde_json.
	raw := SerdePretty(SerStr{Value: "é中\n"})
	if !strings.Contains(raw, "é") || !strings.Contains(raw, "中") {
		t.Errorf("non-ASCII must stay raw: %q", raw)
	}
	if strings.Contains(raw, `\u00e9`) || strings.Contains(raw, `\/`) {
		t.Errorf("no over-escaping allowed: %q", raw)
	}
}

// ---------------------------------------------------------------------------
// Rust text idioms
// ---------------------------------------------------------------------------

func TestRustTrimUsesUnicodeWhiteSpaceSet(t *testing.T) {
	if got := RustTrim("  x  "); got != "x" {
		t.Errorf("RustTrim basic = %q", got)
	}
	if got := RustTrim("\t\n\rx"); got != "x" {
		t.Errorf("RustTrim controls = %q", got)
	}
	if got := RustTrim("\u0085x"); got != "x" {
		t.Errorf("RustTrim NEL = %q", got)
	}
	if got := RustTrim("\uFEFFx"); got != "\uFEFFx" {
		t.Errorf("BOM is not whitespace for Rust: %q", got)
	}
	if got := RustTrimEnd("x  "); got != "x" {
		t.Errorf("RustTrimEnd = %q", got)
	}
	if got := RustTrimEnd("x\uFEFF"); got != "x\uFEFF" {
		t.Errorf("RustTrimEnd BOM = %q", got)
	}
	if got := RustTrim("\u3000x"); got != "x" {
		t.Errorf("ideographic space: %q", got)
	}
}

func TestRustLines(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"a\r\nb\nc\n", []string{"a", "b", "c"}},
		{"a\n\nb", []string{"a", "", "b"}},
		{"", nil},
		{"only", []string{"only"}},
	}
	for _, c := range cases {
		got := RustLines(c.in)
		if len(got) != len(c.want) {
			t.Errorf("RustLines(%q) = %v, want %v", c.in, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("RustLines(%q)[%d] = %q, want %q", c.in, i, got[i], c.want[i])
			}
		}
	}
}

func TestBOMAndQuoteStripping(t *testing.T) {
	if got := RustStripLeadingBoms("\uFEFF\uFEFF---"); got != "---" {
		t.Errorf("double BOM strip: %q", got)
	}
	if got := RustStripLeadingBoms("---\uFEFF"); got != "---\uFEFF" {
		t.Errorf("trailing BOM stays: %q", got)
	}
	if got := RustTrimMatchesChar(`"quoted"`, `"`); got != "quoted" {
		t.Errorf("double quotes: %q", got)
	}
	if got := RustTrimMatchesChar("''a''", "'"); got != "a" {
		t.Errorf("single quotes: %q", got)
	}
	if got := RustTrimMatchesChar(`"'mixed"'`, `"`); got != `'mixed"'` {
		t.Errorf("mixed quotes: %q", got)
	}
	if got := RustTrimMatchesChar("  x  ", " "); got != "x" {
		t.Errorf("space trim: %q", got)
	}
}

func TestRuneLenCountsCodePoints(t *testing.T) {
	if got := RuneLen("éab"); got != 3 {
		t.Errorf("RuneLen(éab) = %d", got)
	}
	if got := RuneLen("😀x"); got != 2 {
		t.Errorf("RuneLen(😀x) = %d", got)
	}
	if got := RuneLen("中文"); got != 2 {
		t.Errorf("RuneLen(中文) = %d", got)
	}
}

func TestTruncDivAndSaturatingAdd(t *testing.T) {
	if TruncDiv(-1499999, 1000000) != -1 || TruncDiv(1499999, 1000000) != 1 {
		t.Error("TruncDiv must truncate toward zero")
	}
	if v := int64(-1499999) / 1000000; v != -1 {
		t.Error("Go integer division must truncate toward zero")
	}
	if v := SaturatingAddI64(math.MaxInt64, 500000); v != math.MaxInt64 {
		t.Error("saturating add must clamp high")
	}
	if v := SaturatingAddI64(math.MinInt64, -1); v != math.MinInt64 {
		t.Error("saturating add must clamp low")
	}
}

// ---------------------------------------------------------------------------
// recursion limit (serde_json parity, REVIEW-M1 Minor 1)
// ---------------------------------------------------------------------------

func TestRecursionLimit(t *testing.T) {
	within := strings.Repeat("[", 128) + strings.Repeat("]", 128)
	if _, err := ParseJSONValue(within); err != nil {
		t.Errorf("128 levels must parse, got %v", err)
	}
	beyond := strings.Repeat("[", 129) + strings.Repeat("]", 129)
	if _, err := ParseJSONValue(beyond); err == nil {
		t.Error("129 levels must be a parse error, not a stack overflow")
	}
}

// M1 review Minor 5: lone surrogates are a parse error (serde_json's error
// catalog), and a valid surrogate pair decodes to its code point instead of
// turning into two U+FFFD.
func TestSurrogateEscapes(t *testing.T) {
	parsed, err := ParseJSONValue(`{"s":"\ud83d\ude00"}`)
	if err != nil {
		t.Fatal(err)
	}
	if got := JGet(parsed, "s"); got == nil || got.Kind != JStr || got.Str != "😀" {
		t.Errorf("surrogate pair must decode to the code point, got %+v", got)
	}
	if _, err := ParseJSONValue(`{"s":"\ud800"}`); err == nil || !strings.Contains(err.Error(), "hex escape") {
		// serde_json: UnexpectedEndOfHexEscape for a dangling high surrogate.
		t.Errorf("lone high surrogate must fail, got %v", err)
	}
	if _, err := ParseJSONValue(`{"s":"\udc00"}`); err == nil || !strings.Contains(err.Error(), "surrogate") {
		t.Errorf("lone low surrogate must fail, got %v", err)
	}
	if _, err := ParseJSONValue(`{"s":"\ud800x"}`); err == nil {
		t.Error("a high surrogate followed by a non-escape must fail")
	}
	if _, err := ParseJSONValue(`{"s":"\ud800"}`); err == nil || strings.Contains(err.Error(), "U+FFFD") {
		t.Error("lone surrogates must never degrade to U+FFFD silently")
	}
}

// ---------------------------------------------------------------------------
// LossyDecode (from_utf8_lossy maximal subpart semantics)
// ---------------------------------------------------------------------------

func TestLossyDecodeMaximalSubpart(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		want string
	}{
		{"valid cjk", []byte{0xE4, 0xB8, 0xAD}, "中"},
		{"ascii passes through", []byte("A中B"), "A中B"},
		{"truncated tail is one FFFD", []byte{0xE4, 0xB8}, "\uFFFD"},
		{"invalid continuation after lead", []byte{0xE4, 0x41}, "\uFFFDA"},
		{"GBK bytes are one FFFD each", []byte{0xD6, 0xD0, 0xCE, 0xC4}, "\uFFFD\uFFFD\uFFFD\uFFFD"},
		{"overlong lead C0", []byte{0xC0, 0x80}, "\uFFFD\uFFFD"},
		// A lead whose continuation is out of range yields one FFFD for the
		// maximal subpart (the lead alone); the stray continuations that
		// follow are then one FFFD each, matching from_utf8_lossy.
		{"surrogate lead ED A0", []byte{0xED, 0xA0, 0x80}, "\uFFFD\uFFFD\uFFFD"},
		{"E0 needs A0 continuation", []byte{0xE0, 0x80, 0x80}, "\uFFFD\uFFFD\uFFFD"},
		{"F4 beyond U+10FFFF", []byte{0xF4, 0x90, 0x80, 0x80}, "\uFFFD\uFFFD\uFFFD\uFFFD"},
		{"valid 4-byte emoji", []byte{0xF0, 0x9F, 0x98, 0x80}, "😀"},
	}
	for _, c := range cases {
		if got := LossyDecode(c.in); got != c.want {
			t.Errorf("%s: LossyDecode = %q, want %q", c.name, got, c.want)
		}
	}
}
