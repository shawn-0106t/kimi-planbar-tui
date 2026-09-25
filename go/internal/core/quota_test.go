package core

import (
	"bytes"
	"errors"
	"io"
	"math"
	"net/http"
	"strings"
	"testing"
)

var (
	atZero  = DtFromParts(1_893_456_000_000, 0)
	atFracs = DtFromParts(1_893_456_000_000, 123_456_789)
)

func mustParse(t *testing.T, text string) *JValue {
	t.Helper()
	root, err := ParseJSONValue(text)
	if err != nil {
		t.Fatalf("parse %q: %v", text, err)
	}
	return root
}

func parseSegmentJ(t *testing.T, text string) QuotaSegment {
	t.Helper()
	return ParseSegment(mustParse(t, text))
}

func derefI64(p *int64) any {
	if p == nil {
		return "nil"
	}
	return *p
}

func TestSegmentAcceptsMixedStringAndNumberFields(t *testing.T) {
	asStrings := parseSegmentJ(t, `{"used":"68","limit":"100","resetTime":"2030-01-01T00:00:00+08:00"}`)
	asNumbers := parseSegmentJ(t, `{"used":68,"limit":100,"resetTime":"2030-01-01T00:00:00+08:00"}`)
	if asStrings.Percent != 68 || asNumbers.Percent != 68 {
		t.Errorf("percents = %v / %v, want 68 / 68", asStrings.Percent, asNumbers.Percent)
	}
	if asStrings.ResetAt == nil || asNumbers.ResetAt == nil {
		t.Error("resetAt must parse in both shapes")
	}
}

func TestSegmentGuardsDivisionByZero(t *testing.T) {
	if got := parseSegmentJ(t, `{"used":"50","limit":"0"}`).Percent; got != 5000 {
		t.Errorf("limit 0 clamps to 1: percent = %v, want 5000", got)
	}
	if got := parseSegmentJ(t, `{"used":"1e999","limit":1}`).Percent; got != 0 {
		t.Errorf("hostile inf must floor to 0, got %v", got)
	}
	missing := parseSegmentJ(t, `{}`)
	if missing.Percent != 0 || missing.ResetAt != nil {
		t.Errorf("missing fields: %+v", missing)
	}
	// NaN limit stays NaN through the guard (NaN <= 0 is false) and floors.
	if got := parseSegmentJ(t, `{"used":"5","limit":"NaN"}`).Percent; got != 0 {
		t.Errorf("NaN limit must floor percent to 0, got %v", got)
	}
}

func TestDisabledWalletIsNotActivated(t *testing.T) {
	info := ParseExtra(mustParse(t, `{"isEnabled":false,"balance":{"amountLeft":"123456789"}}`))
	if info.State != ExtraNotActivated || info.BalanceCents != nil {
		t.Errorf("disabled wallet = %+v", info)
	}
	if ParseExtra(nil).State != ExtraNotActivated {
		t.Error("missing wallet is NotActivated")
	}
	if ParseExtra(mustParse(t, `"nope"`)).State != ExtraNotActivated {
		t.Error("string wallet is NotActivated")
	}
	if ParseExtra(mustParse(t, "null")).State != ExtraNotActivated {
		t.Error("null wallet is NotActivated")
	}
}

