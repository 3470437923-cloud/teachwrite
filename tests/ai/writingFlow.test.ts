import { describe, expect, it, vi } from "vitest";
import { WRITE_NEXT_MESSAGE, adoptMessage, adoptAfterSave } from "../../src/ui/MainWorkbench";
import { BUILTIN_SKILL_FILES } from "../../src/core/skills/builtin";
import { buildReflowPrompt } from "../../src/core/ai/reflow";
import { diffLines } from "../../src/core/store/oplog";

describe("采用前保存", () => {
  it("保存异步完成后才采用磁盘上的用户最新稿", async () => {
    let disk = "旧稿";
    let finishSave!: () => void;
    const save = () => new Promise<boolean>((resolve) => {
      finishSave = () => { disk = "用户最新稿"; resolve(true); };
    });
    const adopt = vi.fn(async () => { expect(disk).toBe("用户最新稿"); });
    const task = adoptAfterSave(save, adopt);
    expect(adopt).not.toHaveBeenCalled();
    finishSave();
    expect(await task).toBe(true);
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it("保存失败时不发送采用，也不执行采用阶段的结束编辑", async () => {
    const adopt = vi.fn(async () => {});
    expect(await adoptAfterSave(async () => false, adopt)).toBe(false);
    expect(adopt).not.toHaveBeenCalled();
  });
});

describe("作者手写与采用资料提示契约", () => {
  it("默认快捷只提供目标讨论，正式导览通过专用入口", () => {
    expect(WRITE_NEXT_MESSAGE).toContain("只做讨论");
    expect(WRITE_NEXT_MESSAGE).toContain("不写正文、对白、示范或替代句");
    expect(WRITE_NEXT_MESSAGE).not.toContain("第N章-v1-初稿.md");
    expect(WRITE_NEXT_MESSAGE).not.toContain("第N章-v2-候选.md");
    expect(WRITE_NEXT_MESSAGE).toContain("正式导览由我使用右侧的生成入口发起");
  });

  it("内置主线与技能参考声明作者正文边界并保留旧稿兼容", () => {
    const skill = BUILTIN_SKILL_FILES["novel-writer/SKILL.md"];
    const reference = BUILTIN_SKILL_FILES["novel-writer/references/templates.md"];
    for (const text of [skill, reference]) {
      expect(text).toContain("作者");
      expect(text).toContain("正文");
      expect(text).toMatch(/禁止|不得|不生成/);
      expect(text).not.toContain("初稿永远保留");
      expect(text).not.toContain("初稿：`第N章-v1-初稿.md`（永久保留）");
    }
  });

  it("采用指定版本无需重复确认，仍保留中断恢复与不重复累计", () => {
    const prompt = adoptMessage("待确认\\第3章-候选.md");
    expect(prompt).toContain("待确认/第3章-候选.md");
    expect(prompt).toContain("不重复确认");
    expect(prompt).toContain("中断先补余项");
    expect(prompt).toContain("不重复累计");
  });

  it("回流没有可复用判断就不创建学习记录，无问题简短回执", () => {
    const prompt = buildReflowPrompt({ relPath: "待确认/第3章-候选.md", kind: "candidate", chapterLabel: "第3章", diff: diffLines("他停下。", "他转过身。") });
    expect(prompt).toContain("没有可复用判断时不创建");
    expect(prompt).toContain("无问题时简短回执");
    expect(prompt).not.toContain("三五句话");
  });
});
