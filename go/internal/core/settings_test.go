package core

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSettingsJSONTextMatchesOracle(t *testing.T) {
	if got, want := SettingsToJSONText(DefaultSettings()), goldenText("settings-default"); got != want {
		t.Errorf("default document:\n got %q\nwant %q", got, want)
	}
}

func TestSettingsPascalCaseNoTrailingNewline(t *testing.T) {
	text := SettingsToJSONText(SettingsData{Theme: "dark", RefreshMinutes: 30, AutoStart: true})
	want := "{\n  \"Theme\": \"dark\",\n  \"RefreshMinutes\": 30,\n  \"AutoStart\": true\n}"
	if text != want {
		t.Errorf("settings text = %q, want %q", text, want)
	}
	if strings.HasSuffix(text, "\n") {
		t.Error("settings text must not carry a trailing newline")
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	data := SettingsData{Theme: "light", RefreshMinutes: 10, AutoStart: true}
	got := ParseSettingsJson(SettingsToJSONText(data))
	if got != data {
		t.Errorf("round trip = %+v, want %+v", got, data)
	}
}

func TestParseSettingsMissingKeyTakesDefault(t *testing.T) {
	got := ParseSettingsJson(`{"Theme":"dark"}`)
	want := SettingsData{Theme: "dark", RefreshMinutes: 5, AutoStart: false}
	if got != want {
		t.Errorf("missing-key default = %+v, want %+v", got, want)
	}
}

func TestParseSettingsTypeMismatchDiscardsWholeFile(t *testing.T) {
	fallback := DefaultSettings()
	for _, body := range []string{
		`{"Theme":5,"RefreshMinutes":5,"AutoStart":false}`,
		`{"Theme":"system","RefreshMinutes":"5","AutoStart":false}`,
		`{"Theme":"system","RefreshMinutes":5.0,"AutoStart":false}`,
		`{"Theme":"system","RefreshMinutes":5,"AutoStart":"true"}`,
		`{"Theme":null}`,
		`{"Theme":"system"} junk`,
		`not json`,
		`[]`,
	} {
		if got := ParseSettingsJson(body); got != fallback {
			t.Errorf("type mismatch %s must discard the file, got %+v", body, got)
		}
	}
}

func TestParseSettingsI64Bounds(t *testing.T) {
	// Beyond i64 is a type error -> whole-file default.
	if got := ParseSettingsJson(`{"RefreshMinutes":9223372036854775808}`); got != DefaultSettings() {
		t.Errorf("i64 overflow must fall back, got %+v", got)
	}
	if got := ParseSettingsJson(`{"RefreshMinutes":-9223372036854775809}`); got != DefaultSettings() {
		t.Errorf("i64 underflow must fall back, got %+v", got)
	}
	// Unlike the TS edition there is no 2^53 clamp: int64 is exact end to end
	// (PLAN-GO §4.1, a SPEC 22.7 note).
	if got := ParseSettingsJson(`{"RefreshMinutes":9223372036854775807}`); got.RefreshMinutes != math.MaxInt64 {
		t.Errorf("i64::MAX must be kept exactly, got %d", got.RefreshMinutes)
	}
	if got := ParseSettingsJson(`{"RefreshMinutes":-9223372036854775808}`); got.RefreshMinutes != math.MinInt64 {
		t.Errorf("i64::MIN must be kept exactly, got %d", got.RefreshMinutes)
	}
}

func TestParseSettingsUnknownKeysAndDuplicates(t *testing.T) {
	if got := ParseSettingsJson(`{"Theme":"dark","Future":"x"}`); got.Theme != "dark" {
		t.Errorf("unknown keys must be ignored, got %+v", got)
	}
	if got := ParseSettingsJson(`{"Theme":"dark","Theme":"light"}`); got.Theme != "light" {
		t.Errorf("duplicate keys keep the last, got %+v", got)
	}
	if got := ParseSettingsJson(`{}`); got != DefaultSettings() {
		t.Errorf("empty document takes all defaults, got %+v", got)
	}
}

func TestConfigDirPortableDat(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "kpt-tui-go.exe")
	if err := os.WriteFile(filepath.Join(dir, "portable.dat"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := ConfigDir(exe, Env{"APPDATA": "C:/roaming"}); got != dir {
		t.Errorf("portable.dat must pin the config dir, got %q", got)
	}
	if err := os.Remove(filepath.Join(dir, "portable.dat")); err != nil {
		t.Fatal(err)
	}
	if got := ConfigDir(exe, Env{"APPDATA": "C:/roaming"}); got != filepath.Join("C:/roaming", "KimiPlanbarTui") {
		t.Errorf("without portable.dat APPDATA applies, got %q", got)
	}
	if got := ConfigDir(exe, Env{"APPDATA": ""}); got != dir {
		t.Errorf("empty APPDATA falls back to the exe dir, got %q", got)
	}
	if got := ConfigDir(exe, Env{}); got != dir {
		t.Errorf("missing APPDATA falls back to the exe dir, got %q", got)
	}
}

func TestSettingsReadWriteRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if got := LoadSettings(dir); got != DefaultSettings() {
		t.Errorf("missing file yields defaults, got %+v", got)
	}
	data := SettingsData{Theme: "dark", RefreshMinutes: 1, AutoStart: false}
	SaveSettings(data, dir)
	if got := LoadSettings(dir); got != data {
		t.Errorf("save+load = %+v, want %+v", got, data)
	}
	b, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != SettingsToJSONText(data) {
		t.Errorf("on-disk bytes diverge from SettingsToJSONText")
	}
}

func TestSaveRepairsCorruptFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte("{oops"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := LoadSettings(dir); got != DefaultSettings() {
		t.Errorf("corrupt file yields defaults, got %+v", got)
	}
	SaveSettings(SettingsData{Theme: "system", RefreshMinutes: 30, AutoStart: false}, dir)
	if got := LoadSettings(dir); got.RefreshMinutes != 30 {
		t.Errorf("save must repair, got %+v", got)
	}
}

func TestRealMachineSettingsByteStable(t *testing.T) {
	// The file the Rust edition wrote on this machine is still parseable and
	// byte-stable: rewriting what we loaded must produce the same bytes, or
	// the editions would leave different files behind.
	dir := ConfigDir(CurrentExe(), nil)
	b, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Skip("no settings.json on this machine")
	}
	data := ParseSettingsJson(string(b))
	if SettingsToJSONText(data) != string(b) {
		t.Errorf("settings.json is not byte-stable under our writer:\n got %q\nwant %q",
			SettingsToJSONText(data), string(b))
	}
}