func TestAmountLeftUnitConversionRounds(t *testing.T) {
	// 123456789 * 1e-8 yuan = 1.23456789 yuan = 123.456789 cents -> 123
	str := ParseExtra(mustParse(t, `{"isEnabled":true,"balance":{"amountLeft":"123456789"}}`))
	if str.State != ExtraReady || str.BalanceCents == nil || *str.BalanceCents != 123 {
		t.Errorf("string shape = %+v", str)
	}
	// 1500000 * 1e-8 yuan = 0.015 yuan = 1.5 cents -> rounds up to 2
	num := ParseExtra(mustParse(t, `{"isEnabled":true,"balance":{"amountLeft":1500000}}`))
	if num.BalanceCents == nil || *num.BalanceCents != 2 {
		t.Errorf("numeric shape = %+v", num)
	}
	// Unparseable amountLeft -> NoData
	junk := ParseExtra(mustParse(t, `{"isEnabled":true,"balance":{"amountLeft":"not-a-number"}}`))
	if junk.State != ExtraNoData || junk.BalanceCents != nil {
		t.Errorf("junk shape = %+v", junk)
	}
	// A fractional number token has no integer form -> NoData
	frac := ParseExtra(mustParse(t, `{"isEnabled":true,"balance":{"amountLeft":1500000.7}}`))
	if frac.State != ExtraNoData || frac.BalanceCents != nil {
		t.Errorf("fractional token = %+v", frac)
	}
	// Negative rounding follows Rust's integer division (truncation toward
	// zero): (-1499999 + 500000) / 1000000 = -999999 / 1000000 = 0.
	neg := ParseExtra(mustParse(t, `{"isEnabled":true,"balance":{"amountLeft":"-1499999"}}`))
	if neg.BalanceCents == nil || *neg.BalanceCents != 0 {
		t.Errorf("-1499999 -> %v, want 0", derefI64(neg.BalanceCents))
	}
	neg2 := ParseExtra(mustParse(t, `{"isEnabled":true,"balance":{"amountLeft":"-1500001"}}`))
	if neg2.BalanceCents == nil || *neg2.BalanceCents != -1 {
		t.Errorf("-1500001 -> %v, want -1", derefI64(neg2.BalanceCents))
	}
	// A pathological amountLeft near i64::MAX must not overflow.
	huge := ParseExtra(mustParse(t, `{"isEnabled":true,"balance":{"amountLeft":"9223372036854775807"}}`))
	if huge.BalanceCents == nil || *huge.BalanceCents != math.MaxInt64/1_000_000 {
		t.Errorf("huge amountLeft saturates: %+v", huge.BalanceCents)
	}
}

func TestMonthlyChargeFields(t *testing.T) {
	on := ParseExtra(mustParse(t, `{"isEnabled":true,"balance":{"amountLeft":"100000000"},`+
		`"monthlyChargeLimitEnabled":true,"monthlyUsed":{"priceInCents":"4567"},"monthlyChargeLimit":{"priceInCents":10000}}`))
	if !on.MonthlyEnabled || on.MonthlyUsedCents == nil || *on.MonthlyUsedCents != 4567 ||
		on.MonthlyLimitCents == nil || *on.MonthlyLimitCents != 10000 {
		t.Errorf("monthly on = %+v", on)
	}
	off := ParseExtra(mustParse(t, `{"isEnabled":true,"balance":{"amountLeft":"100000000"},"monthlyChargeLimitEnabled":false}`))
	if off.MonthlyEnabled || off.MonthlyUsedCents != nil {
		t.Errorf("monthly off = %+v", off)
	}
	// The flag must be a strict boolean: a "true" string or 0 number is not on.
	strTrue := ParseExtra(mustParse(t, `{"isEnabled":true,"balance":{"amountLeft":"100000000"},"monthlyChargeLimitEnabled":"true","monthlyUsed":{"priceInCents":"4567"}}`))
	if strTrue.MonthlyEnabled || strTrue.MonthlyUsedCents != nil {
		t.Errorf("string true is not on: %+v", strTrue)
	}
	// isEnabled="false" (a string) does not trigger the disabled defense.
	strFalse := ParseExtra(mustParse(t, `{"isEnabled":"false","balance":{"amountLeft":"123456789"}}`))
	if strFalse.State != ExtraReady {
		t.Errorf("string false is not the disabled signal: %+v", strFalse)
	}
}

func TestParseResetTimeBasics(t *testing.T) {
	if ParseResetTime("2030-01-01T00:00:00+08:00") == nil {
		t.Error("RFC3339 with offset must parse")
	}
	if ParseResetTime("2030-01-01 00:00:00 +08:00") == nil {
		t.Error("space-separated with loose offset must parse")
	}
	if ParseResetTime("2030-01-01 00:00:00") == nil {
		t.Error("naive (no offset = local) must parse")
	}
	if ParseResetTime("not a date") != nil {
		t.Error("garbage must not parse")
	}
}

