// Read-only Kimi Code skill scanner, adapted from kimi-code-dashboard's
// routes/skills.py: scan */SKILL.md and parse the YAML frontmatter for
// name/description. No writes, no watchers, no polling — the caller caches
// the result.
//
// There is no per-skill enabled/disabled state to display: Kimi Code does not
// persist one (skills are excluded via frontmatter `disableModelInvocation`
// or by removal), and ~/.agents/.skill-lock.json is lark-cli's installer lock
// file ({version, skills, dismissed}) with no `disabled` key — the earlier
// disabled-badge feature read a key that never exists and was removed.

use crate::credentials::{home_dir, kimi_home};
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::Path;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Group label: "Kimi Code" | "Agents" | "Plugin: <name>"
    pub source: String,
}

/// Parse `name:` / `description:` from the YAML frontmatter of a SKILL.md.
/// Only the first 4 KiB are read — frontmatter always sits at the top.
/// Lossy decode tolerates a truncated multi-byte char at the 4 KiB cut and
/// stray non-UTF-8 (e.g. GBK) bytes; a UTF-8 BOM before the `---` fence is
/// stripped. Deliberately a line parser, not a YAML crate: zero new
/// dependencies. Known limits: an indented nested `name:` (e.g. under
/// `metadata:`) can be picked up when the top-level one is absent, and folded
/// scalars (`description: >-`) show the raw indicator.
fn parse_frontmatter(path: &Path) -> (Option<String>, Option<String>) {
    let mut buf = Vec::new();
    match fs::File::open(path) {
        Ok(f) => {
            if f.take(4096).read_to_end(&mut buf).is_err() {
                return (None, None);
            }
        }
        Err(_) => return (None, None),
    }
    let head = String::from_utf8_lossy(&buf);
    let mut lines = head.lines();
    if lines.next().map(str::trim).map(|l| l.trim_start_matches('\u{feff}')) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for raw in lines {
        let line = raw.trim_end();
        if line.trim() == "---" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            // Frontmatter values may be single/double quoted
            let value = value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            match key.trim() {
                "name" if name.is_none() => name = Some(value),
                "description" if description.is_none() => description = Some(value),
                _ => {}
            }
        }
    }
    (name, description)
}

/// Collect skills from one `<dir>/<id>/SKILL.md` layout.
fn collect(dir: &Path, source: &str, out: &mut Vec<SkillInfo>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|n| n.to_str()).map(String::from) else {
            continue;
        };
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let (name, description) = parse_frontmatter(&skill_md);
        out.push(SkillInfo {
            name: name.unwrap_or_else(|| id.clone()),
            description: description.unwrap_or_default(),
            id,
            source: source.to_string(),
        });
    }
}

/// Scan all three skill roots, grouped by source then sorted by name.
pub fn scan() -> Vec<SkillInfo> {
    let mut out = Vec::new();
    let Some(home) = home_dir() else {
        return out;
    };
    let kimi = kimi_home(&home);

    collect(&kimi.join("skills"), "Kimi Code", &mut out);
    collect(&home.join(".agents").join("skills"), "Agents", &mut out);

    // Managed plugins: ~/.kimi-code/plugins/managed/<plugin>/skills/<id>/
    let plugins = kimi.join("plugins").join("managed");
    if let Ok(entries) = fs::read_dir(&plugins) {
        for entry in entries.flatten() {
            let pdir = entry.path();
            if !pdir.is_dir() {
                continue;
            }
            let Some(pname) = pdir.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let source = format!("Plugin: {pname}");
            collect(&pdir.join("skills"), &source, &mut out);
        }
    }

    out.sort_by(|a, b| {
        a.source
            .cmp(&b.source)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Temp fixture dir under %TEMP%, removed on drop. The atomic suffix
    /// keeps parallel tests from sharing one directory.
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            use std::sync::atomic::{AtomicUsize, Ordering};
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "kpt-skills-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Fixture(dir)
        }
        fn write_skill(&self, id: &str, frontmatter: &str) {
            let dir = self.0.join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("SKILL.md"), frontmatter).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn frontmatter_name_description_and_quotes() {
        let fx = Fixture::new();
        fx.write_skill("a", "---\nname: Alpha\ndescription: \"Does things\"\n---\nbody");
        fx.write_skill("b", "---\ndescription: 'Only desc'\n---\n");
        fx.write_skill("c", "no frontmatter at all");
        fs::create_dir_all(fx.0.join("empty-no-skillmd")).unwrap();

        let mut out = Vec::new();
        collect(&fx.0, "Test", &mut out);
        assert_eq!(out.len(), 3);

        let a = out.iter().find(|s| s.id == "a").unwrap();
        assert_eq!(a.name, "Alpha");
        assert_eq!(a.description, "Does things");

        let b = out.iter().find(|s| s.id == "b").unwrap();
        assert_eq!(b.name, "b"); // falls back to the directory name
        assert_eq!(b.description, "Only desc");

        let c = out.iter().find(|s| s.id == "c").unwrap();
        assert_eq!(c.name, "c");
        assert_eq!(c.description, "");
    }

    #[test]
    fn bom_and_non_utf8_bytes_are_tolerated() {
        let fx = Fixture::new();
        // UTF-8 BOM before the --- fence
        let dir = fx.0.join("bom");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "\u{feff}---\nname: Bom\ndescription: x\n---\n").unwrap();
        // GBK-encoded bytes (中文 Windows 常见) inside the description
        let dir = fx.0.join("gbk");
        fs::create_dir_all(&dir).unwrap();
        let mut bytes = b"---\nname: Gbk\ndescription: ".to_vec();
        bytes.extend_from_slice(&[0xD6, 0xD0, 0xCE, 0xC4]); // "中文" in GBK
        bytes.extend_from_slice(b"\n---\n");
        fs::write(dir.join("SKILL.md"), bytes).unwrap();

        let mut out = Vec::new();
        collect(&fx.0, "Test", &mut out);
        assert_eq!(out.len(), 2);
        let bom = out.iter().find(|s| s.id == "bom").unwrap();
        assert_eq!(bom.name, "Bom");
        let gbk = out.iter().find(|s| s.id == "gbk").unwrap();
        assert_eq!(gbk.name, "Gbk"); // lossy decode keeps the ASCII fields
        assert!(gbk.description.contains('\u{fffd}')); // GBK bytes become U+FFFD
    }
}
