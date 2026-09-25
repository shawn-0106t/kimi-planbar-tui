package core

import (
	"io"
	"net/http"
	"os/exec"
	"strings"
	"testing"
)

func TestParseSemver(t *testing.T) {
	if v, ok := ParseSemver("2.0.1"); !ok || v != [3]uint64{2, 0, 1} {
		t.Errorf("2.0.1 = %v %v", v, ok)
	}
	if v, ok := ParseSemver("01.0.0"); !ok || v != [3]uint64{1, 0, 0} {
		t.Errorf("01.0.0 = %v %v", v, ok)
	}
	if v, ok := ParseSemver("+2.0.1"); !ok || v != [3]uint64{2, 0, 1} {
		t.Error("u64::from_str takes a leading '+'")
	}
	if _, ok := ParseSemver("2.0.1-rc1"); ok {
		t.Error("prerelease suffix must not parse")
	}
	if _, ok := ParseSemver("2.0"); ok {
		t.Error("two components must not parse")
	}
	if v, ok := ParseSemver("2.0.1.4"); !ok || v != [3]uint64{2, 0, 1} {
		t.Error("extra parts are ignored")
	}
	if _, ok := ParseSemver(""); ok {
		t.Error("empty must not parse")
	}
	if _, ok := ParseSemver("18446744073709551616.0.0"); ok {
		t.Error("u64 overflow must not parse")
	}
	a, _ := ParseSemver("1.10.0")
	b, _ := ParseSemver("1.9.9")
	if a[1] <= b[1] {
		t.Error("comparison is numeric, not lexical")
	}
}

type stubUpdateDoer struct {
	body string
	code int
	err  error
	reqs []*http.Request
}

func (s *stubUpdateDoer) Do(req *http.Request) (*http.Response, error) {
	s.reqs = append(s.reqs, req)
	if s.err != nil {
		return nil, s.err
	}
	return &http.Response{
		StatusCode: s.code,
		Body:       io.NopCloser(strings.NewReader(s.body)),
	}, nil
}

func TestFetchLatestFromChangelog(t *testing.T) {
	doer := &stubUpdateDoer{body: "## 2.0.2\n", code: 200}
	if got := FetchLatestFromChangelog(doer); got == nil || *got != "2.0.2" {
		t.Errorf("changelog heading = %v", got)
	}
	if len(doer.reqs) != 1 || doer.reqs[0].Header.Get("Range") != "bytes=0-4095" ||
		doer.reqs[0].Header.Get("Accept-Encoding") != "identity" {
		t.Errorf("Range request headers: %+v", doer.reqs)
	}

	doer = &stubUpdateDoer{body: "# Changelog\n\n## 2.0.3\n\n## 2.0.1\n", code: 200}
	if got := FetchLatestFromChangelog(doer); got == nil || *got != "2.0.3" {
		t.Errorf("the first heading wins: %v", got)
	}

	// No heading, a non-2xx, and a throw all fall through.
	if got := FetchLatestFromChangelog(&stubUpdateDoer{body: "nothing", code: 200}); got != nil {
		t.Errorf("no heading = %v", got)
	}
	if got := FetchLatestFromChangelog(&stubUpdateDoer{body: "x", code: 404}); got != nil {
		t.Errorf("404 = %v", got)
	}
	if got := FetchLatestFromChangelog(&stubUpdateDoer{err: errStub{}}); got != nil {
		t.Errorf("throw = %v", got)
	}
}

type errStub struct{}

func (errStub) Error() string { return "tls" }

func TestFetchLatestFromGithub(t *testing.T) {
	doer := &stubUpdateDoer{body: `{"tag_name":"@moonshot-ai/kimi-code@0.31.1"}`, code: 200}
	if got := FetchLatestFromGithub(doer); got == nil || *got != "0.31.1" {
		t.Errorf("tag mining = %v", got)
	}
	if len(doer.reqs) != 1 || doer.reqs[0].Header.Get("User-Agent") != "KimiPlanbarTui" {
		t.Errorf("mandatory User-Agent: %+v", doer.reqs)
	}
	if got := FetchLatestFromGithub(&stubUpdateDoer{body: "{}", code: 200}); got != nil {
		t.Errorf("missing tag_name = %v", got)
	}
	if got := FetchLatestFromGithub(&stubUpdateDoer{body: "<html>", code: 200}); got != nil {
		t.Errorf("broken json = %v", got)
	}
}

