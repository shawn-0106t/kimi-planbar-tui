// Rust text-semantics layer shared by every core module (SPEC 16.4, 19).
//
// The Go edition must be able to emit byte-identical `--test-fetch` output to
// the Rust edition so the two can be diffed field by field, and it must parse
// server strings the way `str::parse::<f64/i64>()` does. This is a literal
// port of ts/src/core/json.ts (the most complete executable description of
// serde semantics in this repo, PLAN-GO §0-5); goldens come from the Rust
// oracle (SPEC §22.1).
package core

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// ---------------------------------------------------------------------------
// serde_json pretty output
// ---------------------------------------------------------------------------

// SerNode is a node in the same shape serde would print. A nil SerNode means
// JSON `null`, which is also how Option::None is printed — never omitted.
type SerNode interface{ serNode() }

// SerPair is one key/value entry of SerObj; a nil Val prints as null.
type SerPair struct {
	Key string
	Val SerNode
}

type SerObj struct{ Pairs []SerPair }
type SerArr struct{ Items []SerNode } // a nil item prints as null
type SerStr struct{ Value string }
type SerBool struct{ Value bool }
type SerI64 struct{ Value int64 }
type SerF64 struct{ Value float64 }
type SerDt struct{ Value RustDateTime }

func (SerObj) serNode()  {}
func (SerArr) serNode()  {}
func (SerStr) serNode()  {}
func (SerBool) serNode() {}
func (SerI64) serNode()  {}
func (SerF64) serNode()  {}
func (SerDt) serNode()   {}

// SerdePretty mirrors serde_json::to_string_pretty: 2-space indent, insertion
// order preserved, empty containers as `{}` / `[]`, one space after `:`.
func SerdePretty(node SerNode) string {
	var b strings.Builder
	serToString(&b, node, 0)
	return b.String()
}

func serToString(b *strings.Builder, node SerNode, indent int) {
	pad := strings.Repeat("  ", indent)
	switch n := node.(type) {
	case nil:
		b.WriteString(pad + "null")
	case SerStr:
		b.WriteString(pad + `"` + escapeJSONString(n.Value) + `"`)
	case SerBool:
		if n.Value {
			b.WriteString(pad + "true")
		} else {
			b.WriteString(pad + "false")
		}
	case SerI64:
		b.WriteString(pad + strconv.FormatInt(n.Value, 10))
	case SerF64:
		if text, ok := FormatF64(n.Value); ok {
			b.WriteString(pad + text)
		} else {
			b.WriteString(pad + "null")
		}
	case SerDt:
		b.WriteString(pad + `"` + FormatDateTimeLocal(n.Value) + `"`)
	case SerArr:
		if len(n.Items) == 0 {
			b.WriteString(pad + "[]")
			return
		}
		b.WriteString(pad + "[\n")
		for i, item := range n.Items {
			if i > 0 {
				b.WriteString(",\n")
			}
			serToString(b, item, indent+1)
		}
		b.WriteString("\n" + pad + "]")
	case SerObj:
		if len(n.Pairs) == 0 {
			b.WriteString(pad + "{}")
			return
		}
		b.WriteString(pad + "{\n")
		for i, pair := range n.Pairs {
			if i > 0 {
				b.WriteString(",\n")
			}
			innerPad := strings.Repeat("  ", indent+1)
			body := serToStringValue(pair.Val, indent+1)
			b.WriteString(innerPad + `"` + escapeJSONString(pair.Key) + `": ` + strings.TrimLeft(body, " "))
		}
		b.WriteString("\n" + pad + "}")
	}
}

// serToStringValue is serToString for possibly-nil nodes.
func serToStringValue(node SerNode, indent int) string {
	var b strings.Builder
	serToString(&b, node, indent)
	return b.String()
}

func hexDigit(n int) string { return "0123456789abcdef"[n&0xf : n&0xf+1] }

