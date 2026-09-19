// Build script: embeds the Windows VERSIONINFO resource + app icon into the
// exe. File/Product version are taken from CARGO_PKG_VERSION automatically
// by winresource, so the only version bump location stays Cargo.toml.

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let mut res = winresource::WindowsResource::new();
    res.set_icon("assets/icon.ico");
    res.set("InternalName", "kimi-planbar-tui");
    res.set("OriginalFilename", "kimi-planbar-tui.exe");
    res.set("FileDescription", "Kimi Planbar TUI - Kimi Code quota terminal dashboard");
    res.set("ProductName", "Kimi Planbar TUI");
    res.set("CompanyName", "Kimi Planbar community");
    res.set(
        "LegalCopyright",
        "MIT License (c) Shawn Qi; portions (c) baigong-ai / kimi-planbar",
    );
    res.set(
        "Comments",
        "Unofficial community tool; not affiliated with Moonshot AI.",
    );
    if let Err(e) = res.compile() {
        // Never fail the build over resource embedding (rc.exe may be absent
        // on machines without the Windows SDK); the exe just lacks metadata.
        println!("cargo:warning=VERSIONINFO resource embedding failed: {e}");
    }
}
