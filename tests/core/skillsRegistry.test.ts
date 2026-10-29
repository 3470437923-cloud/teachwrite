/** 技能注入块语义回归锁（2026-09-28 实测口径）：
 *  activeSkillIds 非空 = 恰好注入这些（内置不再强制并入）；
 *  空 = 未选择，默认全部注入；过滤后为空 = 不注入空块。 */
import { describe, expect, it } from "vitest";
import { availableSkillsBlock } from "../../src/core/skills/registry";
import type { SkillMeta } from "../../src/core/prefs";

const meta = (id: string, name: string, builtIn: boolean): SkillMeta => ({
  id,
  name,
  description: `${name} 的描述`,
  directoryPath: `C:\\skills\\${id}`,
  isBuiltIn: builtIn,
  marketplaceSkillId: null,
  marketplaceVersion: null,
});

const skills = [
  meta("b1", "novel-writer", true),
  meta("b2", "skill-creator", true),
  meta("c1", "烂人风格", false),
];

describe("availableSkillsBlock 语义", () => {
  it("activeIds 为空 → 全部注入", () => {
    const block = availableSkillsBlock(skills, []);
    expect(block).toContain("novel-writer");
    expect(block).toContain("skill-creator");
    expect(block).toContain("烂人风格");
  });

  it("activeIds 非空 → 恰好注入这些（内置停用后不再并入）", () => {
    const block = availableSkillsBlock(skills, ["b1", "c1"]);
    expect(block).toContain("novel-writer");
    expect(block).toContain("烂人风格");
    expect(block).not.toContain("skill-creator");
  });

  it("activeIds 全不命中 → 不注入空块", () => {
    expect(availableSkillsBlock(skills, ["missing"])).toBe("");
  });

  it("未传 activeIds → 全部注入", () => {
    expect(availableSkillsBlock(skills)).toContain("skill-creator");
  });
});
