// Theme support: system theme detection + the Moonlit/Moondark palettes.
//
// System theme follow (SPEC 20): the tray edition listened to
// WM_SETTINGCHANGE; a TUI has no system-event source, so the app polls
// HKCU AppsUseLightTheme every 30s from the event loop (see app.rs) and
// only re-applies when the configured theme is "system".
//
// Palette mapping: SPEC 11.1 brush table -> ratatui truecolor Color::Rgb.
// Accent (#1A88FF) is identical in both themes; gauge fill is always the
// accent color with no threshold-based color change (SPEC 11.2).

use ratatui::style::Color;

/// 0 = dark, 1 (or missing) = light.
pub fn system_theme() -> &'static str {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let value: u32 = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|k| k.get_value("AppsUseLightTheme"))
        .unwrap_or(1);
    if value == 0 {
        "dark"
    } else {
        "light"
    }
}

/// Resolve the configured theme ("system" follows the OS) to light|dark.
pub fn effective(configured: &str) -> String {
    match configured {
        "light" => "light".to_string(),
        "dark" => "dark".to_string(),
        _ => system_theme().to_string(),
    }
}

const fn rgb(hex: u32) -> Color {
    Color::Rgb(((hex >> 16) & 0xFF) as u8, ((hex >> 8) & 0xFF) as u8, (hex & 0xFF) as u8)
}

/// SPEC 11.1 brush table as terminal truecolors.
#[derive(Clone, Copy)]
pub struct Palette {
    /// AccentBrush — #1A88FF in both themes (gauge fill, selection)
    pub accent: Color,
    /// WindowBgBrush
    pub window_bg: Color,
    // CardBgBrush is intentionally absent: the wireframe UI (plan section 4.1
    // revision) draws no card backgrounds, only text colors.
    /// TextPrimaryBrush
    pub text_primary: Color,
    /// TextSecondaryBrush
    pub text_secondary: Color,
    /// ProgressTrackBrush
    pub progress_track: Color,
    /// ButtonBgBrush
    pub button_bg: Color,
    /// ButtonHoverBrush
    pub button_hover: Color,
    /// BadgeBgBrush (update badge background)
    pub badge_bg: Color,
    /// BadgeFgBrush (update badge text)
    pub badge_fg: Color,
}

pub const MOONLIT: Palette = Palette {
    accent: rgb(0x1A88FF),
    window_bg: rgb(0xF3F4F6),
    text_primary: rgb(0x1F2329),
    text_secondary: rgb(0x6B7280),
    progress_track: rgb(0xE5E7EB),
    button_bg: rgb(0xE9ECF0),
    button_hover: rgb(0xDCE2E9),
    badge_bg: rgb(0xFFF0E0),
    badge_fg: rgb(0xE06D00),
};

pub const MOONDARK: Palette = Palette {
    accent: rgb(0x1A88FF),
    window_bg: rgb(0x17191E),
    text_primary: rgb(0xF2F3F5),
    text_secondary: rgb(0x9AA0A8),
    progress_track: rgb(0x3A3E47),
    button_bg: rgb(0x2C3039),
    button_hover: rgb(0x3A404B),
    badge_bg: rgb(0x3D2E1A),
    badge_fg: rgb(0xF0A040),
};

/// Palette for an effective theme ("dark" -> Moondark, else Moonlit).
pub fn palette(effective_theme: &str) -> Palette {
    if effective_theme == "dark" {
        MOONDARK
    } else {
        MOONLIT
    }
}
