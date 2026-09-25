package core

import (
	"os"
	"path/filepath"
	"testing"
)

const credNow = int64(1_800_000_000) // epoch seconds, fixed

func credFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func writeCredential(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "credentials"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "credentials", "kimi-code.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeConfig(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestHomeDirChain(t *testing.T) {
	if got, ok := HomeDir(Env{"USERPROFILE": "C:/u", "HOMEDRIVE": "C:", "HOMEPATH": "/w"}); !ok || got != "C:/u" {
		t.Errorf("USERPROFILE must win: %q %v", got, ok)
	}
	if got, ok := HomeDir(Env{"USERPROFILE": "", "HOMEDRIVE": "C:", "HOMEPATH": `\Users\x`}); !ok || got != "C:"+`\Users\x` {
		t.Errorf("empty USERPROFILE falls through: %q %v", got, ok)
	}
	if _, ok := HomeDir(Env{}); ok {
		t.Error("neither variable set must yield nothing")
	}
	if got := KimiHome("C:/u", Env{"KIMI_CODE_HOME": "D:/kc"}); got != "D:/kc" {
		t.Errorf("override must apply: %q", got)
	}
	want := filepath.Join("C:/u", ".kimi-code")
	if got := KimiHome("C:/u", Env{"KIMI_CODE_HOME": ""}); got != want {
		t.Errorf("empty override must fall through: %q", got)
	}
	if got := KimiHome("C:/u", Env{}); got != want {
		t.Errorf("no override: %q", got)
	}
}

func TestCredentialsJSON(t *testing.T) {
	dir := credFixture(t)

	writeCredential(t, dir, `{"access_token":"tok","expires_at":1800003600}`)
	if got, ok := LoadTokenFrom(dir, credNow); !ok || got != "tok" {
		t.Errorf("live token must be returned, got %q %v", got, ok)
	}

	writeCredential(t, dir, `{"access_token":"tok","expires_at":1800000030}`)
	if _, ok := LoadTokenFrom(dir, credNow); ok {
		t.Error("expiry needs strictly more than 30 s of headroom")
	}
	writeCredential(t, dir, `{"access_token":"tok","expires_at":1800000031}`)
	if got, ok := LoadTokenFrom(dir, credNow); !ok || got != "tok" {
		t.Error("31 s of headroom must pass")
	}

	// expires_at may be a string; junk or a missing one reads as expired.
	writeCredential(t, dir, `{"access_token":"tok","expires_at":"1800003600"}`)
	if got, ok := LoadTokenFrom(dir, credNow); !ok || got != "tok" {
		t.Error("string expires_at must parse")
	}
	for _, body := range []string{
		`{"access_token":"tok"}`,
		`{"access_token":"tok","expires_at":null}`,
		`{"access_token":"tok","expires_at":"soon"}`,
	} {
		writeCredential(t, dir, body)
		if _, ok := LoadTokenFrom(dir, credNow); ok {
			t.Errorf("junk/missing expiry must read as expired: %s", body)
		}
	}

	// A non-string access_token is ignored; an empty one is not.
	writeCredential(t, dir, `{"access_token":42,"expires_at":1800003600}`)
	if _, ok := LoadTokenFrom(dir, credNow); ok {
		t.Error("non-string access_token must be ignored")
	}
	writeCredential(t, dir, `{"access_token":"","expires_at":1800003600}`)
	if got, ok := LoadTokenFrom(dir, credNow); !ok || got != "" {
		t.Error("empty access_token must pass through")
	}

	writeCredential(t, dir, "{ not json")
	if _, ok := LoadTokenFrom(dir, credNow); ok {
		t.Error("broken json must be swallowed")
	}
}

