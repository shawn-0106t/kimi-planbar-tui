// Read-only Kimi Code skill scanner, a port of rust/src/skills.rs (SPEC 21.2).
// No writes, no watchers, no polling: the caller scans once and caches.
//
// There is no per-skill enabled/disabled state to display: Kimi Code does not
// persist one, and ~/.agents/.skill-lock.json is never read (SPEC 21.2).
package core

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// SkillInfo is one scanned skill.
type SkillInfo struct {
	ID          string
	Name        string
	Description string
	// Source is the group label: "Kimi Code" | "Agents" | "Plugin: <name>"
	Source string
}

const frontmatterBytes = 4096

// ParseFrontmatterFromBytes extracts name/description from the YAML
// frontmatter of a SKILL.md, decoding through LossyDecode so a truncated
// multi-byte character at the 4 KiB cut and stray non-UTF-8 (e.g. GBK) bytes
// degrade to one U+FFFD per maximal ill-formed subpart, exactly like Rust.
// Deliberately a line parser, not a YAML crate: zero new dependencies.
func ParseFrontmatterFromBytes(b []byte) (name, description *string) {
	if len(b) > frontmatterBytes {
		b = b[:frontmatterBytes]
	}
	head := LossyDecode(b)
	lines := RustLines(head)
	if len(lines) == 0 {
		return nil, nil
	}
	if RustStripLeadingBoms(RustTrim(lines[0])) != "---" {
		return nil, nil
	}

	var n, d *string
	for _, raw := range lines[1:] {
		line := RustTrimEnd(raw)
		if RustTrim(line) == "---" {
			break
		}
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		// Frontmatter values may be single/double quoted; stripping follows
		// trim_matches (all leading/trailing repeats), not a matching pair.
		v := RustTrimMatchesChar(RustTrimMatchesChar(RustTrim(value), `"`), "'")
		switch RustTrim(key) {
		case "name":
			if n == nil {
				first := v
				n = &first
			}
		case "description":
			if d == nil {
				first := v
				d = &first
			}
		}
	}
	return n, d
}

// ParseFrontmatter reads at most the first 4 KiB of the file — frontmatter
// always sits at the top.
func ParseFrontmatter(path string) (name, description *string) {
	b, ok := readFileBytes(path)
	if !ok {
		return nil, nil
	}
	return ParseFrontmatterFromBytes(b)
}

// CollectSkills reads `<dir>/<id>/SKILL.md` entries, mirroring the Rust
// `collect`. A missing name falls back to the directory name.
func CollectSkills(dir, source string) []SkillInfo {
	var out []SkillInfo
	for _, entry := range listDir(dir) {
		if !isDirectory(entry.path) {
			continue
		}
		b, ok := readFileBytes(filepath.Join(entry.path, "SKILL.md"))
		if !ok {
			continue // no SKILL.md, or unreadable
		}
		parsedName, parsedDescription := ParseFrontmatterFromBytes(b)
		info := SkillInfo{ID: entry.name, Source: source}
		if parsedName != nil {
			info.Name = *parsedName
		} else {
			info.Name = entry.name
		}
		if parsedDescription != nil {
			info.Description = *parsedDescription
		}
		out = append(out, info)
	}
	return out
}

// SortSkills: group label order is by code point ("Agents" < "Kimi Code" <
// "Plugin: …"), then a case-insensitive name order — deliberately not a
// locale collation.
func SortSkills(list []SkillInfo) []SkillInfo {
	sort.SliceStable(list, func(i, j int) bool {
		c := strings.Compare(list[i].Source, list[j].Source)
		if c != 0 {
			return c < 0
		}
		return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name)
	})
	return list
}

// ScanSkills scans all three skill roots, grouped by source then sorted by
// name (SPEC 21.2).
func ScanSkills(env Env) []SkillInfo {
	out := []SkillInfo{}
	home, ok := HomeDir(env)
	if !ok {
		return out
	}
	kimi := KimiHome(home, env)

	out = append(out, CollectSkills(filepath.Join(kimi, "skills"), "Kimi Code")...)
	out = append(out, CollectSkills(filepath.Join(home, ".agents", "skills"), "Agents")...)

	// Managed plugins: ~/.kimi-code/plugins/managed/<plugin>/skills/<id>/
	for _, plugin := range listDir(filepath.Join(kimi, "plugins", "managed")) {
		if !isDirectory(plugin.path) {
			continue
		}
		out = append(out, CollectSkills(filepath.Join(plugin.path, "skills"), "Plugin: "+plugin.name)...)
	}
	return SortSkills(out)
}

type dirEntry struct {
	name string
	path string
}

func listDir(dir string) []dirEntry {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := make([]dirEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, dirEntry{name: e.Name(), path: filepath.Join(dir, e.Name())})
	}
	return out
}

func isDirectory(path string) bool {
	info, err := os.Stat(path) // follows symlinks, like Rust's is_dir
	return err == nil && info.IsDir()
}

// readFileBytes physically reads at most the first 4 KiB (mirrors Rust's
// `File::take(4096)`): a hostile multi-hundred-MB SKILL.md under a managed
// plugin directory must not be slurped whole.
func readFileBytes(path string) ([]byte, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	var buf bytes.Buffer
	if _, err := io.CopyN(&buf, f, frontmatterBytes); err != nil && err != io.EOF {
		return nil, false
	}
	return buf.Bytes(), true
}
