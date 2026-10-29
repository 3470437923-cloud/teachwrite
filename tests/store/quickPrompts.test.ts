/** 快捷提示词（B17）的回归锁：容错解析、播种语义、序列化往返。 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeFs } from "../support/nodeFs";
import {
  DEFAULT_QUICK_PROMPTS,
  loadQuickPrompts,
  newQuickPromptId,
  parseQuickPrompts,
  saveQuickPrompts,
} from "../../src/core/store/quickPrompts";

describe("quickPrompts：解析与持久化", () => {
  it("损坏/空/形态不对 → 回落默认清单（不抛错）", () => {
    expect(parseQuickPrompts("不是 JSON").map((p) => p.id)).toEqual(DEFAULT_QUICK_PROMPTS.map((p) => p.id));
    expect(parseQuickPrompts("").length).toBe(DEFAULT_QUICK_PROMPTS.length);
    expect(parseQuickPrompts('{"prompts":"不是数组"}').length).toBe(DEFAULT_QUICK_PROMPTS.length);
  });

  it("坏条目跳过；label 缺失时用 text 前 12 字顶替", () => {
    const out = parseQuickPrompts(
      JSON.stringify({ version: 1, prompts: [null, { id: "a", text: "正文" }, { id: "b", label: "有名", text: "t" }] }),
    );
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
    expect(out[0].label).toBe("正文");
    expect(out[1].label).toBe("有名");
  });

  it("默认快捷词只讨论写作目标，正式导览走受归档门保护的专用入口", () => {
    const first = DEFAULT_QUICK_PROMPTS[0];
    expect(first.id).toBe("write-next"); // 原id兼容作者已存的快捷词
    expect(first.label).toBe("梳理本章写作目标");
    expect(first.text).toContain("只做讨论");
    expect(first.text).toContain("不写正文、对白、示范或替代句");
    expect(first.text).toContain("正式导览由我使用右侧的生成入口发起");
    expect(first.text).not.toContain("第N章-候选.md");
  });
});

describe("quickPrompts：读写盘", () => {
  let dir: string;
  let file: string;
  const fs = createNodeFs();

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "deepcompose-qp-"));
    file = path.join(dir, "writerd_quick_prompts.json");
  });
  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("文件缺失 → null（调用方据此播种）；播种后读回默认清单", async () => {
    expect(await loadQuickPrompts(fs, file)).toBeNull();
    await saveQuickPrompts(fs, file, DEFAULT_QUICK_PROMPTS);
    const loaded = await loadQuickPrompts(fs, file);
    expect(loaded?.map((p) => p.id)).toEqual(DEFAULT_QUICK_PROMPTS.map((p) => p.id));
  });

  it("用户增删后往返一致；id 不撞", async () => {
    await saveQuickPrompts(fs, file, [{ id: "x", label: "甲", text: "内容甲" }]);
    const loaded = await loadQuickPrompts(fs, file);
    expect(loaded).toEqual([{ id: "x", label: "甲", text: "内容甲" }]);
    expect(newQuickPromptId()).not.toBe(newQuickPromptId());
  });
});
