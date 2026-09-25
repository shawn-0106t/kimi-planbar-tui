package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func skillFixture(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

func writeSkill(t *testing.T, dir, id, body string) {
	t.Helper()
	sub := filepath.Join(dir, id)
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeSkillBytes(t *testing.T, dir, id string, body []byte) {
	t.Helper()
	sub := filepath.Join(dir, id)
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "SKILL.md"), body, 0o644); err != nil {
		t.Fatal(err)
	}
}

func fm(t *testing.T, text string) (*string, *string) {
	t.Helper()
	return ParseFrontmatterFromBytes([]byte(text))
}

func TestCollectSkillsFrontmatterAndQuotes(t *testing.T) {
	dir := skillFixture(t)
	writeSkill(t, dir, "a", "---\nname: Alpha\ndescription: \"Does things\"\n---\nbody")
	writeSkill(t, dir, "b", "---\ndescription: 'Only desc'\n---\n")
	writeSkill(t, dir, "c", "no frontmatter at all")
	if err := os.MkdirAll(filepath.Join(dir, "empty-no-skillmd"), 0o755); err != nil {
		t.Fatal(err)
	}

	out := CollectSkills(dir, "Test")
	if len(out) != 3 {
		t.Fatalf("collect = %d skills, want 3", len(out))
	}
	byID := map[string]SkillInfo{}
	for _, s := range out {
		byID[s.ID] = s
	}
	if byID["a"].Name != "Alpha" || byID["a"].Description != "Does things" {
		t.Errorf("skill a = %+v", byID["a"])
	}
	if byID["b"].Name != "b" || byID["b"].Description != "Only desc" {
		t.Errorf("skill b (name falls back to dir) = %+v", byID["b"])
	}
	if byID["c"].Name != "c" || byID["c"].Description != "" {
		t.Errorf("skill c = %+v", byID["c"])
	}
}

func TestBOMAndNonUTF8BytesAreTolerated(t *testing.T) {
	dir := skillFixture(t)
	writeSkill(t, dir, "bom", "\uFEFF---\nname: Bom\ndescription: x\n---\n")
	var gbk []byte
	gbk = append(gbk, []byte("---\nname: Gbk\ndescription: ")...)
	gbk = append(gbk, 0xD6, 0xD0, 0xCE, 0xC4) // "中文" in GBK
	gbk = append(gbk, []byte("\n---\n")...)
	writeSkillBytes(t, dir, "gbk", gbk)

	out := CollectSkills(dir, "Test")
	if len(out) != 2 {
		t.Fatalf("collect = %d skills, want 2", len(out))
	}
	byID := map[string]SkillInfo{}
	for _, s := range out {
		byID[s.ID] = s
	}
	if byID["bom"].Name != "Bom" {
		t.Errorf("bom skill name = %q", byID["bom"].Name)
	}
	if byID["gbk"].Name != "Gbk" {
		t.Errorf("lossy decode keeps the ASCII fields, got %q", byID["gbk"].Name)
	}
	if !strings.Contains(byID["gbk"].Description, "\uFFFD") {
		t.Errorf("GBK bytes must become U+FFFD (written as an escape per REVIEW-M1 Major D), got %q",
			byID["gbk"].Description)
	}
}

func TestFrontmatterFenceRules(t *testing.T) {
	if n, _ := fm(t, "\uFEFF---\nname: A\n---\n"); n == nil || *n != "A" {
		t.Error("a BOM before the fence is tolerated")
	}
	if n, _ := fm(t, "  ---  \nname: A\n---\n"); n == nil || *n != "A" {
		t.Error("padding around the fence is tolerated")
	}
	if n, _ := fm(t, "\uFEFF\uFEFF---\nname: A\n---\n"); n == nil || *n != "A" {
		t.Error("multiple BOMs are stripped")
	}
	if n, _ := fm(t, "----\nname: A\n---\n"); n != nil {
		t.Error("---- is not a fence")
	}
	if n, _ := fm(t, "---x\nname: A\n---\n"); n != nil {
		t.Error("---x is not a fence")
	}
}

func TestFrontmatterClosingFence(t *testing.T) {
	if n, _ := fm(t, "---\nname: A\n  ---\nname: B\n"); n == nil || *n != "A" {
		t.Error("an indented closing fence ends the block; first value wins")
	}
	if n, _ := fm(t, "---\nname: A\n"); n == nil || *n != "A" {
		t.Error("no closing fence at all still parses")
	}
}