// escapeJSONString is serde_json's escape table: only `"`, `\` and the C0
// controls. Non-ASCII, `/`, U+2028/2029 and DEL are written out raw — so
// encoding/json's Marshal is unusable for this purpose.
func escapeJSONString(s string) string {
	var b strings.Builder
	for _, ch := range s {
		switch {
		case ch == '"':
			b.WriteString(`\"`)
		case ch == '\\':
			b.WriteString(`\\`)
		case ch == '\b':
			b.WriteString(`\b`)
		case ch == '\t':
			b.WriteString(`\t`)
		case ch == '\n':
			b.WriteString(`\n`)
		case ch == '\f':
			b.WriteString(`\f`)
		case ch == '\r':
			b.WriteString(`\r`)
		case ch < 0x20:
			b.WriteString(`\u00`)
			b.WriteString(hexDigit(int(ch) >> 4))
			b.WriteString(hexDigit(int(ch)))
		default:
			b.WriteRune(ch)
		}
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// f64 text (ryu through serde_json)
// ---------------------------------------------------------------------------

// FormatF64 is the text of an f64 the way serde_json writes it (ryu's
// shortest round-trip form). Pinned by the Rust oracle goldens floats.txt and
// float_grid.txt:
//   - always carries a fraction or an exponent (`68.0`, never `68`)
//   - fixed notation while the decimal exponent is in -5..=15 (`0.00001`,
//     `1000000000000000.0`); scientific outside it (`1e-6`, `1e+16`)
//   - a positive exponent keeps its `+`, a single-digit mantissa takes no `.0`
//   - negative zero prints as `-0.0`
//   - non-finite values are not printable: serde_json writes JSON `null`,
//     which is what the caller gets when ok is false
func FormatF64(v float64) (string, bool) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "", false
	}
	if v == 0 {
		if math.Signbit(v) {
			return "-0.0", true
		}
		return "0.0", true
	}

	// Shortest round-trip digits and the decimal exponent. Go's -1 precision
	// is Ryu — the same shortest form the TS port rebuilds via toExponential.
	text := strconv.FormatFloat(v, 'e', -1, 64)
	mant := text
	if mant[0] == '-' {
		mant = mant[1:]
	}
	eIdx := strings.IndexByte(mant, 'e')
	exp10, _ := strconv.Atoi(mant[eIdx+1:])
	digits := strings.Replace(mant[:eIdx], ".", "", 1)
	if trimmed := strings.TrimRight(digits, "0"); trimmed != "" {
		digits = trimmed
	}
	sign := ""
	if v < 0 {
		sign = "-"
	}
	if exp10 >= -5 && exp10 <= 15 {
		fixed := insertDot(digits, exp10+1)
		if !strings.Contains(fixed, ".") {
			fixed += ".0"
		}
		return sign + fixed, true
	}
	mantissa := digits
	if len(digits) > 1 {
		mantissa = digits[:1] + "." + digits[1:]
	}
	expSign := "+"
	if exp10 < 0 {
		expSign = "-"
	}
	return sign + mantissa + "e" + expSign + strconv.Itoa(absInt(exp10)), true
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// insertDot places the decimal point: `1797` + 5 -> `1.797e+3`-style
// placement for the fixed branch.
func insertDot(digits string, point int) string {
	if point <= 0 {
		return "0." + strings.Repeat("0", -point) + digits
	}
	if point >= len(digits) {
		return digits + strings.Repeat("0", point-len(digits))
	}
	return digits[:point] + "." + digits[point:]
}

// ---------------------------------------------------------------------------
// chrono RFC 3339 (DateTime<Local>)
// ---------------------------------------------------------------------------

// RustDateTime is an instant plus the *nanosecond* text chrono would print
// for it. Ms is Unix epoch milliseconds; Nanos is 0..999_999_999.
type RustDateTime struct {
	Ms    int64
	Nanos int32
}

// DtFromNow is `Local::now()` shaped. Go's clock granularity is milliseconds,
// so the fraction carries at most the three millisecond digits (AutoSi strips
// the rest); `fetchedAt` is a parity-exempt field, which is why that is fine
// (SPEC 22.1).
func DtFromNow(nowMs int64) RustDateTime {
	return RustDateTime{Ms: nowMs, Nanos: int32(nowMs%1000) * 1_000_000}
}

// DtFromParts keeps source nanoseconds (e.g. parsed out of the API) so the
// printed fraction follows chrono's AutoSi rule exactly.
func DtFromParts(ms int64, nanos int32) RustDateTime {
	return RustDateTime{Ms: ms, Nanos: nanos}
}

// AutoSiFraction is chrono SecondsFormat::AutoSi, pinned by the oracle golden
// datetime.txt: no fraction when nanos is zero, else the 9-digit text with
// whole trailing `000` groups removed (so `.500000000` prints `.500`).
func AutoSiFraction(nanos int32) string {
	if nanos == 0 {
		return ""
	}
	digits := fmt.Sprintf("%09d", nanos)
	for len(digits) > 3 && strings.HasSuffix(digits, "000") {
		digits = digits[:len(digits)-3]
	}
	return "." + digits
}

// localOffsetMinutesAt is the local zone offset at an instant, in minutes east
// of UTC.
func localOffsetMinutesAt(ms int64) int {
	_, off := time.Unix(0, ms*int64(time.Millisecond)).In(time.Local).Zone()
	return int(off / 60)
}

// FormatDateTimeLocal is `DateTime<Local>` as serde prints it:
// `YYYY-MM-DDTHH:MM:SS[.frac]±HH:MM`.
func FormatDateTimeLocal(dt RustDateTime) string {
	t := time.UnixMilli(dt.Ms).In(time.Local)
	offset := localOffsetMinutesAt(dt.Ms)
	abs := offset
	sign := "+"
	if offset < 0 {
		sign = "-"
		abs = -offset
	}
	return fmt.Sprintf("%04d-%02d-%02dT%02d:%02d:%02d%s%s%02d:%02d",
		t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute(), t.Second(),
		AutoSiFraction(dt.Nanos), sign, abs/60, abs%60)
}

// ---------------------------------------------------------------------------
// Rust string-parsing semantics
// ---------------------------------------------------------------------------

// isRustWS is Rust's `char::is_whitespace` = the Unicode White_Space property
// (Go's unicode.IsSpace is the same set). Deliberately not Go's unicode space
// in strings.TrimSpace: Rust excludes the BOM codepoint and includes U+0085.
func isRustWS(r rune) bool { return unicode.IsSpace(r) }

func trimEdges(s string, start, end bool) string {
	lo, hi := 0, len(s)
	if start {
		for lo < hi {
			r, size := utf8.DecodeRuneInString(s[lo:])
			if !isRustWS(r) {
				break
			}
			lo += size
		}
	}
	if end {
		for hi > lo {
			r, size := utf8.DecodeLastRuneInString(s[:hi])
			if !isRustWS(r) {
				break
			}
			hi -= size
		}
	}
	return s[lo:hi]
}

// RustTrim is `str::trim` under Rust's whitespace set.
func RustTrim(s string) string { return trimEdges(s, true, true) }

// RustTrimEnd is `str::trim_end`.
func RustTrimEnd(s string) string { return trimEdges(s, false, true) }

// RustTrimStart is `str::trim_start`.
func RustTrimStart(s string) string { return trimEdges(s, true, false) }

// RustStripLeadingBoms is `str::trim_start_matches('\u{feff}')` — strips *all*
// leading BOM codepoints.
func RustStripLeadingBoms(s string) string {
	for strings.HasPrefix(s, "\uFEFF") {
		s = s[len("\uFEFF"):]
	}
	return s
}

// RustTrimMatchesChar is `str::trim_matches('"')` / `('\”)` — strips all
// leading and trailing repeats.
func RustTrimMatchesChar(s, ch string) string {
	for strings.HasPrefix(s, ch) {
		s = s[len(ch):]
	}
	for strings.HasSuffix(s, ch) {
		s = s[:len(s)-len(ch)]
	}
	return s
}

// RustTrimMatchesAny is `str::trim_matches(closure)` — e.g. the `[`/`]` strip
// around a TOML section.
func RustTrimMatchesAny(s string, chars []string) string {
	set := make(map[string]struct{}, len(chars))
	for _, c := range chars {
		set[c] = struct{}{}
	}
	has := func(c string) bool { _, ok := set[c]; return ok }
	for len(s) > 0 {
		r, size := utf8.DecodeRuneInString(s)
		if !has(string(r)) {
			break
		}
		s = s[size:]
	}
	for len(s) > 0 {
		r, size := utf8.DecodeLastRuneInString(s)
		if !has(string(r)) {
			break
		}
		s = s[:len(s)-size]
	}
	return s
}

// RustLines is `str::lines()`: split on `\n`, one trailing `\r` dropped, no
// trailing empty item.
func RustLines(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, "\n")
	if parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	for i, p := range parts {
		parts[i] = strings.TrimSuffix(p, "\r")
	}
	return parts
}

