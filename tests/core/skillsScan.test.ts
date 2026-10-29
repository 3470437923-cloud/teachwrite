/** 技能扫描回归锁：frontmatter 解析、内置判定、合并语义（首扫全开/更新保留开关） */
import { describe, expect, it } from "vitest";
import { mergeSkillList, parseFrontmatter, scanSkills, BUILTIN_SKILL_NAMES } from "../../src/core/skills/scan";
import type { FsBridge } from "../../src/core/fsbridge";
import type { SkillMeta } from "../../src/core/prefs";

const NOVEL_WRITER_SKILL = `---
name: novel-writer
description: 写小说时使用的技能。当用户要写小说、创作小说时自动触发。
---

# 小说写作助手
`;

const LANREN_SKILL = `---
name: 烂人风格
description: 《烂人》作品的写作风格
---
正文
`;

/** 内存替身：dirs 的键是技能目录、值是 SKILL.md 内容。
 *  实现 FsBridge 全部方法（含 rel 字段），直接以接口类型返回，让 TS 校验形态。 */
function memFs(dirs: Record<string, string>): FsBridge {
  return {
    async exists(p: string) {
      // 任意目录的 SKILL.md 由 dirs 提供；其余不存在
      return Object.keys(dirs).some((d) => p === `${d}\\SKILL.md`);
    },
    async readText(p: string) {
      for (const [d, content] of Object.entries(dirs)) {
        if (p === `${d}\\SKILL.md`) return content;
      }
      throw new Error("not found: " + p);
    },
    async list(root: string) {
      return Object.keys(dirs)
        .filter((d) => d.startsWith(root + "\\"))
        .map((d) => {
          const name = d.slice(root.length + 1);
          return { name, rel: name, path: d, isDir: true, isLink: false, size: 0, mtimeMs: 0 };
        });
    },
    async writeText() {},
    async appendText() {},
    async mkdir() {},
    async remove() {},
    async removeChild() {},
    async rename() {},
    async copy() {},
    async stat() {
      return null;
    },
  };
}

describe("parseFrontmatter", () => {
  it("解析 name/description（novel-writer 实测样本格式）", () => {
    const r = parseFrontmatter(NOVEL_WRITER_SKILL);
    expect(r.name).toBe("novel-writer");
    expect(r.description).toContain("写小说时使用的技能");
  });
  it("无 frontmatter → 空值（调用方跳过）", () => {
    expect(parseFrontmatter("# 无头\n正文").name).toBe("");
  });
  it("带 BOM 的 frontmatter 仍可解析（记事本存 UTF-8 带 BOM 不该丢技能）", () => {
    expect(parseFrontmatter("\uFEFF---\nname: novel-writer\n---\n").name).toBe("novel-writer");
  });
  it("CRLF 换行的 frontmatter 可解析（\\r 被 trim 剥掉）", () => {
    const r = parseFrontmatter("---\r\nname: novel-writer\r\ndescription: 描述\r\n---\r\n");
    expect(r.name).toBe("novel-writer");
    expect(r.description).toBe("描述");
  });
  it("N-31：---- 分隔线不当围栏（不再从 horizontal rule 里孵出 phantom 技能）", () => {
    const r = parseFrontmatter("----\nname: bogus\n----\n正文");
    expect(r.name).toBe("");
    expect(r.description).toBe("");
  });
  it("N-31：以 --- 开头但带尾巴的行不闭合围栏，后续字段不丢", () => {
    const r = parseFrontmatter("---\nname: real\n---not-a-fence\ndescription: 描述\n---\n正文");
    expect(r.name).toBe("real");
    expect(r.description).toBe("描述");
  });
  it("A-8：YAML 成对引号被剥掉（token-optimizer 的带引号 description 不再注入字面引号）", () => {
    const r = parseFrontmatter('---\nname: token-optimizer\ndescription: "带引号的描述"\n---\n');
    expect(r.name).toBe("token-optimizer");
    expect(r.description).toBe("带引号的描述");
    const single = parseFrontmatter("---\nname: 'x'\ndescription: 'y'\n---\n");
    expect(single.name).toBe("x");
    expect(single.description).toBe("y");
  });
  it("A-8：不成对引号原样保留（只做简单标量口径，不吃掉用户内容）", () => {
    const r = parseFrontmatter('---\nname: x\ndescription: "半截引号\n---\n');
    expect(r.description).toBe('"半截引号');
  });
  it("N-31：围栏未闭合 → 空值（旧口径不变）", () => {
    const r = parseFrontmatter("---\nname: x\ndescription: y\n正文里没有闭合围栏");
    expect(r.name).toBe("");
  });
});

describe("scanSkills", () => {
  it("扫描子目录生成 SkillMeta；isBuiltIn 按内置名单判定", async () => {
    const fs = memFs({
      "C:\\skills\\novel-writer": NOVEL_WRITER_SKILL,
      "C:\\skills\\烂人风格": LANREN_SKILL,
    });
    const list = await scanSkills(fs, "C:\\skills");
    expect(list).toHaveLength(2);
    const nw = list.find((s) => s.name === "novel-writer")!;
    expect(nw.isBuiltIn).toBe(true);
    expect(nw.id).toBe("novel-writer");
    expect(nw.marketplaceSkillId).toBeNull();
    const lr = list.find((s) => s.name === "烂人风格")!;
    expect(lr.isBuiltIn).toBe(false);
    expect(lr.directoryPath).toBe("C:\\skills\\烂人风格");
  });
  it("缺 SKILL.md 的目录跳过", async () => {
    const fs = memFs({ "C:\\skills\\empty": "# 无 SKILL.md 的目录" });
    expect(await scanSkills(fs, "C:\\skills")).toHaveLength(0);
  });
  it("内置名单就是随包的 5 个（A-8：与 assets/builtin-skills 一致）", () => {
    expect([...BUILTIN_SKILL_NAMES].sort()).toEqual([
      "novel-deslop",
      "novel-structure-quality-coordinator",
      "novel-writer",
      "skill-creator",
      "token-optimizer",
    ]);
  });
});

describe("mergeSkillList", () => {
  const scanned: SkillMeta[] = [
    { id: "novel-writer", name: "novel-writer", description: "", directoryPath: "x", isBuiltIn: true, marketplaceSkillId: null, marketplaceVersion: null },
    { id: "b", name: "b", description: "", directoryPath: "y", isBuiltIn: false, marketplaceSkillId: null, marketplaceVersion: null },
  ];
  it("首次扫描（旧清单空）→ 只默认开启内置白名单（novel-writer/skill-creator）", () => {
    const r = mergeSkillList([], scanned);
    expect(r.activeSkillIds).toEqual(["novel-writer"]);
  });
  it("非首次 → 保留用户当前开关", () => {
    const prev = scanned.map((s) => ({ ...s }));
    const r = mergeSkillList(prev, scanned, ["b"]);
    expect(r.activeSkillIds).toEqual(["b"]);
    expect(r.skillList).toEqual(scanned);
  });
});