func TestDetectLocalVersion(t *testing.T) {
	if got := DetectLocalVersion(func() (string, error) {
		return "noise 1.2.3 and 4.5.6\n", nil
	}); got == nil || *got != "1.2.3" {
		t.Errorf("the first x.y.z in stdout+stderr wins, got %v", got)
	}
	if got := DetectLocalVersion(func() (string, error) {
		return "no version", nil
	}); got != nil {
		t.Errorf("no version = %v", got)
	}
	if got := DetectLocalVersion(func() (string, error) {
		return "", errStub{}
	}); got != nil {
		t.Errorf("spawn failure = %v", got)
	}

	// M1 review Major 1: a non-zero child exit must not discard the captured
	// output — the Rust oracle's wait_with_output never checks the status.
	if got := versionFromOutput("2.1.1\n", &exec.ExitError{}); got == nil || *got != "2.1.1" {
		t.Errorf("non-zero exit still mines the banner, got %v", got)
	}
	if got := versionFromOutput("", &exec.ExitError{}); got != nil {
		t.Errorf("no banner with non-zero exit = %v", got)
	}
	if got := versionFromOutput("", errStub{}); got != nil {
		t.Errorf("real spawn failure = %v", got)
	}

	// PATH smoke: the real kimi --version yields nil or an x.y.z triple.
	if got := DetectLocalVersion(nil); got != nil && !isXyz(*got) {
		t.Errorf("real spawn = %q", *got)
	}
}

func isXyz(s string) bool {
	if len(s) == 0 {
		return false
	}
	for _, part := range strings.Split(s, ".") {
		if part == "" {
			return false
		}
		for i := 0; i < len(part); i++ {
			if part[i] < '0' || part[i] > '9' {
				return false
			}
		}
	}
	return strings.Count(s, ".") == 2
}

func TestCheckUpdateComposition(t *testing.T) {
	doer := &stubUpdateDoer{body: "## 2.1.0\n", code: 200}
	status := CheckUpdate(UpdateDeps{
		Doer: doer,
		SpawnVersion: func() (string, error) {
			return "2.0.9\n", nil
		},
	})
	if status.LocalVersion == nil || *status.LocalVersion != "2.0.9" ||
		status.LatestVersion == nil || *status.LatestVersion != "2.1.0" ||
		!status.UpdateAvailable || status.CheckFailed {
		t.Errorf("composition = %+v", status)
	}

	// The changelog is tried before the GitHub API.
	var seen []string
	seq := &seqDoer{onRequest: func(r *http.Request) (*http.Response, error) {
		seen = append(seen, r.URL.String())
		if strings.Contains(r.URL.String(), "api.github.com") {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"tag_name":"v9.9.9"}`))}, nil
		}
		return &http.Response{StatusCode: 500, Body: io.NopCloser(strings.NewReader("gone"))}, nil
	}}
	status = CheckUpdate(UpdateDeps{
		Doer:         seq,
		SpawnVersion: func() (string, error) { return "1.0.0\n", nil },
	})
	if len(seen) != 2 {
		t.Errorf("both remotes are tried: %v", seen)
	}
	if status.LatestVersion == nil || *status.LatestVersion != "9.9.9" || !status.UpdateAvailable {
		t.Errorf("github fallback = %+v", status)
	}

	// Both paths failing sets checkFailed and stays silent otherwise.
	status = CheckUpdate(UpdateDeps{
		Doer:         &stubUpdateDoer{err: errStub{}},
		SpawnVersion: func() (string, error) { return "3.0.0\n", nil },
	})
	if status.LocalVersion == nil || *status.LocalVersion != "3.0.0" ||
		status.LatestVersion != nil || status.UpdateAvailable || !status.CheckFailed {
		t.Errorf("all-failed = %+v", status)
	}
}

type seqDoer struct {
	onRequest func(*http.Request) (*http.Response, error)
}

func (s *seqDoer) Do(r *http.Request) (*http.Response, error) { return s.onRequest(r) }

func TestDotnetBool(t *testing.T) {
	if DotnetBool(true) != "True" || DotnetBool(false) != "False" {
		t.Error("True/False capitalization matches the WPF reference output")
	}
}