// RustRunes is `str::chars()` — code points, which is what Rust indexing and
// `count()` mean.
func RustRunes(s string) []rune { return []rune(s) }

// RuneLen counts code points, not bytes.
func RuneLen(s string) int { return len([]rune(s)) }

const (
	i64Min = math.MinInt64
	i64Max = math.MaxInt64
)

var f64Re = regexp.MustCompile(`^(?i)[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|inf(?:inity)?|nan)$`)
var intRe = regexp.MustCompile(`^[+-]?[0-9]+$`)

// ParseF64Strict is `str::parse::<f64>()`: whole-string match, no separators,
// no hex; `inf`, `infinity` and `nan` are accepted case-insensitively, and an
// out-of-range magnitude saturates to ±inf instead of failing.
func ParseF64Strict(input string) (float64, bool) {
	if !f64Re.MatchString(input) {
		return 0, false
	}
	lowered := strings.ToLower(input)
	sign := 1.0
	if strings.HasPrefix(lowered, "-") {
		sign = -1
	}
	body := lowered
	if len(body) > 0 && (body[0] == '+' || body[0] == '-') {
		body = body[1:]
	}
	if body == "nan" {
		return math.NaN(), true
	}
	if body == "inf" || body == "infinity" {
		return sign * math.Inf(1), true
	}
	v, err := strconv.ParseFloat(input, 64)
	if err != nil {
		// str::parse saturates the magnitude: 1e999 -> inf, not an error.
		if numErr, ok := err.(*strconv.NumError); ok && numErr.Err == strconv.ErrRange && math.IsInf(v, 0) {
			return v, true
		}
		return 0, false
	}
	return v, true
}

