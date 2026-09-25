package core

import "testing"

// The palette values are SPEC 11.1 brush constants — pinned literally so a
// careless edit cannot shift a color (the TS edition asserts the same bytes).
func TestPalettesMatchSpec(t *testing.T) {
	moonlit := Palette{
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
	moondark := Palette{
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
	if Moonlit != moonlit {
		t.Errorf("Moonlit = %+v", Moonlit)
	}
	if Moondark != moondark {
		t.Errorf("Moondark = %+v", Moondark)
	}
}

func TestPaletteOfOnlyDarkSelectsMoondark(t *testing.T) {
	if PaletteOf("dark") != Moondark {
		t.Error("dark selects Moondark")
	}
	for _, v := range []string{"light", "system", "", "Dark"} {
		if PaletteOf(v) != Moonlit {
			t.Errorf("%q must select Moonlit", v)
		}
	}
}

func TestEffectiveThemeRouting(t *testing.T) {
	probes := 0
	system := func() string {
		probes++
		return "dark"
	}
	if got := EffectiveTheme("light", system); got != "light" || probes != 0 {
		t.Errorf("pinned light must not probe the OS: %q probes=%d", got, probes)
	}
	if got := EffectiveTheme("dark", system); got != "dark" || probes != 0 {
		t.Errorf("pinned dark must not probe the OS: %q probes=%d", got, probes)
	}
	if got := EffectiveTheme("system", system); got != "dark" || probes != 1 {
		t.Errorf("system follows the OS: %q probes=%d", got, probes)
	}
	if got := EffectiveTheme("nonsense", system); got != "dark" || probes != 2 {
		t.Errorf("an unknown value follows the OS (Rust catch-all): %q", got)
	}
}