func TestTokenFromConfigToml(t *testing.T) {
	provider := func(name, baseUrl, key string) string {
		return `[providers.` + name + `]` + "\n" +
			`base_url = "` + baseUrl + `"` + "\n" +
			`api_key = "` + key + `"` + "\n"
	}

	if got, ok := TokenFromConfigToml(provider("kimi", "https://api.kimi.com/coding/v1", "kk")); !ok || got != "kk" {
		t.Errorf("a matching provider must answer, got %q %v", got, ok)
	}

	// A kimi-shaped base_url under a non-provider section must not match;
	// a provider section whose key is empty must not match either.
	if _, ok := TokenFromConfigToml("[services.moonshot_search]\n" + `base_url = "https://api.kimi.com/coding/v1/search"` + "\n" + `api_key = "kk"` + "\n"); ok {
		t.Error("non-provider section must not match")
	}
	if _, ok := TokenFromConfigToml(provider("kimi", "https://example.com/v1", "kk")); ok {
		t.Error("foreign base_url must not match")
	}
	if _, ok := TokenFromConfigToml(provider("kimi", "https://api.kimi.com/coding/v1", "")); ok {
		t.Error("empty api_key must not match")
	}

	// The first match wins; later sections are not scanned.
	text := provider("a", "https://api.kimi.com/coding", "first") +
		provider("b", "https://api.kimi.com/coding", "second")
	if got, _ := TokenFromConfigToml(text); got != "first" {
		t.Errorf("first match must win, got %q", got)
	}

	// A section is settled when the next one opens, and again at EOF.
	twoProviders := "# comment\n" +
		provider("deep", "https://api.deepseek.com", "d-key") + "\n" +
		provider("kimi", "https://api.kimi.com/coding/v1", "k-key")
	if got, _ := TokenFromConfigToml(twoProviders); got != "k-key" {
		t.Errorf("EOF settlement: %q", got)
	}
	kimiFirst := replaceAll(twoProviders, "api.deepseek.com", "api.kimi.com/coding/x")
	if got, _ := TokenFromConfigToml(kimiFirst); got != "d-key" {
		t.Errorf("section settlement on open: %q", got)
	}

	// Quoted subsection names keep their brackets stripped.
	if got, _ := TokenFromConfigToml(`[providers."managed:kimi-code"]` + "\n" + `base_url = "https://api.kimi.com/coding/v1"` + "\n" + `api_key = "mk"` + "\n"); got != "mk" {
		t.Errorf("quoted subsection: %q", got)
	}
	if got, _ := TokenFromConfigToml("[[providers.kimi]]\n" + `base_url="https://api.kimi.com/coding"` + "\n" + `api_key = "at"` + "\n"); got != "at" {
		t.Errorf("array table: %q", got)
	}

	// Within a section the last base_url and api_key win.
	if got, _ := TokenFromConfigToml("[providers.k]\n" +
		`base_url = "https://nope.example"` + "\n" +
		`base_url = "https://api.kimi.com/coding"` + "\n" +
		`api_key = "one"` + "\n" +
		`api_key = "two"` + "\n"); got != "two" {
		t.Errorf("last key wins: %q", got)
	}

	// Keys before any section never match; single-quoted values are skipped.
	if _, ok := TokenFromConfigToml(`base_url = "https://api.kimi.com/coding"` + "\n" + `api_key = "x"` + "\n"); ok {
		t.Error("keys before a section must not match")
	}
	if _, ok := TokenFromConfigToml("[providers.k]\n" + `base_url = 'https://api.kimi.com/coding'` + "\n" + `api_key = "x"` + "\n"); ok {
		t.Error("single-quoted values must be skipped")
	}
}

// replaceAll avoids strings.ReplaceAll import noise in the assertions above.
func replaceAll(s, old, new string) string {
	out := ""
	for {
		i := indexOfStr(s, old)
		if i < 0 {
			return out + s
		}
		out += s[:i] + new
		s = s[i+len(old):]
	}
}

func indexOfStr(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestFallbackOnlyWhenCredentialStoreCannotAnswer(t *testing.T) {
	dir := credFixture(t)
	writeCredential(t, dir, `{"access_token":"tok","expires_at":1}`) // expired
	writeConfig(t, dir, "[providers.kimi]\n"+`base_url = "https://api.kimi.com/coding/v1"`+"\n"+`api_key = "fallback"`+"\n")
	if got, ok := LoadTokenFrom(dir, credNow); !ok || got != "fallback" {
		t.Errorf("fallback must run, got %q %v", got, ok)
	}

	empty := credFixture(t)
	if _, ok := LoadTokenFrom(empty, credNow); ok {
		t.Error("no files must yield nothing")
	}
}

func TestLoadTokenRealMachine(t *testing.T) {
	// Not an assertion about the user's data: whatever comes back must be a
	// string or nothing, and it must not throw.
	token, ok := LoadToken(nil)
	if ok && token == "" {
		t.Error("ok with an empty token is inconsistent")
	}
}

func TestReadTextStrict(t *testing.T) {
	dir := credFixture(t)
	bad := filepath.Join(dir, "bad.toml")
	if err := os.WriteFile(bad, []byte{0xff, 0xfe, 0x41}, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := ReadTextStrict(bad); ok {
		t.Error("invalid UTF-8 must be a read failure, not mojibake")
	}
	good := filepath.Join(dir, "ok.toml")
	if err := os.WriteFile(good, []byte("plain"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, ok := ReadTextStrict(good); !ok || got != "plain" {
		t.Errorf("plain read = %q %v", got, ok)
	}
	if _, ok := ReadTextStrict(filepath.Join(dir, "missing.toml")); ok {
		t.Error("missing file must fail")
	}
}

func TestAutoStartValueShape(t *testing.T) {
	if got := autoStartValue(`C:\a b\k.exe`); got != `"C:\a b\k.exe"` {
		t.Errorf("autoStartValue = %q", got)
	}
}
