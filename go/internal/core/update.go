// CLI version check, a port of UpdateService (SPEC section 17):
// local `kimi --version` (5s timeout, kill) -> docs changelog (Range 0-4095)
// -> GitHub Releases API fallback. All failures degrade silently.
package core

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	changelogURL    = "https://moonshotai.github.io/kimi-code/en/release-notes/changelog.md"
	githubLatestURL = "https://api.github.com/repos/MoonshotAI/kimi-code/releases/latest"
	versionTimeout  = 5 * time.Second
)

// UpdateStatus mirrors the serde camelCase shape --test-update prints.
type UpdateStatus struct {
	LocalVersion    *string
	LatestVersion   *string
	UpdateAvailable bool
	CheckFailed     bool
}

// EmptyUpdateStatus is UpdateStatus::default().
func EmptyUpdateStatus() UpdateStatus { return UpdateStatus{} }

// strPtr is a small helper for optional strings.
func strPtr(s string) *string { return &s }

// ParseSemver is `x.y.z` as a comparable triple; anything else (a 4th
// component is ignored, a prerelease suffix is not) yields ok=false. u64
// bounds (SPEC 17.3).
func ParseSemver(value string) ([3]uint64, bool) {
	var out [3]uint64
	parts := strings.Split(value, ".")
	if len(parts) < 3 {
		return out, false
	}
	for i := 0; i < 3; i++ {
		text := strings.TrimPrefix(parts[i], "+") // u64::from_str accepts a leading '+'
		if !isDigits(text) {
			return out, false
		}
		n, err := strconv.ParseUint(text, 10, 64)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func semverGreater(a, b [3]uint64) bool {
	for i := 0; i < 3; i++ {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

var (
	versionRe          = regexp.MustCompile(`[0-9]+\.[0-9]+\.[0-9]+`)
	changelogHeadingRe = regexp.MustCompile(`(?m)^## ([0-9]+\.[0-9]+\.[0-9]+)`)
)

// UpdateDeps carries the injected seams of CheckUpdate; zero values select
// the production behavior.
type UpdateDeps struct {
	Doer         HTTPDoer               // nil -> the shared real client
	SpawnVersion func() (string, error) // nil -> run kimi --version
}

// CheckUpdate composes local detection and the two remote lookups.
func CheckUpdate(deps UpdateDeps) UpdateStatus {
	local := DetectLocalVersion(deps.SpawnVersion)
	doer := deps.Doer
	if doer == nil {
		doer = realHTTPClient
	}
	latest := FetchLatestFromChangelog(doer)
	if latest == nil {
		latest = FetchLatestFromGithub(doer)
	}
	updateAvailable := false
	if latest != nil && local != nil {
		if l, lok := ParseSemver(*latest); lok {
			if c, cok := ParseSemver(*local); cok {
				updateAvailable = semverGreater(l, c)
			}
		}
	}
	status := UpdateStatus{
		UpdateAvailable: updateAvailable,
		CheckFailed:     latest == nil,
	}
	if local != nil {
		status.LocalVersion = local
	}
	if latest != nil {
		status.LatestVersion = latest
	}
	return status
}

// DetectLocalVersion runs `kimi --version` without a shell; stdout and stderr
// are concatenated in that order and decoded lossily, then the first x.y.z
// wins (SPEC 17.1). A spawn failure or a 5 s timeout yields nil.
func DetectLocalVersion(spawn func() (string, error)) *string {
	if spawn == nil {
		spawn = spawnKimiVersion
	}
	output, err := spawn()
	return versionFromOutput(output, err)
}

// versionFromOutput mines the version banner. A non-zero child exit still
// yields the captured output — the Rust oracle's `wait_with_output()` never
// checks the status (rust/src/update.rs:73-80), and `kimi --version` may
// print its version while exiting non-zero (M1 review Major 1).
func versionFromOutput(output string, err error) *string {
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		return nil
	}
	if m := versionRe.FindString(output); m != "" {
		return strPtr(m)
	}
	return nil
}

// spawnKimiVersion mirrors the Rust spawn: piped stdout+stderr, 5 s timeout
// then kill, no shell, CREATE_NO_WINDOW so no console flashes.
func spawnKimiVersion() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), versionTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "kimi", "--version")
	// CREATE_NO_WINDOW (0x08000000), the same flag the Rust edition passes.
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	var stdout, stderr limitBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return "", err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-ctx.Done():
		return "", ctx.Err() // CommandContext has killed the child already
	case err := <-done:
		return LossyDecode(stdout.Bytes()) + LossyDecode(stderr.Bytes()), err
	}
}

// limitBuffer caps captured subprocess output (a chatty `kimi --version`
// must not buffer unbounded); 64 KiB is far past any version banner.
type limitBuffer struct{ b []byte }

func (w *limitBuffer) Write(p []byte) (int, error) {
	const cap64K = 64 << 10
	if len(w.b) < cap64K {
		room := cap64K - len(w.b)
		if len(p) < room {
			room = len(p)
		}
		w.b = append(w.b, p[:room]...)
	}
	return len(p), nil
}

// Bytes exposes the captured bytes.
func (w *limitBuffer) Bytes() []byte { return w.b }

// FetchLatestFromChangelog reads the official docs changelog with a Range
// request keeping the body at 4 KiB; GitHub Pages may ignore Range and return
// 200 with the full body — both are fine. `Accept-Encoding: identity` is the
// cross-edition defense of SPEC §22.4, kept for parity.
func FetchLatestFromChangelog(doer HTTPDoer) *string {
	text, ok := httpGetString(doer, changelogURL, map[string]string{
		"Range":           "bytes=0-4095",
		"Accept-Encoding": "identity",
	})
	if !ok {
		return nil
	}
	if m := changelogHeadingRe.FindStringSubmatch(text); m != nil {
		return strPtr(m[1])
	}
	return nil
}

// FetchLatestFromGithub is the GitHub Releases API fallback; the User-Agent
// header is mandatory.
func FetchLatestFromGithub(doer HTTPDoer) *string {
	text, ok := httpGetString(doer, githubLatestURL, map[string]string{
		"User-Agent": "KimiPlanbarTui",
	})
	if !ok {
		return nil
	}
	root, err := ParseJSONValue(text)
	if err != nil {
		return nil
	}
	tag, ok := JAsStr(JGet(root, "tag_name"))
	if !ok {
		return nil
	}
	if m := versionRe.FindString(tag); m != "" {
		return strPtr(m)
	}
	return nil
}

func httpGetString(doer HTTPDoer, url string, headers map[string]string) (string, bool) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", false
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := doer.Do(req)
	if err != nil {
		return "", false
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		drainClose(resp)
		return "", false
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		return "", false
	}
	// reqwest's .text() decodes UTF-8 lossily; mirror it.
	return LossyDecode(body), true
}

func drainClose(resp *http.Response) {
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}

// DotnetBool is the .NET-style boolean --test-update prints so the editions
// diff (SPEC 19).
func DotnetBool(v bool) string {
	if v {
		return "True"
	}
	return "False"
}
