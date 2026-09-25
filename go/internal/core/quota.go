// Quota fetch + defensive parsing, a port of QuotaService (SPEC section 16).
// Traps honored here (SPEC 16.3):
//   - server JSON numbers are modeled as strings, numeric fallback tolerated
//   - Extra Usage amountLeft unit is 1e-8 yuan -> cents = (raw + 500000) / 1000000
//   - isEnabled == false must be reported as NotActivated (KimiCodeBar v1.1.1 bug)
//
// Go integers are int64 end to end, so the TS bigint/clamp machinery reduces
// to plain arithmetic with explicit saturating guards (PLAN-GO §4.1).
package core

import (
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const usagesURL = "https://api.kimi.com/coding/v1/usages"
const httpTimeout = 10 * time.Second

// QuotaSegment is one usage window.
type QuotaSegment struct {
	Percent float64
	ResetAt *RustDateTime
}

// ExtraState is the PascalCase enum: serde prints the variant names verbatim
// and --test-fetch diffs against them (SPEC 16.4).
type ExtraState string

const (
	ExtraNotActivated ExtraState = "NotActivated"
	ExtraNoData       ExtraState = "NoData"
	ExtraReady        ExtraState = "Ready"
)

// ExtraInfo is the booster wallet card.
type ExtraInfo struct {
	State             ExtraState
	BalanceCents      *int64
	MonthlyEnabled    bool
	MonthlyUsedCents  *int64
	MonthlyLimitCents *int64
}

// QuotaResult is the fetch outcome.
type QuotaResult struct {
	FiveHour  *QuotaSegment
	Week      *QuotaSegment
	Extra     *ExtraInfo
	FetchedAt RustDateTime
	Error     *string
}

// ErrorKind returns the .NET-style error name, or "" on success.
func (r *QuotaResult) ErrorKind() string {
	if r.Error == nil {
		return ""
	}
	return *r.Error
}

func failedQuota(kind string, nowMs int64) QuotaResult {
	return QuotaResult{FetchedAt: DtFromNow(nowMs), Error: &kind}
}

// FillMissingFrom keeps last-known-good data on failure: fill the nil fields
// from `last` (SPEC 16.5 step 2; the UI only shows the failure hint in the
// status line). FetchedAt and Error are never replaced, so the stamp stays
// the failure time.
func FillMissingFrom(result, last *QuotaResult) {
	if result.FiveHour == nil {
		result.FiveHour = last.FiveHour
	}
	if result.Week == nil {
		result.Week = last.Week
	}
	if result.Extra == nil {
		result.Extra = last.Extra
	}
}

// HTTPDoer is the transport seam the tests drive (net/http.Client satisfies
// it unchanged).
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// QuotaDeps carries the injected seams of FetchQuota; zero values select the
// production behavior.
type QuotaDeps struct {
	Doer    HTTPDoer      // nil -> the shared real client
	URL     string        // "" -> usagesURL
	Token   *string       // non-nil: use this token verbatim
	NoToken bool          // true: skip the credential chain, fail with "no-token"
	Timeout time.Duration // 0 -> 10s
	NowMs   func() int64  // nil -> time.Now().UnixMilli()
}

func (d *QuotaDeps) nowMs() int64 {
	if d.NowMs != nil {
		return d.NowMs()
	}
	return time.Now().UnixMilli()
}

var realHTTPClient = &http.Client{Timeout: httpTimeout}

// FetchQuota is `GET https://api.kimi.com/coding/v1/usages` (SPEC 16.1) with
// the .NET-style error names the SPEC keeps for cross-edition diffing
// (SPEC 16.4): connect/header-phase timeout -> TaskCanceledException; other
// network errors and non-2xx -> HttpRequestException; a body failure after
// the headers arrived -> JsonException (the reqwest `.json()` semantics).
func FetchQuota(deps QuotaDeps) QuotaResult {
	url := deps.URL
	if url == "" {
		url = usagesURL
	}
	var token string
	switch {
	case deps.NoToken:
		return failedQuota("no-token", deps.nowMs())
	case deps.Token != nil:
		token = *deps.Token
	default:
		loaded, ok := LoadToken(nil)
		if !ok {
			return failedQuota("no-token", deps.nowMs())
		}
		token = loaded
	}

	doer := deps.Doer
	if doer == nil {
		// The default client is shared, so the keep-alive pool and TLS
		// sessions survive across polls, mirroring the Rust OnceLock<Client>
		// (quota.rs:78-83; M1 review Minor 4).
		if deps.Timeout == 0 {
			doer = realHTTPClient
		} else {
			doer = &http.Client{Timeout: deps.Timeout}
		}
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return failedQuota("HttpRequestException", deps.nowMs())
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := doer.Do(req)
	if err != nil {
		if isTimeoutErr(err) {
			return failedQuota("TaskCanceledException", deps.nowMs())
		}
		return failedQuota("HttpRequestException", deps.nowMs())
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		// Drain the body so the keep-alive connection returns to the pool;
		// the request already failed semantically, so a drain error is moot
		// (REVIEW-M1 Minor 2; a Go mechanism note for SPEC 22.7).
		_, _ = io.Copy(io.Discard, resp.Body)
		return failedQuota("HttpRequestException", deps.nowMs())
	}
	// A timeout after the headers arrived is a body failure: JsonException,
	// not a cancellation — matching reqwest's .json() classification.
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return failedQuota("JsonException", deps.nowMs())
	}
	// serde's from_slice rejects invalid UTF-8 before any JSON grammar runs;
	// a hostile byte soup must be a JsonException, not mojibake (M1 review
	// Minor 5).
	if !utf8.Valid(body) {
		return failedQuota("JsonException", deps.nowMs())
	}
	root, err := ParseJSONValue(string(body))
	if err != nil {
		return failedQuota("JsonException", deps.nowMs())
	}
	return ParseQuotaPayload(root, DtFromNow(deps.nowMs()))
}

func isTimeoutErr(err error) bool {
	type timeouter interface{ Timeout() bool }
	if t, ok := err.(timeouter); ok {
		return t.Timeout()
	}
	return false
}

// getF64 is JSON number-or-string -> f64, missing or junk -> 0.
func getF64(v *JValue, key string) float64 {
	field := JGet(v, key)
	switch {
	case field == nil:
		return 0
	case field.Kind == JNum:
		return field.Num
	case field.Kind == JStr:
		if f, ok := ParseF64Strict(RustTrim(field.Str)); ok {
			return f
		}
		return 0
	default:
		return 0
	}
}

// getI64 is JSON number-or-string -> i64, anything else -> absent.
func getI64(v *JValue) (int64, bool) {
	switch {
	case v == nil:
		return 0, false
	case v.Kind == JNum:
		return JAsI64(v)
	case v.Kind == JStr:
		return ParseI64Strict(RustTrim(v.Str))
	default:
		return 0, false
	}
}

func parseCents(money *JValue) (int64, bool) {
	if money == nil || money.Kind != JObj {
		return 0, false
	}
	return getI64(JGet(money, "priceInCents"))
}

type dtFields struct {
	y, mo, d, h, mi, s int
	nanos              int32
	offsetMinutes      int
}

// pad9 normalizes a fraction capture (".123" -> 123000000 nanos).
func pad9(fraction string) int32 {
	digits := strings.TrimPrefix(fraction, ".")
	for len(digits) < 9 {
		digits += "0"
	}
	if len(digits) > 9 {
		digits = digits[:9]
	}
	n, _ := strconv.Atoi(digits)
	return int32(n)
}

// The resetTime ladder mirrors chrono's two very different tolerances, and
// the lowercase `t` is the hinge (SPEC 16.3; pinned by golden reset_time.txt):
// `parse_from_rfc3339` accepts `T`, `t` or a space between date and time but
// demands a colon'd offset with no space before it; the format list accepts
// an uppercase `T` or a space, lets the literal Space match any amount of
// whitespace — including none — plus a compact `+0800`.
var (
	rfc3339StrictRe = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([+-])(\d{2}):(\d{2})$`)
	withOffsetRe    = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)? *([+-])(\d{2}):?(\d{2})$`)
	// chrono's naive ladder is `%Y-%m-%d %H:%M:%S` (the space is an
	// Item::Space matching zero or more whitespace) and `%Y-%m-%dT%H:%M:%S`
	// (the `T` is a case-sensitive literal). Both pinned by reset_time.txt.
	naiveRe = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})(?:T| *)(\d{2}):(\d{2}):(\d{2})$`)
)

// instantOf returns the UTC epoch ms, or ok=false when the wall fields do not
// survive a UTC round-trip — chrono rejects impossible dates *and* times
// (`00:61:00` is not a time), and a FixedOffset is bounded to ±24 h.
func instantOf(f dtFields) (int64, bool) {
	utc := time.Date(f.y, time.Month(f.mo), f.d, f.h, f.mi, f.s, 0, time.UTC)
	if utc.Year() != f.y || int(utc.Month()) != f.mo || utc.Day() != f.d ||
		utc.Hour() != f.h || utc.Minute() != f.mi || utc.Second() != f.s {
		return 0, false
	}
	return utc.UnixMilli() - int64(f.offsetMinutes)*60_000, true
}

// ParseResetTime is the ladder from `parse_reset_time`: an offset-bearing
// form first (its offset fixes the instant), then a naive form interpreted as
// local wall time.
func ParseResetTime(raw string) *RustDateTime {
	// `Z` is just a zero offset for the patterns above.
	normalized := raw
	if strings.HasSuffix(raw, "Z") || strings.HasSuffix(raw, "z") {
		normalized = raw[:len(raw)-1] + "+00:00"
	}
	if m := rfc3339StrictRe.FindStringSubmatch(normalized); m != nil {
		f := fieldsOf(m)
		// chrono's %z rejects a minute component >= 60 ("+0899" is not an offset).
		offMinuteComponent := atoi(m[10])
		minutes := atoi(m[9])*60 + offMinuteComponent
		if offMinuteComponent < 60 && minutes < 24*60 {
			if m[8] == "-" {
				f.offsetMinutes = -minutes
			} else {
				f.offsetMinutes = minutes
			}
			if ms, ok := instantOf(f); ok {
				return &RustDateTime{Ms: ms, Nanos: f.nanos}
			}
		}
	}
	if m := withOffsetRe.FindStringSubmatch(normalized); m != nil {
		f := fieldsOf(m)
		offMinuteComponent := atoi(m[10])
		minutes := atoi(m[9])*60 + offMinuteComponent
		if offMinuteComponent < 60 && minutes < 24*60 {
			if m[8] == "-" {
				f.offsetMinutes = -minutes
			} else {
				f.offsetMinutes = minutes
			}
			if ms, ok := instantOf(f); ok {
				return &RustDateTime{Ms: ms, Nanos: f.nanos}
			}
		}
	}
	if m := naiveRe.FindStringSubmatch(raw); m != nil {
		f := fieldsOf(m)
		// and_local_timezone(Local).single(): the wall time must map to one
		// instant, so the fields must survive a local round-trip.
		probe := time.Date(f.y, time.Month(f.mo), f.d, f.h, f.mi, f.s, 0, time.Local)
		if probe.Year() == f.y && int(probe.Month()) == f.mo && probe.Day() == f.d &&
			probe.Hour() == f.h && probe.Minute() == f.mi && probe.Second() == f.s {
			return &RustDateTime{Ms: probe.UnixMilli(), Nanos: f.nanos}
		}
	}
	return nil
}

// fieldsOf reads the shared capture layout: 1..3 date, 4..6 time, 7 fraction,
// 8 offset sign, 9..10 offset hours/minutes. The naive pattern has no
// fraction group, so m[7] is read only when present.
func fieldsOf(m []string) dtFields {
	fraction := ""
	if len(m) > 7 {
		fraction = m[7]
	}
	return dtFields{
		y: atoi(m[1]), mo: atoi(m[2]), d: atoi(m[3]),
		h: atoi(m[4]), mi: atoi(m[5]), s: atoi(m[6]),
		nanos: pad9(fraction),
	}
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// ParseSegment builds one QuotaSegment from a detail/usage object.
func ParseSegment(v *JValue) QuotaSegment {
	used := getF64(v, "used")
	limit := getF64(v, "limit")
	if limit <= 0 {
		limit = 1 // Rust's guard leaves NaN alone, which floors percent to 0 below
	}
	resetTime := JGet(v, "resetTime")
	var resetAt *RustDateTime
	if resetTime != nil && resetTime.Kind == JStr {
		resetAt = ParseResetTime(resetTime.Str)
	}
	percent := used / limit * 100
	// getF64 can yield inf/NaN from hostile strings ("1e999", "NaN"); keep
	// percent finite so serialization never emits a non-finite double.
	if !isFinite(percent) {
		percent = 0
	}
	return QuotaSegment{Percent: percent, ResetAt: resetAt}
}

func isFinite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// ParseExtra builds the booster wallet card from `boosterWallet`.
func ParseExtra(wallet *JValue) ExtraInfo {
	info := ExtraInfo{State: ExtraNotActivated}
	if wallet == nil || wallet.Kind != JObj {
		return info // missing or non-object -> NotActivated
	}

	// isEnabled defense: with the booster disabled, amountLeft is an estimate
	// (limit minus used), not a balance -> the whole card must read
	// NotActivated (SPEC 16.3).
	if enabled, ok := JAsBool(JGet(wallet, "isEnabled")); ok && !enabled {
		return info
	}

	raw, ok := getI64(JGet(JGet(wallet, "balance"), "amountLeft"))
	if ok {
		info.State = ExtraReady
		// saturating_add: a pathological amountLeft near i64::MAX must not
		// overflow; 1e-8 yuan -> cents, rounded half up.
		info.BalanceCents = ptrI64(SaturatingAddI64(raw, 500_000) / 1_000_000)
	} else {
		info.State = ExtraNoData
	}

	if enabled, ok := JAsBool(JGet(wallet, "monthlyChargeLimitEnabled")); ok && enabled {
		info.MonthlyEnabled = true
		if used, ok := parseCents(JGet(wallet, "monthlyUsed")); ok {
			info.MonthlyUsedCents = ptrI64(used)
		}
		if limit, ok := parseCents(JGet(wallet, "monthlyChargeLimit")); ok {
			info.MonthlyLimitCents = ptrI64(limit)
		}
	}
	return info
}

func ptrI64(v int64) *int64 { return &v }

// ParseQuotaPayload is the success-path half of FetchQuota, split out so a
// stub payload can drive it (and the goldens do).
func ParseQuotaPayload(root *JValue, fetchedAt RustDateTime) QuotaResult {
	result := QuotaResult{FetchedAt: fetchedAt}

	if limits, ok := JAsArray(JGet(root, "limits")); ok && len(limits) > 0 {
		detail := JGet(limits[0], "detail")
		if detail != nil {
			seg := ParseSegment(detail)
			result.FiveHour = &seg
		}
	}
	if usage := JGet(root, "usage"); usage != nil && usage.Kind == JObj {
		seg := ParseSegment(usage)
		result.Week = &seg
	}
	extra := ParseExtra(JGet(root, "boosterWallet"))
	result.Extra = &extra
	return result
}

// QuotaResultToSerde is the camelCase serde shape --test-fetch prints
// (SPEC 19).
func QuotaResultToSerde(r *QuotaResult) SerNode {
	segment := func(s *QuotaSegment) SerNode {
		if s == nil {
			return nil
		}
		var resetAt SerNode
		if s.ResetAt != nil {
			resetAt = SerDt{Value: *s.ResetAt}
		}
		return SerObj{Pairs: []SerPair{
			{Key: "percent", Val: SerF64{Value: s.Percent}},
			{Key: "resetAt", Val: resetAt},
		}}
	}
	extra := func(e *ExtraInfo) SerNode {
		if e == nil {
			return nil
		}
		var balance, used, limit SerNode
		if e.BalanceCents != nil {
			balance = SerI64{Value: *e.BalanceCents}
		}
		if e.MonthlyUsedCents != nil {
			used = SerI64{Value: *e.MonthlyUsedCents}
		}
		if e.MonthlyLimitCents != nil {
			limit = SerI64{Value: *e.MonthlyLimitCents}
		}
		return SerObj{Pairs: []SerPair{
			{Key: "state", Val: SerStr{Value: string(e.State)}},
			{Key: "balanceCents", Val: balance},
			{Key: "monthlyEnabled", Val: SerBool{Value: e.MonthlyEnabled}},
			{Key: "monthlyUsedCents", Val: used},
			{Key: "monthlyLimitCents", Val: limit},
		}}
	}
	var errNode SerNode
	if r.Error != nil {
		errNode = SerStr{Value: *r.Error}
	}
	return SerObj{Pairs: []SerPair{
		{Key: "fiveHour", Val: segment(r.FiveHour)},
		{Key: "week", Val: segment(r.Week)},
		{Key: "extra", Val: extra(r.Extra)},
		{Key: "fetchedAt", Val: SerDt{Value: r.FetchedAt}},
		{Key: "error", Val: errNode},
	}}
}
