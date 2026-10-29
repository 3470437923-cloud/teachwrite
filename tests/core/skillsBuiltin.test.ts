/** A-8 回归锁：内置技能资产的发布链路（内联资产 → 技能根；只补缺失，不覆盖用户副本） */
import { describe, expect, it } from "vitest";
import { BUILTIN_SKILL_FILES, releaseBuiltinSkills } from "../../src/core/skills/builtin";
import { BUILTIN_SKILL_NAMES } from "../../src/core/skills/scan";
import { join, PATH_SEP } from "../../src/core/dirs";
import type { FsBridge } from "../../src/core/fsbridge";

/** 记录写入的内存替身：exists 由 files 决定，writeText 落进 files 并留痕 */
function memFs(files: Record<string, string> = {}) {
  const writes: { path: string; content: string }[] = [];
  const fs = {
    async exists(p: string) {
      return p in files;
    },
    async writeText(p: string, content: string) {
      files[p] = content;
      writes.push({ path: p, content });
    },
  } as unknown as FsBridge;
  return { fs, files, writes };
}

describe("内置技能资产", () => {
  it("随包资产非空，且每个技能的 SKILL.md 都在（A-8：不再是死资产）", () => {
    const rels = Object.keys(BUILTIN_SKILL_FILES);
    expect(rels.length).toBeGreaterThan(0);
    for (const name of BUILTIN_SKILL_NAMES) {
      expect(rels).toContain(`${name}/SKILL.md`);
      expect(BUILTIN_SKILL_FILES[`${name}/SKILL.md`].length).toBeGreaterThan(0);
    }
  });

  it("资产目录集合 = 内置名单（新增随包技能忘了登记会被这条挡住）", () => {
    const dirs = [...new Set(Object.keys(BUILTIN_SKILL_FILES).map((r) => r.split("/")[0]))].sort();
    expect(dirs).toEqual([...BUILTIN_SKILL_NAMES].sort());
  });

  it("token-optimizer 的 scripts 一并随包（脚本要能被执行）", () => {
    expect(BUILTIN_SKILL_FILES["token-optimizer/scripts/token_audit.py"]).toBeTruthy();
    expect(BUILTIN_SKILL_FILES["token-optimizer/scripts/cache_check.py"]).toBeTruthy();
  });

  it("不把 __pycache__/.pyc 当资产（本机编译产物不该随包）", () => {
    expect(Object.keys(BUILTIN_SKILL_FILES).some((r) => r.includes("__pycache__"))).toBe(false);
    expect(Object.keys(BUILTIN_SKILL_FILES).some((r) => r.endsWith(".pyc"))).toBe(false);
  });
});

/**
 * 对话密度回归锁（2026-10-11 维护批次）。
 *
 * 背景（真实缺陷，非推测）：作品《和小熊同居后的日子》第 34 章起对话被压成
 * 「几天。」「两天。」「排好了。」这类两三个字一问一答（电报体），第 47 章候选稿
 * 短台词占比达 46.7%。根因是**规则梯度单向指向压缩**：novel-deslop 的段落指引被
 * 读成句子长度上限、对话条目只有「删什么」没有「不能删什么」，
 * 加上「人人同腔」把「说话完整」列成病症信号，模型便把完整台词主动打碎。
 *
 * 这三条锁把修复钉住：若将来有人把"上限"写回段落指引、删掉对话下限、
 * 或把「一样完整」恢复成病症措辞，测试即失败。
 */
