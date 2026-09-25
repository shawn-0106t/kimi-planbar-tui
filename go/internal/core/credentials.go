// Credential chain, a 1:1 port of QuotaService.LoadToken (SPEC 16.2):
//  1. <kimi_home>/credentials/kimi-code.json -> access_token (expires_at > now+30s)
//  2. <kimi_home>/config.toml -> provider whose base_url contains api.kimi.com/coding
//  3. nothing -> the caller reports "no-token"
//
// <kimi_home> honors the KIMI_CODE_HOME override. The token is only ever read
// here and sent to the usages endpoint (SPEC 6).
package core

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/windows/registry"
)

// ReadTextStrict mirrors `fs::read_to_string`, which also fails on invalid
// UTF-8 — so a damaged file means "no data" rather than mojibake that the
// parser would then chew on.
func ReadTextStrict(path string) (string, bool) {
	b, err := os.ReadFile(path)
	if err != nil || !utf8.Valid(b) {
		return "", false
	}
	return string(b), true
}

// Env is the process-environment abstraction the ported tests drive; nil
// means the real process environment.
type Env map[string]string

// OSEnv is the production Env: the real process environment (the nil-map
// read path, made explicit at call sites).
func OSEnv() Env { return nil }

func (e Env) get(key string) (string, bool) {
	if e == nil {
		return os.LookupEnv(key)
	}
	v, ok := e[key]
	return v, ok
}

// HomeDir is the Rust `std::env::home_dir` shape used by the tray and TUI
// editions: USERPROFILE first, HOMEDRIVE+HOMEPATH as the fallback.
func HomeDir(env Env) (string, bool) {
	if profile, ok := env.get("USERPROFILE"); ok && profile != "" {
		return profile, true
	}
	drive, dOK := env.get("HOMEDRIVE")
	path, pOK := env.get("HOMEPATH")
	if dOK && pOK {
		return drive + path, true
	}
	return "", false
}

// KimiHome is `~/.kimi-code` with the `KIMI_CODE_HOME` override
// (SPEC 16.2 / 21.2).
func KimiHome(home string, env Env) string {
	if override, ok := env.get("KIMI_CODE_HOME"); ok && override != "" {
		return override
	}
	return filepath.Join(home, ".kimi-code")
}

// asF64 is JSON number-or-string -> f64 (the server models numbers as
// strings); anything else reads as absent.
func asF64(node *JValue) (float64, bool) {
	switch {
	case node == nil:
		return 0, false
	case node.Kind == JNum:
		return node.Num, true
	case node.Kind == JStr:
		return ParseF64Strict(RustTrim(node.Str))
	default:
		return 0, false
	}
}

func tokenFromCredentials(kimiDir string, nowSec int64) (string, bool) {
	text, ok := ReadTextStrict(filepath.Join(kimiDir, "credentials", "kimi-code.json"))
	if !ok {
		return "", false
	}
	root, err := ParseJSONValue(text)
	if err != nil {
		return "", false // a parse error is silently swallowed, as in Rust
	}
	if root.Kind != JObj {
		return "", false
	}
	accessToken, ok := JAsStr(JGet(root, "access_token"))
	if !ok {
		return "", false
	}
	exp, ok := asF64(JGet(root, "expires_at"))
	if !ok {
		exp = 0.0 // a missing expiry reads as expired
	}
	if exp > float64(nowSec)+30.0 {
		return accessToken, true
	}
	return "", false
}

func matchProvider(section, baseUrl, apiKey string, haveSection, haveBase, haveKey bool) (string, bool) {
	if !haveSection || !haveBase || !haveKey {
		return "", false
	}
	if !strings.HasPrefix(section, "providers.") {
		return "", false
	}
	if !strings.Contains(baseUrl, "api.kimi.com/coding") {
		return "", false
	}
	if apiKey == "" {
		return "", false
	}
	return apiKey, true
}

// tomlKV is the hand-rolled line grammar behind SPEC 16.2 step 2 (no TOML
// crate): `key<ws>=<ws>"value"` where <ws> is Rust's whitespace set.
var tomlKV = regexp.MustCompile(`^(base_url|api_key)[\t\n\x0b\x0c\r \x{0085}\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}]*=[\t\n\x0b\x0c\r \x{0085}\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}]*"([^"]*)"`)

// TokenFromConfigToml is the line parser behind the fallback: the previous
// section is settled when a new one opens and once more at EOF.
func TokenFromConfigToml(text string) (string, bool) {
	section, baseUrl, apiKey := "", "", ""
	haveSection, haveBase, haveKey := false, false, false
	for _, raw := range RustLines(text) {
		line := RustTrim(raw)
		if strings.HasPrefix(line, "[") {
			if found, ok := matchProvider(section, baseUrl, apiKey, haveSection, haveBase, haveKey); ok {
				return found, true
			}
			section = RustTrimMatchesAny(line, []string{"[", "]"})
			haveSection = true
			baseUrl, apiKey = "", ""
			haveBase, haveKey = false, false
			continue
		}
		m := tomlKV.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		if m[1] == "base_url" {
			baseUrl = m[2]
			haveBase = true
		} else {
			apiKey = m[2]
			haveKey = true
		}
	}
	return matchProvider(section, baseUrl, apiKey, haveSection, haveBase, haveKey)
}

// LoadTokenFrom is the testable half of the chain: everything except the
// home-dir lookup.
func LoadTokenFrom(kimiDir string, nowSec int64) (string, bool) {
	if token, ok := tokenFromCredentials(kimiDir, nowSec); ok {
		return token, true
	}
	text, ok := ReadTextStrict(filepath.Join(kimiDir, "config.toml"))
	if !ok {
		return "", false
	}
	return TokenFromConfigToml(text)
}

// LoadToken resolves the full chain against the given environment (nil = the
// real process environment) and the current clock.
func LoadToken(env Env) (string, bool) {
	home, ok := HomeDir(env)
	if !ok {
		return "", false
	}
	return LoadTokenFrom(KimiHome(home, env), time.Now().Unix())
}

// registryRunKeyPath is the HKCU Run key for per-user autostart (SPEC 18.3).
const registryRunKeyPath = `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`

const runValueName = "KimiPlanbarTui"

// autoStartValue is the exact string shape Rust writes (a quoted exe path).
func autoStartValue(exe string) string { return `"` + exe + `"` }

// ApplyAutoStart writes or deletes the HKCU Run value through the registry
// API directly (PLAN-GO §4.2: no reg.exe subprocess). All errors are
// silently swallowed (SPEC 20).
func ApplyAutoStart(autoStart bool, exe string) {
	key, err := registry.OpenKey(registry.CURRENT_USER, registryRunKeyPath, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer key.Close()
	if autoStart {
		_ = key.SetStringValue(runValueName, autoStartValue(exe))
	} else {
		_ = key.DeleteValue(runValueName)
	}
}