// ParseI64Strict is `str::parse::<i64>()`: optional sign, digits only, no
// fraction or exponent.
func ParseI64Strict(input string) (int64, bool) {
	if !intRe.MatchString(input) {
		return 0, false
	}
	v, err := strconv.ParseInt(input, 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// ParseU64Strict is `str::parse::<u64>()`: no sign, digits only.
func ParseU64Strict(input string) (uint64, bool) {
	text := strings.TrimPrefix(input, "+")
	if !regexp.MustCompile(`^[0-9]+$`).MatchString(text) {
		return 0, false
	}
	v, err := strconv.ParseUint(text, 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// TruncDiv is Rust's `/` on integers: truncation toward zero (Go's integer
// division already truncates; the helper documents the intent at call sites).
func TruncDiv(a, b int64) int64 { return a / b }

// SaturatingAddI64 is Rust's `i64::saturating_add`.
func SaturatingAddI64(a, b int64) int64 {
	sum := a + b
	if a > 0 && b > 0 && sum < 0 {
		return i64Max
	}
	if a < 0 && b < 0 && sum >= 0 {
		return i64Min
	}
	return sum
}

// ---------------------------------------------------------------------------
// serde_json::Value with number-token fidelity
// ---------------------------------------------------------------------------

// RustJSONError marks where `resp.json()` would fail, i.e. the JsonException
// path (SPEC 16.4).
type RustJSONError struct{ Msg string }

func (e *RustJSONError) Error() string { return e.Msg }

// JKind discriminates JValue (a null kind is a *JValue with Kind JNull; a nil
// *JValue means "member absent").
type JKind int

const (
	JNull JKind = iota
	JBool
	JNum
	JStr
	JArr
	JObj
)

// JValue is a parsed JSON value that keeps the original number token.
// `Number::as_i64()` only answers for a token that was written as an integer:
// the oracle golden as_i64.txt shows `1.0`, `1e5` and `-0.0` all yield nothing
// even though the value is integral. It is also exact for integer tokens
// beyond 2^53, which a float64-only parse would round.
type JValue struct {
	Kind  JKind
	Bool  bool
	Num   float64
	Token string
	Str   string
	Arr   []*JValue
	Obj   map[string]*JValue
}

// JGet returns the member of an object, or nil when absent / not an object.
func JGet(v *JValue, key string) *JValue {
	if v == nil || v.Kind != JObj {
		return nil
	}
	return v.Obj[key]
}

// JAsStr is `Value::as_str`.
func JAsStr(v *JValue) (string, bool) {
	if v == nil || v.Kind != JStr {
		return "", false
	}
	return v.Str, true
}

// JAsBool is `Value::as_bool`.
func JAsBool(v *JValue) (bool, bool) {
	if v == nil || v.Kind != JBool {
		return false, false
	}
	return v.Bool, true
}

// JAsArray is `Value::as_array`.
func JAsArray(v *JValue) ([]*JValue, bool) {
	if v == nil || v.Kind != JArr {
		return nil, false
	}
	return v.Arr, true
}

// JAsF64 is `Value::as_f64`.
func JAsF64(v *JValue) (float64, bool) {
	if v == nil || v.Kind != JNum {
		return 0, false
	}
	return v.Num, true
}

// JAsI64 is `serde_json::Number::as_i64()` — an integer-formatted token
// inside the i64 range.
func JAsI64(v *JValue) (int64, bool) {
	if v == nil || v.Kind != JNum {
		return 0, false
	}
	if !intRe.MatchString(v.Token) {
		return 0, false
	}
	n, err := strconv.ParseInt(v.Token, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

var jsonNumberRe = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?`)

// ParseJSONValue is strict JSON parsing in serde_json's image: no trailing
// garbage, no comments, and a numeric literal beyond f64 range is an error
// (`number out of range`), which is how a `1e400` payload reaches the
// JsonException branch. The default recursion limit is serde_json's 128.
func ParseJSONValue(text string) (*JValue, error) {
	p := &jsonParser{text: text}
	root, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.skipWS()
	if p.pos != len(p.text) {
		return nil, &RustJSONError{Msg: "trailing characters"}
	}
	return root, nil
}

type jsonParser struct {
	text string
	pos  int
}

const maxJSONDepth = 128

func (p *jsonParser) fail(where string) error {
	return &RustJSONError{Msg: fmt.Sprintf("%s at line 1 column %d", where, p.pos+1)}
}

func (p *jsonParser) skipWS() {
	for p.pos < len(p.text) {
		switch p.text[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *jsonParser) value(depth int) (*JValue, error) {
	p.skipWS()
	if p.pos >= len(p.text) {
		return nil, p.fail("expected value")
	}
	switch p.text[p.pos] {
	case '{', '[':
		if depth+1 > maxJSONDepth {
			return nil, p.fail("recursion limit exceeded")
		}
		if p.text[p.pos] == '{' {
			return p.object(depth + 1)
		}
		return p.array(depth + 1)
	case '"':
		s, err := p.str()
		if err != nil {
			return nil, err
		}
		return &JValue{Kind: JStr, Str: s}, nil
	case 't':
		if err := p.literal("true"); err != nil {
			return nil, err
		}
		return &JValue{Kind: JBool, Bool: true}, nil
	case 'f':
		if err := p.literal("false"); err != nil {
			return nil, err
		}
		return &JValue{Kind: JBool, Bool: false}, nil
	case 'n':
		if err := p.literal("null"); err != nil {
			return nil, err
		}
		return &JValue{Kind: JNull}, nil
	default:
		return p.number()
	}
}

func (p *jsonParser) literal(word string) error {
	if !strings.HasPrefix(p.text[p.pos:], word) {
		return p.fail("expected value")
	}
	p.pos += len(word)
	return nil
}

func (p *jsonParser) number() (*JValue, error) {
	m := jsonNumberRe.FindString(p.text[p.pos:])
	if m == "" {
		return nil, p.fail("expected value")
	}
	// Keep the literal text: as_i64 only answers for integer-shaped tokens.
	v, err := strconv.ParseFloat(m, 64)
	if err != nil || math.IsInf(v, 0) {
		// serde errors before the token is consumed; the reported column is
		// the last consumed character, i.e. the end of the token.
		p.pos += len(m)
		return nil, &RustJSONError{Msg: fmt.Sprintf("number out of range at line 1 column %d", p.pos)}
	}
	p.pos += len(m)
	return &JValue{Kind: JNum, Num: v, Token: m}, nil
}

var jsonEscapes = map[byte]string{
	'b': "\b", 'f': "\f", 'n': "\n", 'r': "\r", 't': "\t",
	'"': `"`, '\\': "\\", '/': "/",
}

func (p *jsonParser) str() (string, error) {
	p.pos++ // opening quote
	var b strings.Builder
	from := p.pos
	for p.pos < len(p.text) {
		ch := p.text[p.pos]
		switch {
		case ch == '"':
			b.WriteString(p.text[from:p.pos])
			p.pos++
			return b.String(), nil
		case ch == '\\':
			b.WriteString(p.text[from:p.pos])
			p.pos++
			if p.pos >= len(p.text) {
				return "", p.fail("EOF while escaping")
			}
			esc := p.text[p.pos]
			p.pos++
			if esc == 'u' {
				if p.pos+4 > len(p.text) || !isHex4(p.text[p.pos:p.pos+4]) {
					return "", p.fail("invalid escape")
				}
				n, _ := strconv.ParseUint(p.text[p.pos:p.pos+4], 16, 32)
				p.pos += 4
				switch {
				case n >= 0xD800 && n <= 0xDBFF: // high surrogate: a following low surrogate completes the pair
					if !strings.HasPrefix(p.text[p.pos:], `\u`) {
						return "", p.fail("unexpected end of hex escape")
					}
					if p.pos+6 > len(p.text) || !isHex4(p.text[p.pos+2:p.pos+6]) {
						return "", p.fail("unexpected end of hex escape")
					}
					n2, _ := strconv.ParseUint(p.text[p.pos+2:p.pos+6], 16, 32)
					if n2 < 0xDC00 || n2 > 0xDFFF {
						return "", p.fail("lone leading surrogate in hex escape")
					}
					b.WriteRune(rune(0x10000 + (n-0xD800)<<10 + (n2 - 0xDC00)))
					p.pos += 6
				case n >= 0xDC00 && n <= 0xDFFF:
					return "", p.fail("unexpected ending surrogate in hex escape")
				default:
					b.WriteRune(rune(n))
				}
			} else if mapped, ok := jsonEscapes[esc]; ok {
				b.WriteString(mapped)
			} else {
				return "", p.fail("invalid escape")
			}
			from = p.pos
		case ch < 0x20:
			return "", p.fail("control character in string")
		default:
			p.pos++
		}
	}
	return "", p.fail("EOF while parsing a string")
}

func isHex4(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func (p *jsonParser) object(depth int) (*JValue, error) {
	p.pos++ // {
	members := make(map[string]*JValue)
	p.skipWS()
	if p.pos < len(p.text) && p.text[p.pos] == '}' {
		p.pos++
		return &JValue{Kind: JObj, Obj: members}, nil
	}
	for {
		p.skipWS()
		if p.pos >= len(p.text) || p.text[p.pos] != '"' {
			return nil, p.fail("key of an object")
		}
		key, err := p.str()
		if err != nil {
			return nil, err
		}
		p.skipWS()
		if p.pos >= len(p.text) || p.text[p.pos] != ':' {
			return nil, p.fail("colon after object key")
		}
		p.pos++
		v, err := p.value(depth)
		if err != nil {
			return nil, err
		}
		members[key] = v // a duplicate key keeps the last value, as serde does
		p.skipWS()
		if p.pos >= len(p.text) {
			return nil, p.fail("comma or closing brace")
		}
		switch p.text[p.pos] {
		case ',':
			p.pos++
		case '}':
			p.pos++
			return &JValue{Kind: JObj, Obj: members}, nil
		default:
			return nil, p.fail("comma or closing brace")
		}
	}
}

func (p *jsonParser) array(depth int) (*JValue, error) {
	p.pos++ // [
	items := []*JValue{}
	p.skipWS()
	if p.pos < len(p.text) && p.text[p.pos] == ']' {
		p.pos++
		return &JValue{Kind: JArr, Arr: items}, nil
	}
	for {
		v, err := p.value(depth)
		if err != nil {
			return nil, err
		}
		items = append(items, v)
		p.skipWS()
		if p.pos >= len(p.text) {
			return nil, p.fail("comma or closing bracket")
		}
		switch p.text[p.pos] {
		case ',':
			p.pos++
		case ']':
			p.pos++
			return &JValue{Kind: JArr, Arr: items}, nil
		default:
			return nil, p.fail("comma or closing bracket")
		}
	}
}

// LossyDecode mirrors Rust's String::from_utf8_lossy: each *maximal subpart*
// of an ill-formed byte sequence becomes ONE U+FFFD (Go's naive string(b)
// would emit one per byte, e.g. two for a truncated multi-byte character).
// Pinned by the GBK and 4 KiB-cut cases in the skills tests.
func LossyDecode(b []byte) string {
	var out strings.Builder
	i := 0
	for i < len(b) {
		r, size := utf8.DecodeRune(b[i:])
		if r != utf8.RuneError || size != 1 {
			out.WriteRune(r)
			i += size
			continue
		}
		out.WriteRune(0xFFFD)
		i += maximalSubpart(b[i:])
	}
	return out.String()
}

// maximalSubpart measures the longest prefix of an ill-formed sequence that
// UTF-8 grammar can still describe (Unicode's "maximal subpart" rule).
func maximalSubpart(b []byte) int {
	c := b[0]
	switch {
	case c < 0xC2 || c > 0xF4: // stray continuation, C0/C1, or F5..FF
		return 1
	case c < 0xE0: // two-byte lead C2..DF
		if len(b) < 2 || b[1] < 0x80 || b[1] > 0xBF {
			return 1
		}
		return 2
	case c < 0xF0: // three-byte lead E0..EF
		lo, hi := byte(0x80), byte(0xBF)
		switch c {
		case 0xE0:
			lo = 0xA0
		case 0xED:
			hi = 0x9F
		}
		if len(b) < 2 || b[1] < lo || b[1] > hi {
			return 1
		}
		if len(b) < 3 || b[2] < 0x80 || b[2] > 0xBF {
			return 2
		}
		return 3
	default: // four-byte lead F0..F4
		lo, hi := byte(0x80), byte(0xBF)
		switch c {
		case 0xF0:
			lo = 0x90
		case 0xF4:
			hi = 0x8F
		}
		if len(b) < 2 || b[1] < lo || b[1] > hi {
			return 1
		}
		if len(b) < 3 || b[2] < 0x80 || b[2] > 0xBF {
			return 2
		}
		if len(b) < 4 || b[3] < 0x80 || b[3] > 0xBF {
			return 3
		}
		return 4
	}
}