func TestParseResetTimeGoldenLadder(t *testing.T) {
	for _, row := range goldenRows("reset_time") {
		raw, printed := row[0], row[1]
		expected := strings.Trim(printed, `"`)
		if raw == "2030-01-01T00:00:00.5" {
			// chrono's naive patterns carry no %.f, so a fraction without
			// offset fails.
			if got := ParseResetTime(raw); got != nil {
				t.Errorf("reset_time %q: fraction-only naive must be None", raw)
			}
			continue
		}
		if expected == "None" {
			if got := ParseResetTime(raw); got != nil {
				t.Errorf("reset_time %q: got %v, want None", raw,
					FormatDateTimeLocal(*got))
			}
			continue
		}
		got := ParseResetTime(raw)
		if got == nil {
			t.Errorf("reset_time %q: unexpectedly None, want %q", raw, expected)
			continue
		}
		if printedText := SerdePretty(SerDt{Value: *got}); printedText != printed {
			t.Errorf("reset_time %q: printed %s, want %s", raw, printedText, printed)
		}
	}
}

func TestFillMissingFromOnlyFillsThreeFields(t *testing.T) {
	last := ParseQuotaPayload(mustParse(t,
		`{"limits":[{"detail":{"used":"21","limit":"100"}}],"usage":{"used":"18","limit":"100"}}`), atFracs)
	fresh := QuotaResult{FetchedAt: atZero, Error: strPtr("HttpRequestException")}
	FillMissingFrom(&fresh, &last)
	if fresh.FiveHour == nil || fresh.Week == nil || fresh.Extra == nil {
		t.Errorf("data fields must be filled from last: %+v", fresh)
	}
	if fresh.FetchedAt != atZero {
		t.Errorf("fetchedAt stays the failure time: %v", fresh.FetchedAt)
	}
	if fresh.ErrorKind() != "HttpRequestException" {
		t.Errorf("error stays: %q", fresh.ErrorKind())
	}
}

