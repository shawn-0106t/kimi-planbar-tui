// Theme support: system theme detection + the Moonlit/Moondark palettes, a
// port of rust/src/theme.rs. SPEC 11.1 lists ten brushes; the wireframe UI
// draws no card backgrounds, so the palette carries the nine that are
// actually used (card_bg stays spec-only, matching the Rust struct).
//
// System theme follow (SPEC 20): crossterm/bubbletea has no system-event
// source either, so the app polls HKCU AppsUseLightTheme every 30s and only
// re-applies when the configured theme is "system". Unlike the TS editions,
// the read is a direct registry API call (PLAN-GO §4.2) — no reg.exe, no GBK
// decode, synchronous and effectively free.
package core

import (
	"golang.org/x/sys/windows/registry"
)

// Palette is SPEC 11.1, as terminal truecolor hex strings (lipgloss consumes
// this shape directly; the tui package owns any conversion).
type Palette struct {
	Accent        string // AccentBrush — #1A88FF in both themes (gauge fill, selection)
	WindowBg      string // WindowBgBrush
	TextPrimary   string // TextPrimaryBrush
	TextSecondary string // TextSecondaryBrush
	ProgressTrack string // ProgressTrackBrush
	ButtonBg      string // ButtonBgBrush
	ButtonHover   string // ButtonHoverBrush
	BadgeBg       string // BadgeBgBrush (update badge background)
	BadgeFg       string // BadgeFgBrush (update badge text)
}

// Moonlit is the light palette.
var Moonlit = Palette{
	Accent:        "#1A88FF",
	WindowBg:      "#F3F4F6",
	TextPrimary:   "#1F2329",
	TextSecondary: "#6B7280",
	ProgressTrack: "#E5E7EB",
	ButtonBg:      "#E9ECF0",
	ButtonHover:   "#DCE2E9",
	BadgeBg:       "#FFF0E0",
	BadgeFg:       "#E06D00",
}

// Moondark is the dark palette.
var Moondark = Palette{
	Accent:        "#1A88FF",
	WindowBg:      "#17191E",
	TextPrimary:   "#F2F3F5",
	TextSecondary: "#9AA0A8",
	ProgressTrack: "#3A3E47",
	ButtonBg:      "#2C3039",
	ButtonHover:   "#3A404B",
	BadgeBg:       "#3D2E1A",
	BadgeFg:       "#F0A040",
}

// PaletteOf(effective): only the literal "dark" selects Moondark.
func PaletteOf(effectiveTheme string) Palette {
	if effectiveTheme == "dark" {
		return Moondark
	}
	return Moonlit
}

// EffectiveTheme resolves the configured theme ("system" follows the OS); an
// unknown value means "follow the OS", exactly like the Rust catch-all arm.
// The OS answer is injected as a thunk so a pinned light/dark theme never
// probes the registry.
func EffectiveTheme(configured string, system func() string) string {
	if configured == "light" {
		return "light"
	}
	if configured == "dark" {
		return "dark"
	}
	return system()
}

const personalizeKeyPath = `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`

// ReadSystemTheme reads `AppsUseLightTheme` via the registry API: 0 is dark,
// anything else (or a missing/unreadable value) is light — the Rust
// `unwrap_or(1)` (SPEC 20).
func ReadSystemTheme() string {
	key, err := registry.OpenKey(registry.CURRENT_USER, personalizeKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return "light"
	}
	defer key.Close()
	v, _, err := key.GetIntegerValue("AppsUseLightTheme")
	if err != nil {
		return "light"
	}
	if v == 0 {
		return "dark"
	}
	return "light"
}
