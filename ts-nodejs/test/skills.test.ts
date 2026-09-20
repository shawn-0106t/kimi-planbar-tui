import { describe, expect, test } from "./bun-shim.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectSkills, parseFrontmatter, parseFrontmatterFromBytes, scanSkills, sortSkills } from "../src/core/skills.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const fixture = (): { dir: string; skill: (id: string, body: Uint8Array | string) => void } => {
  const dir = join(process.env["TMP"] ?? ".", `kpt-skills-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    skill(id, body) {
      const sub = join(dir, id);
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "SKILL.md"), typeof body === "string" ? utf8(body) : body);
    },
  };
};

const fm = (text: string): [string | null, string | null] => parseFrontmatterFromBytes(bytes(text));

describe("frontmatter parser (SPEC 21.2)", () => {
  test("frontmatter_name_description_and_quotes, ported from rust/src/skills.rs", () => {
    const fx = fixture();
    fx.skill("a", '---\nname: Alpha\ndescription: "Does things"\n---\nbody');
    fx.skill("b", "---\ndescription: 'Only desc'\n---\n");
    fx.skill("c", "no frontmatter at all");
    mkdirSync(join(fx.dir, "empty-no-skillmd"), { recursive: true });

    const out = collectSkills(fx.dir, "Test");
    expect(out).toHaveLength(3);

    const a = out.find((s) => s.id === "a");
    expect(a?.name).toBe("Alpha");
    expect(a?.description).toBe("Does things");

    const b = out.find((s) => s.id === "b");
    expect(b?.name).toBe("b"); // falls back to the directory name
    expect(b?.description).toBe("Only desc");

    const c = out.find((s) => s.id === "c");
    expect(c?.name).toBe("c");
    expect(c?.description).toBe("");
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test("bom_and_non_utf8_bytes_are_tolerated, ported from rust/src/skills.rs", () => {
    const fx = fixture();
    fx.skill("bom", utf8("﻿---\nname: Bom\ndescription: x\n---\n"));
    const gbk = [...utf8("---\nname: Gbk\ndescription: "), 0xd6, 0xd0, 0xce, 0xc4, ...utf8("\n---\n")];
    fx.skill("gbk", Uint8Array.from(gbk));

    const out = collectSkills(fx.dir, "Test");
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.id === "bom")?.name).toBe("Bom");
    const gbkSkill = out.find((s) => s.id === "gbk");
    expect(gbkSkill?.name).toBe("Gbk"); // lossy decode keeps the ASCII fields
    expect(gbkSkill?.description.includes("\uFFFD")).toBe(true); // GBK bytes decode lossily to U+FFFD
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test("the fence must be the first line and may carry a BOM or padding", () => {
    expect(fm("﻿---\nname: A\n---\n")[0]).toBe("A");
    expect(fm("  ---  \nname: A\n---\n")[0]).toBe("A");
    expect(fm("﻿﻿---\nname: A\n---\n")[0]).toBe("A");
    expect(fm("----\nname: A\n---\n")[0]).toBeNull();
    expect(fm("---x\nname: A\n---\n")[0]).toBeNull();
  });

  test("keys stop at the closing fence, which may be indented", () => {
    expect(fm("---\nname: A\n  ---\nname: B\n")[0]).toBe("A");
    expect(fm("---\nname: A\n")[0]).toBe("A"); // no closing fence at all
  });

  test("the first value wins and only the first colon splits", () => {
    expect(fm("---\nname: One\nname: Two\n")[0]).toBe("One");
    expect(fm("---\ndescription: see http://x/y\n")[1]).toBe("see http://x/y");
  });

  test("quote stripping is trim_matches, not a matching pair", () => {
    expect(fm('---\ndescription: "quoted"\n')[1]).toBe("quoted");
    expect(fm("---\ndescription: 'single'\n")[1]).toBe("single");
    expect(fm('---\ndescription: ""mixed""\n')[1]).toBe("mixed");
    expect(fm('---\ndescription: "a" and "b"\n')[1]).toBe('a" and "b');
    expect(fm("---\ndescription:\n")[1]).toBe("");
  });

  test("an indented nested key can be picked up, as the Rust comment warns", () => {
    expect(fm("---\nmetadata:\n  name: nested\n")[0]).toBe("nested");
    expect(fm("---\ndescription: >-\n  folded\n")[1]).toBe(">-");
  });

  test("the parser stops at 4 KiB of the bytes it is handed", () => {
    const long = "---\ndescription: " + "x".repeat(5000) + "\nname: Late\n---\n";
    const parsed = parseFrontmatterFromBytes(bytes(long));
    expect(parsed[1]).toHaveLength(4096 - "---\ndescription: ".length);
    expect(parsed[0]).toBeNull();
  });

  test("the 4 KiB window also holds through the real file path (SPEC 21.2)", () => {
    const fx = fixture();
    // This pins the file path end to end (readFileBytes + parser agree on the
    // window). It cannot pin the *physical* read bound: the parser caps at 4096
    // itself, so a whole-file read is indistinguishable through any public API —
    // that half of Rust's `take(4096)` is a memory-safety property, code-reviewed
    // only.
    fx.skill("big", "---\ndescription: " + "x".repeat(5000) + "\nname: Late\n---\n");
    const [name, description] = parseFrontmatter(join(fx.dir, "big", "SKILL.md"));
    expect(description).toHaveLength(4096 - "---\ndescription: ".length);
    expect(name).toBeNull();
    rmSync(fx.dir, { recursive: true, force: true });
  });
});

describe("ordering (SPEC 21.2)", () => {
  test("source compares by code point, name case-insensitively", () => {
    const sorted = sortSkills([
      { id: "z", name: "zeta", description: "", source: "Kimi Code" },
      { id: "a", name: "Alpha", description: "", source: "Kimi Code" },
      { id: "b", name: "beta", description: "", source: "Agents" },
      { id: "p", name: "x", description: "", source: "Plugin: zzz" },
    ]);
    expect(sorted.map((s) => `${s.source}/${s.name}`)).toEqual([
      "Agents/beta",
      "Kimi Code/Alpha",
      "Kimi Code/zeta",
      "Plugin: zzz/x",
    ]);
  });

  test("case-insensitive means code points, not a locale collation", () => {
    const sorted = sortSkills([
      { id: "1", name: "b", description: "", source: "S" },
      { id: "2", name: "_", description: "", source: "S" },
      { id: "3", name: "A", description: "", source: "S" },
    ]);
    // lowercased code points: _ (5F) < a (61) < b (62)
    expect(sorted.map((s) => s.name)).toEqual(["_", "A", "b"]);
  });

  test("scanning a real machine never throws", () => {
    expect(Array.isArray(scanSkills(process.env))).toBe(true);
  });
});