// --test-fetch text equals the Rust oracle byte for byte (PLAN-GO §5.2).
func TestQuotaGoldensByteForByte(t *testing.T) {
	goldenFiles := []string{
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
	}

	payloads := map[string]string{
		"quota-success_full":            `{"limits":[{"detail":{"used":"21","limit":"100","resetTime":"2030-01-01T00:00:00+08:00"}}],"usage":{"used":18.5,"limit":100,"resetTime":"2030-01-08 00:00:00 +08:00"},"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"1234567890"},"monthlyChargeLimitEnabled":true,"monthlyUsed":{"priceInCents":"4567"},"monthlyChargeLimit":{"priceInCents":10000}}}`,
		"quota-mixed_string_number":     `{"limits":[{"detail":{"used":"68","limit":"100","resetTime":"2030-01-01T00:00:00+08:00"}}],"usage":{"used":68,"limit":100}}`,
		"quota-div_zero":                `{"limits":[{"detail":{"used":"50","limit":"0"}}]}`,
		"quota-neg_limit":               `{"limits":[{"detail":{"used":"50","limit":-100}}]}`,
		"quota-hostile_inf":             `{"usage":{"used":"1e999","limit":1}}`,
		"quota-hostile_nan":             `{"usage":{"used":"NaN","limit":1}}`,
		"quota-nan_limit":               `{"usage":{"used":"5","limit":"NaN"}}`,
		"quota-empty":                   `{}`,
		"quota-limits_not_array":        `{"limits":{"detail":{"used":"1","limit":"2"}}}`,
		"quota-detail_string":           `{"limits":[{"detail":"nope"}]}`,
		"quota-usage_null":              `{"usage":null}`,
		"quota-usage_string":            `{"usage":"nope"}`,
		"quota-disabled_wallet":         `{"boosterWallet":{"isEnabled":false,"balance":{"amountLeft":"123456789"}}}`,
		"quota-isenabled_string_false":  `{"boosterWallet":{"isEnabled":"false","balance":{"amountLeft":"123456789"}}}`,
		"quota-isenabled_zero":          `{"boosterWallet":{"isEnabled":0,"balance":{"amountLeft":"1500000"}}}`,
		"quota-no_wallet":               `{"boosterWallet":null}`,
		"quota-wallet_string":           `{"boosterWallet":"nope"}`,
		"quota-amount_frac_number":      `{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":1500000.7}}}`,
		"quota-amount_negative_round":   `{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"-1499999"}}}`,
		"quota-amount_negative_round2":  `{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"-1500001"}}}`,
		"quota-amount_huge":             `{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"9223372036854775807"}}}`,
		"quota-nodata_monthly_on":       `{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"not-a-number"},"monthlyChargeLimitEnabled":true,"monthlyUsed":{"priceInCents":"4567"},"monthlyChargeLimit":{"priceInCents":10000}}}`,
		"quota-monthly_off_but_present": `{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"100000000"},"monthlyUsed":{"priceInCents":"4567"}}}`,
		"quota-monthly_string_true":     `{"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"100000000"},"monthlyChargeLimitEnabled":"true","monthlyUsed":{"priceInCents":"4567"}}}`,
		"quota-reset_fraction":          `{"limits":[{"detail":{"used":"1","limit":"3","resetTime":"2030-01-01T00:00:00.123456789+08:00"}}],"usage":{"used":"1","limit":"3","resetTime":"2030-01-02T00:00:00.500Z"}}`,
	}

	for _, name := range goldenFiles {
		expected := goldenText(name)
		var got string
		switch {
		case strings.HasPrefix(name, "quota-error-"):
			kind := strings.TrimPrefix(name, "quota-error-")
			r := QuotaResult{FetchedAt: atZero, Error: &kind}
			got = SerdePretty(QuotaResultToSerde(&r))
		case name == "quota-fill-missing":
			last := ParseQuotaPayload(mustParse(t, payloads["quota-success_full"]), atFracs)
			fresh := QuotaResult{FetchedAt: atZero, Error: strPtr("HttpRequestException")}
			FillMissingFrom(&fresh, &last)
			got = SerdePretty(QuotaResultToSerde(&fresh))
		default:
			payload, ok := payloads[name]
			if !ok {
				t.Fatalf("no payload registered for golden %s", name)
			}
			r := ParseQuotaPayload(mustParse(t, payload), atFracs)
			got = SerdePretty(QuotaResultToSerde(&r))
		}
		if got != expected {
			t.Errorf("golden %s mismatch:\n got:\n%s\nwant:\n%s", name, got, expected)
		}
	}
}

// ---------------------------------------------------------------------------
// fetchQuota error taxonomy (SPEC 16.4)
// ---------------------------------------------------------------------------

// stubDoer is an HTTPDoer with canned responses.
type stubDoer struct {
	resp  *http.Response
	err   error
	calls int
}

func (s *stubDoer) Do(req *http.Request) (*http.Response, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	return s.resp, nil
}

func okResponse(body string) *http.Response {
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

type timeoutError struct{}

func (timeoutError) Error() string { return "signal timed out" }
func (timeoutError) Timeout() bool { return true }

func TestFetchQuotaNoTokenShortCircuits(t *testing.T) {
	doer := &stubDoer{resp: okResponse("{}")}
	r := FetchQuota(QuotaDeps{Doer: doer, NoToken: true, NowMs: func() int64 { return 1_893_456_000_000 }})
	if doer.calls != 0 {
		t.Error("no token must short-circuit before any request")
	}
	if r.ErrorKind() != "no-token" || r.FiveHour != nil || r.Extra != nil {
		t.Errorf("no-token result = %+v", r)
	}
}

func TestFetchQuotaNon2xxIsHttpRequestException(t *testing.T) {
	doer := &stubDoer{resp: &http.Response{
		StatusCode: 500,
		Body:       io.NopCloser(strings.NewReader("junk")),
	}}
	token := "t"
	r := FetchQuota(QuotaDeps{Doer: doer, Token: &token})
	if r.ErrorKind() != "HttpRequestException" {
		t.Errorf("non-2xx = %q, want HttpRequestException", r.ErrorKind())
	}
}

// M1 review Minor 5: serde's from_slice rejects invalid UTF-8 before the JSON
// grammar runs, so a hostile byte soup is a JsonException, not mojibake.
func TestFetchQuotaInvalidUTF8BodyIsJsonException(t *testing.T) {
	doer := &stubDoer{resp: &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(bytes.NewReader([]byte{'{', '"', 'a', '"', ':', 0xff, 0xfe, '}'})),
	}}
	token := "t"
	r := FetchQuota(QuotaDeps{Doer: doer, Token: &token})
	if r.ErrorKind() != "JsonException" {
		t.Errorf("invalid UTF-8 body = %q, want JsonException", r.ErrorKind())
	}
}