func TestFrontmatterFirstValueWinsAndFirstColonSplits(t *testing.T) {
	if n, _ := fm(t, "---\nname: One\nname: Two\n"); n == nil || *n != "One" {
		t.Error("the first name wins")
	}
	if _, d := fm(t, "---\ndescription: see http://x/y\n"); d == nil || *d != "see http://x/y" {
		t.Error("only the first colon splits")
	}
}

func TestFrontmatterQuoteStrippingIsTrimMatches(t *testing.T) {
	if _, d := fm(t, "---\ndescription: \"quoted\"\n"); d == nil || *d != "quoted" {
		t.Error("double quotes stripped")
	}
	if _, d := fm(t, "---\ndescription: 'single'\n"); d == nil || *d != "single" {
		t.Error("single quotes stripped")
	}
	if _, d := fm(t, "---\ndescription: \"\"mixed\"\"\n"); d == nil || *d != "mixed" {
		t.Error("repeated quotes stripped")
	}
	if _, d := fm(t, "---\ndescription: \"a\" and \"b\"\n"); d == nil || *d != "a\" and \"b" {
		t.Error("inner quotes stay")
	}
	if _, d := fm(t, "---\ndescription:\n"); d == nil || *d != "" {
		t.Error("empty value reads as empty string")
	}
}

func TestFrontmatterKnownLimits(t *testing.T) {
	// An indented nested key can be picked up when the top-level one is
	// absent, and folded scalars show the raw indicator — the Rust comment
	// documents both.
	if n, _ := fm(t, "---\nmetadata:\n  name: nested\n"); n == nil || *n != "nested" {
		t.Error("indented nested name is picked up (documented limit)")
	}
	if _, d := fm(t, "---\ndescription: >-\n  folded\n"); d == nil || *d != ">-" {
		t.Error("folded scalar shows the raw indicator (documented limit)")
	}
}

func TestFrontmatterStopsAt4KiB(t *testing.T) {
	long := "---\ndescription: " + strings.Repeat("x", 5000) + "\nname: Late\n---\n"
	name, description := ParseFrontmatterFromBytes([]byte(long))
	if name != nil {
		t.Error("the name beyond the 4 KiB window must not be seen")
	}
	if description == nil || len(*description) != 4096-len("---\ndescription: ") {
		t.Errorf("description is clipped to the window, got %d bytes", len(*description))
	}
}

func TestFrontmatter4KiBThroughFilePath(t *testing.T) {
	dir := skillFixture(t)
	writeSkill(t, dir, "big", "---\ndescription: "+strings.Repeat("x", 5000)+"\nname: Late\n---\n")
	name, description := ParseFrontmatter(filepath.Join(dir, "big", "SKILL.md"))
	if name != nil {
		t.Error("the name beyond the 4 KiB window must not be seen")
	}
	if description == nil || len(*description) != 4096-len("---\ndescription: ") {
		t.Errorf("file path reads agree with the parser on the window, got %d", len(*description))
	}
}

func TestSortSkills(t *testing.T) {
	sorted := SortSkills([]SkillInfo{
		{ID: "z", Name: "zeta", Source: "Kimi Code"},
		{ID: "a", Name: "Alpha", Source: "Kimi Code"},
		{ID: "b", Name: "beta", Source: "Agents"},
		{ID: "p", Name: "x", Source: "Plugin: zzz"},
	})
	want := []string{"Agents/beta", "Kimi Code/Alpha", "Kimi Code/zeta", "Plugin: zzz/x"}
	for i, w := range want {
		if got := sorted[i].Source + "/" + sorted[i].Name; got != w {
			t.Errorf("sorted[%d] = %q, want %q", i, got, w)
		}
	}

	sorted2 := SortSkills([]SkillInfo{
		{ID: "1", Name: "b", Source: "S"},
		{ID: "2", Name: "_", Source: "S"},
		{ID: "3", Name: "A", Source: "S"},
	})
	want2 := []string{"_", "A", "b"} // lowercased code points: 5F < 61 < 62
	for i, w := range want2 {
		if sorted2[i].Name != w {
			t.Errorf("case-insensitive order [%d] = %q, want %q", i, sorted2[i].Name, w)
		}
	}
}

func TestScanSkillsRealMachine(t *testing.T) {
	// A scan over the real machine must never throw; the result may be empty.
	_ = ScanSkills(nil)
}
