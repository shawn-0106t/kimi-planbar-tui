// Skills view pins (SPEC 21): grouping, selection movement skipping group
// headers, scroll windowing, the empty/loading states, and the injection
// firewall for external skill text reaching a rendered frame.

import { describe, expect, test } from "./bun-shim.ts";
import type { SkillInfo } from "../src/core/skills.ts";
import { MOONLIT } from "../src/core/theme.ts";
import { lineText } from "../src/tui/line.ts";
import { renderRow } from "../src/tui/screen.ts";
import {
  buildSkillsRows,
  firstItemRow,
  moveSkillsSel,
  renderSkillsRows,
  SKILLS_FOOTER,
  type SkillsRow,
} from "../src/tui/skillsView.ts";

const P = MOONLIT;

const skill = (source: string, name: string, description = ""): SkillInfo => ({
  id: name,
  name,
  description,
  source,
});

// scanSkills pre-sorts by source then case-insensitive name; fixtures keep it.
const FIXTURE: SkillInfo[] = [
  skill("Agents", "alpha", "the alpha skill"),
  skill("Kimi Code", "Beta", "the beta skill"),
  skill("Kimi Code", "gamma"),
  skill("Plugin: xhcj", "delta", "the delta skill"),
];

const render = (rows: SkillsRow[], sel: number, height = 24, width = 80, loading = false) =>
  renderSkillsRows({ rows, sel, loading, width, height, palette: P });

describe("buildSkillsRows + selection movement (SPEC 21.3)", () => {
  test("groups by source in input order, items after their header", () => {
    expect(buildSkillsRows(FIXTURE)).toEqual([
      { kind: "group", label: "Agents" },
      { kind: "item", name: "alpha", description: "the alpha skill" },
      { kind: "group", label: "Kimi Code" },
      { kind: "item", name: "Beta", description: "the beta skill" },
      { kind: "item", name: "gamma", description: "" },
      { kind: "group", label: "Plugin: xhcj" },
      { kind: "item", name: "delta", description: "the delta skill" },
    ]);
  });

  test("first item is the initial selection; empty rows give 0", () => {
    expect(firstItemRow(buildSkillsRows(FIXTURE))).toBe(1);
    expect(firstItemRow([])).toBe(0);
  });

  test("up/down skip group headers and wrap around", () => {
    const rows = buildSkillsRows(FIXTURE);
    expect(moveSkillsSel(rows, 1, 1)).toBe(3); // alpha -> Beta (over the header)
    expect(moveSkillsSel(rows, 3, -1)).toBe(1);
    expect(moveSkillsSel(rows, 1, -1)).toBe(6); // alpha -> delta (wrap)
    expect(moveSkillsSel(rows, 6, 1)).toBe(1); // delta -> alpha (wrap)
    expect(moveSkillsSel([], 0, 1)).toBe(0);
  });
});

describe("skills view rendering (SPEC 21.3)", () => {
  test("title carries the summary; footer advertises the rescan key", () => {
    const rows = render(buildSkillsRows(FIXTURE), 1);
    expect(lineText(rows[1]!).trimEnd()).toBe("  Kimi Skills   4 skills");
    expect(SKILLS_FOOTER).toBe("↑/↓ Scroll · r Rescan · Esc Back · q Quit");
  });

  test("loading state says Scanning...", () => {
    const rows = render([], 0, 24, 80, true);
    expect(lineText(rows[1]!).trimEnd()).toBe("  Kimi Skills   Scanning...");
  });

  test("empty list renders the zero summary and no rows", () => {
    const rows = render([], 0);
    expect(lineText(rows[1]!).trimEnd()).toBe("  Kimi Skills   0 skills");
    expect(rows.length).toBe(4);
  });

  test("groups get accent bold headers with a blank separator, items indent", () => {
    const lines = render(buildSkillsRows(FIXTURE), 1).map(lineText);
    expect(lines[4]!.trimEnd()).toBe("Agents");
    expect(lines[5]!.trimEnd()).toBe("  alpha");
    expect(lines[6]!.trimEnd()).toBe("    the alpha skill");
    expect(lines[7]!.trimEnd()).toBe(""); // separator before the next group
    expect(lines[8]!.trimEnd()).toBe("Kimi Code");
  });

  test("the selected item is highlighted on button_hover on both its lines (rust draw)", () => {
    const rows = render(buildSkillsRows(FIXTURE), 1);
    const name = rows[5]!.spans[0]!;
    const desc = rows[6]!.spans[0]!;
    expect([name.fg, name.bg, name.bold]).toEqual([P.textPrimary, P.buttonHover, true]);
    expect([desc.fg, desc.bg]).toEqual([P.textSecondary, P.buttonHover]);
    const otherName = render(buildSkillsRows(FIXTURE), 3)[5]!.spans[0]!;
    expect(otherName.bg).toBeUndefined();
    expect(otherName.bold).toBe(true);
  });

  test("scrolling keeps the selected item inside the viewport", () => {
    const rows = buildSkillsRows(FIXTURE); // 11 display lines total
    // viewport = height - 5 = 4; selecting the last item (display line 9)
    // must scroll so that line stays visible.
    const frame = render(rows, 6, 9).map(lineText);
    expect(frame.length).toBe(8); // 4 title rows + 4 viewport rows
    expect(frame.some((l) => l.includes("delta"))).toBe(true);
    expect(frame.some((l) => l.includes("Plugin: xhcj"))).toBe(true);
    expect(frame.some((l) => l.includes("Agents"))).toBe(false); // scrolled off
  });

  test("escape sequences in skill text never reach a rendered frame", () => {
    const evil = [skill("Kimi Code", "evil-\x1b[31mHACK", "run \x1b[2J\x1b[H now")];
    const rows = render(buildSkillsRows(evil), 1);
    for (const line of rows) {
      const wire = renderRow(line, 60, P.windowBg);
      expect(wire).not.toContain("\x1b[31m");
      expect(wire).not.toContain("\x1b[2J");
    }
    // The text survives, only the control bytes are gone.
    expect(lineText(rows[5]!)).toContain("evil-");
  });
});