func TestFetchQuotaErrorClassification(t *testing.T) {
	token := "t"
	r := FetchQuota(QuotaDeps{Doer: &stubDoer{err: timeoutError{}}, Token: &token})
	if r.ErrorKind() != "TaskCanceledException" {
		t.Errorf("timeout error = %q", r.ErrorKind())
	}
	r = FetchQuota(QuotaDeps{Doer: &stubDoer{err: errors.New("bad gateway")}, Token: &token})
	if r.ErrorKind() != "HttpRequestException" {
		t.Errorf("other error = %q", r.ErrorKind())
	}
	r = FetchQuota(QuotaDeps{Doer: &stubDoer{resp: okResponse("<html>")}, Token: &token})
	if r.ErrorKind() != "JsonException" {
		t.Errorf("unparseable json = %q", r.ErrorKind())
	}
}

func TestFetchQuotaHeadersAndPayload(t *testing.T) {
	var seenAuth, seenAccept, seenMethod string
	doer := doerFunc(func(req *http.Request) (*http.Response, error) {
		seenAuth = req.Header.Get("Authorization")
		seenAccept = req.Header.Get("Accept")
		seenMethod = req.Method
		return okResponse(`{"limits":[{"detail":{"used":"21","limit":"100"}}],"boosterWallet":{"isEnabled":true,"balance":{"amountLeft":"1000000"}}}`), nil
	})
	token := "abc123"
	r := FetchQuota(QuotaDeps{Doer: doer, Token: &token, NowMs: func() int64 { return 1_893_456_000_000 }})
	if seenMethod != http.MethodGet || seenAuth != "Bearer abc123" || seenAccept != "application/json" {
		t.Errorf("request shape: %s %q %q", seenMethod, seenAuth, seenAccept)
	}
	if r.Error != nil {
		t.Fatalf("success path errored: %q", r.ErrorKind())
	}
	if r.FiveHour == nil || r.FiveHour.Percent != 21 {
		t.Errorf("fiveHour = %+v", r.FiveHour)
	}
	if r.Extra == nil || r.Extra.State != ExtraReady {
		t.Errorf("extra = %+v", r.Extra)
	}
	if r.FetchedAt != atZero {
		t.Errorf("fetchedAt = %+v", r.FetchedAt)
	}
}

type doerFunc func(req *http.Request) (*http.Response, error)

func (f doerFunc) Do(req *http.Request) (*http.Response, error) { return f(req) }

// The whole QuotaResult shape must be what --test-fetch prints.
func TestPublishedShapeIsTestFetchText(t *testing.T) {
	state := NewAppState(DefaultSettings(), "light")
	timer := &fakeTimer{}
	polling := NewPolling(PollingDeps{
		State: state,
		FetchQuota: func() QuotaResult {
			return ParseQuotaPayload(mustParse(t, `{"limits":[{"detail":{"used":"21","limit":"100"}}]}`), atZero)
		},
		Publish:  func(QuotaResult) {},
		SetTimer: timer.setTimer,
	})
	polling.Start()
	if tick := timer.shift(); tick != nil {
		tick.run()
	}
	if state.LastQuota() == nil {
		t.Fatal("no result published")
	}
	text := SerdePretty(QuotaResultToSerde(state.LastQuota()))
	if !strings.Contains(text, `"percent": 21.0`) {
		t.Errorf("--test-fetch shape missing serde float: %s", text)
	}
}
