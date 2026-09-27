// Settings persistence + autostart, a port of SettingsService (SPEC 18).
// TUI edition renames: app-data dir KimiPlanbarTray -> KimiPlanbarTui, HKCU
// Run value likewise. The on-disk file is shared with the Rust edition, so
// the byte shape matters: PascalCase keys, 2-space indent and no trailing
// newline. Go keeps RefreshMinutes as int64 end to end, so the TS clamp rule
// (SPEC 22.3) does not apply — registered as a 22.7 note (PLAN-GO §4.1).
package core

import (
	"fmt"
	"os"
	"path/filepath"
)

// SettingsData mirrors the shared settings.json schema.
type SettingsData struct {
	Theme          string // system | light | dark
	RefreshMinutes int64  // 1 | 5 | 10 | 30
	AutoStart      bool
}

// DefaultSettings tolerates a partial settings.json: missing fields take
// these defaults (`#[serde(default)]`).
func DefaultSettings() SettingsData {
	return SettingsData{Theme: "system", RefreshMinutes: 5, AutoStart: false}
}

// CurrentExe is `std::env::current_exe()`. Unlike the TS `process.execPath`
// there is no "development mode points at the runtime" ambiguity: `go run`
// and `go build` both resolve to a real exe (PLAN-GO §4.2).
func CurrentExe() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return exe
}

// ConfigDir: a `portable.dat` next to the exe pins the config dir to the exe
// directory; otherwise %APPDATA%\KimiPlanbarTui (SPEC 18.1).
func ConfigDir(exe string, env Env) string {
	exeDir := filepath.Dir(exe)
	if exe != "" {
		if _, err := os.Stat(filepath.Join(exeDir, "portable.dat")); err == nil {
			return exeDir
		}
	}
	if appdata, ok := env.get("APPDATA"); ok && appdata != "" {
		return filepath.Join(appdata, "KimiPlanbarTui")
	}
	return exeDir
}

func settingsPath(dir string) string { return filepath.Join(dir, "settings.json") }

// ParseSettingsJson: serde's `#[serde(default)]` plus a whole-document
// failure — a type mismatch on any single key discards all three values,
// while a missing key alone falls back to that key's default.
func ParseSettingsJson(text string) SettingsData {
	fallback := DefaultSettings()
	root, err := ParseJSONValue(text)
	if err != nil {
		return fallback
	}
	if root.Kind != JObj {
		return fallback
	}

	theme := fallback.Theme
	if themeNode := JGet(root, "Theme"); themeNode != nil {
		value, ok := JAsStr(themeNode)
		if !ok {
			return fallback
		}
		theme = value
	}
	refreshMinutes := fallback.RefreshMinutes
	if refreshNode := JGet(root, "RefreshMinutes"); refreshNode != nil {
		// serde accepts only an integer-formatted number here: `5.0` and
		// `"5"` are type errors, exactly like the i64 golden matrix.
		value, ok := JAsI64(refreshNode)
		if !ok {
			return fallback
		}
		refreshMinutes = value
	}
	autoStart := fallback.AutoStart
	if autoStartNode := JGet(root, "AutoStart"); autoStartNode != nil {
		value, ok := JAsBool(autoStartNode)
		if !ok {
			return fallback
		}
		autoStart = value
	}
	return SettingsData{Theme: theme, RefreshMinutes: refreshMinutes, AutoStart: autoStart}
}

// SettingsToSerde is the PascalCase serde shape of SettingsData.
func SettingsToSerde(data SettingsData) SerNode {
	return SerObj{Pairs: []SerPair{
		{Key: "Theme", Val: SerStr{Value: data.Theme}},
		{Key: "RefreshMinutes", Val: SerI64{Value: data.RefreshMinutes}},
		{Key: "AutoStart", Val: SerBool{Value: data.AutoStart}},
	}}
}

// SettingsToJSONText is the exact bytes Rust's `to_string_pretty` writes: no
// trailing newline.
func SettingsToJSONText(data SettingsData) string {
	return SerdePretty(SettingsToSerde(data))
}

// LoadSettings reads settings.json; a missing or broken file yields defaults.
func LoadSettings(dir string) SettingsData {
	text, ok := ReadTextStrict(settingsPath(dir))
	if !ok {
		return DefaultSettings()
	}
	return ParseSettingsJson(text)
}

// SaveSettings writes settings.json atomically — a temp file in the same
// directory, then rename over the target (SPEC 18.2) — so a crash mid-write
// can never leave a truncated settings.json behind (a truncated file would
// silently fall back to all defaults on the next load). Reports success: on
// a write failure the UI keeps the draft open and skips the follow-up steps
// (SPEC 13.2); all IO errors themselves remain silently swallowed (SPEC 20).
func SaveSettings(data SettingsData, dir string) bool {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false
	}
	// PID-suffixed like the Rust oracle and both TS editions: there is no
	// single-instance mutex (SPEC 20), and a fixed name would make two
	// concurrent SaveSettings calls race — one rename failing on the other's
	// open handle (sharing violation -> false "Save failed") or, worse, one
	// instance renaming the other's draft into place.
	tmp := filepath.Join(dir, fmt.Sprintf("settings.json.%d.tmp", os.Getpid()))
	if err := os.WriteFile(tmp, []byte(SettingsToJSONText(data)), 0o644); err != nil {
		// REVIEW-RUST Suggestion 13: the failed write may leave a half-made
		// tmp behind — clean it up with the same best-effort remove as the
		// rename-failure path (SPEC 18.2).
		_ = os.Remove(tmp)
		return false
	}
	if err := os.Rename(tmp, settingsPath(dir)); err != nil {
		_ = os.Remove(tmp) // best-effort cleanup, keep the dir tidy
		return false
	}
	return true
}