describe("对话密度契约（电报体回归锁）", () => {
  const deslop = () => BUILTIN_SKILL_FILES["novel-deslop/SKILL.md"];
  const writer = () => BUILTIN_SKILL_FILES["novel-writer/SKILL.md"];

  it("段落指引是节奏建议，不得写成单句长度上限（「每段不超过3句」是已修复的缺陷措辞）", () => {
    expect(deslop()).not.toContain("每段不超过3句");
    expect(deslop()).toContain("这是段落");
    expect(deslop()).toContain("不设单句长度上限");
  });

  it("对话条目必须同时给出下限：电报体是缺陷，不能只教「删」", () => {
    // 反向失真条目本身要在
    expect(deslop()).toContain("电报体");
    expect(deslop()).toContain("过度压缩本身就是缺陷");
    // 且不能把「说话完整」当成病症：该改的是「人人都一样」
    expect(deslop()).toContain("要改的是「人人都一样」，不是「句子完整」");
  });

  it("主线技能铁律写明对话下限，并点名段落指引不传导到单句", () => {
    expect(writer()).toContain("对话写完整，压缩是缺陷");
    expect(writer()).toContain("不设单句长度上限");
  });
});

describe("releaseBuiltinSkills", () => {
  /**
   * 资产键（`FIXTURE` 的键）是**协议格式**：'/' 分隔、相对技能根 —— 平台无关，逐字不动。
   * 技能根 `SKILLS` 只是**输入夹具**；落盘键的期望值一律用被测代码自己的 `join` 构造，
   * 于是 Windows 期望 `C:\skills\alpha\SKILL.md`、macOS 期望 `C:/skills/alpha/SKILL.md`，
   * 两平台验证的是同一条语义（"释放到 <技能根>/<技能名>/<技能内相对路径>"）。
   */
  const SKILLS = "C:\\skills";
  const at = (...segs: string[]) => join(SKILLS, ...segs);
  const FIXTURE = {
    "alpha/SKILL.md": "---\nname: alpha\n---\n",
    "alpha/references/guide.md": "guide body",
    "beta/SKILL.md": "---\nname: beta\n---\n",
  };

  it("技能缺失时逐文件释放（含子目录）", async () => {
    const { fs, files, writes } = memFs();
    const released = await releaseBuiltinSkills(fs, SKILLS, FIXTURE);
    expect(released).toEqual(["alpha", "beta"]);
    expect(files[at("alpha", "SKILL.md")]).toBe(FIXTURE["alpha/SKILL.md"]);
    expect(files[at("alpha", "references", "guide.md")]).toBe("guide body");
    expect(writes.length).toBe(3);
  });

  it("已有 SKILL.md 的技能整体跳过（用户副本是最高权威，升级也不覆盖）", async () => {
    const { fs, files, writes } = memFs({ [at("alpha", "SKILL.md")]: "user edited" });
    const released = await releaseBuiltinSkills(fs, SKILLS, FIXTURE);
    expect(released).toEqual(["beta"]); // alpha 跳过，beta 仍补齐
    expect(files[at("alpha", "SKILL.md")]).toBe("user edited");
    expect(writes.some((w) => w.path.startsWith(at("alpha") + PATH_SEP))).toBe(false);
  });

  it("单个技能写失败不阻断其余技能", async () => {
    const { fs, files } = memFs();
    const boom = {
      ...FIXTURE,
    };
    const originalWrite = fs.writeText;
    (fs as unknown as { writeText: FsBridge["writeText"] }).writeText = async (p, c) => {
      if (p.includes(PATH_SEP + "alpha" + PATH_SEP)) throw new Error("disk full");
      return originalWrite(p, c);
    };
    const released = await releaseBuiltinSkills(fs, SKILLS, boom);
    expect(released).toEqual(["beta"]);
    expect(files[at("beta", "SKILL.md")]).toBeTruthy();
  });

  it("路径穿越与编译产物不进释放清单", async () => {
    const { fs, files } = memFs();
    const released = await releaseBuiltinSkills(fs, SKILLS, {
      "../evil/SKILL.md": "x",
      "alpha/../../evil.md": "x",
      "alpha/SKILL.md": "ok",
      "alpha/__pycache__/x.pyc": "junk",
      "loose.md": "not a skill",
    });
    expect(released).toEqual(["alpha"]);
    expect(Object.keys(files)).toEqual([at("alpha", "SKILL.md")]);
  });

  it("空资产集不报错", async () => {
    const { fs } = memFs();
    expect(await releaseBuiltinSkills(fs, SKILLS, {})).toEqual([]);
  });
});
