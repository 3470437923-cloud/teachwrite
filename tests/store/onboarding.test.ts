/**
 * 开书引导（onboarding）的回归锁。
 *
 * 锁三条契约（违反任意一条就是产品事故）：
 *   1. 只替换 `- 字段名：待填写` 整行，绝不动模板的其它行、其它文档；
 *   2. 留空答案 = 保留「待填写」占位（空白开书与原行为逐字节一致）；
 *   3. 覆盖内容仍走 createProject 的同一个 renderTemplate 出口
 *      （{书名} 占位被替换、行尾统一 CRLF）——磁盘格式只有一条生产线。
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeFs } from "../support/nodeFs";
import {
  EMPTY_ONBOARDING,
  fillTemplateField,
  onboardingOverrides,
  suggestModules,
} from "../../src/core/store/onboarding";
import { createProject } from "../../src/core/store/project";
import {
  CORE_SETTING_DOC,
  DOC_TEMPLATES,
  POSITIONING_DOC,
  renderTemplate,
} from "../../src/core/store/templates";

const tpl = (name: string) => DOC_TEMPLATES.find((t) => t.name === name)!;

describe("fillTemplateField（单行定向替换）", () => {
  it("替换「- 标签：待填写」整行为答案", () => {
    const out = fillTemplateField(tpl(POSITIONING_DOC).content, "一句话故事", "少年下山复仇");
    expect(out).toContain("- 一句话故事：少年下山复仇");
    expect(out).not.toContain("- 一句话故事：待填写");
  });

  it("空答案与纯空白答案原样返回（保留待填写占位）", () => {
    const src = tpl(POSITIONING_DOC).content;
    expect(fillTemplateField(src, "一句话故事", "")).toBe(src);
    expect(fillTemplateField(src, "一句话故事", "   ")).toBe(src);
  });

  it("标签不存在时原样返回（模板改版宁可填不上，不硬塞）", () => {
    const src = tpl(POSITIONING_DOC).content;
    expect(fillTemplateField(src, "不存在的字段", "值")).toBe(src);
  });

  it("多行答案压成一行（模板字段一行一条，换行用「；」接上）", () => {
    const out = fillTemplateField(tpl(POSITIONING_DOC).content, "一句话故事", "第一行\n第二行");
    expect(out).toContain("- 一句话故事：第一行；第二行");
    // 压行后文档行数不变（没有意外增行破坏模板结构）
    expect(out.split("\n").length).toBe(tpl(POSITIONING_DOC).content.split("\n").length);
  });

  it("只动目标行：其它「待填写」字段保持原样", () => {
    const src = tpl(POSITIONING_DOC).content;
    const out = fillTemplateField(src, "一句话故事", "x");
    expect(out).toContain("- 目标平台与读者：待填写");
    expect(out).toContain("- 主类型与最想带给读者的感受：待填写");
  });
});

describe("suggestModules（按类型建议追踪模块，D-043）", () => {
  it("言情等一般类型：只建议角色状态（用户原话：言情要什么伏笔追踪）", () => {
    expect(suggestModules({ genre: "现代言情 · 甜宠日常" })).toEqual(["角色状态"]);
    expect(suggestModules({ genre: "" })).toEqual(["角色状态"]);
    expect(suggestModules({ genre: "东方玄幻" })).toEqual(["角色状态"]);
  });

  it("强情节类型：加伏笔与时间线", () => {
    expect(suggestModules({ genre: "悬疑推理" })).toEqual(["伏笔", "角色状态", "时间线"]);
    expect(suggestModules({ genre: "谍战风云" })).toEqual(["伏笔", "角色状态", "时间线"]);
    expect(suggestModules({ genre: "无限流恐怖" })).toEqual(["伏笔", "角色状态", "时间线"]);
  });
});

describe("onboardingOverrides（答案 → 文档覆盖）", () => {
  it("全空答案：无覆盖（与空白开书逐字节一致）", () => {
    expect(onboardingOverrides({ ...EMPTY_ONBOARDING }).size).toBe(0);
  });

  it("定位类答案只进 01-开书定位，设定类只进 02-核心设定", () => {
    const a = {
      ...EMPTY_ONBOARDING,
      premise: "一句话",
      genre: "玄幻 · 热血",
      world: "架空古代",
      conflict: "复仇线与登顶",
    };
    const ov = onboardingOverrides(a);
    expect(ov.size).toBe(2);
    const pos = ov.get(POSITIONING_DOC)!;
    expect(pos).toContain("- 一句话故事：一句话");
    expect(pos).toContain("- 主类型与最想带给读者的感受：玄幻 · 热血");
    expect(pos).not.toContain("架空古代"); // 02 的答案不该串进 01
    expect(pos).toContain("- 开局发生的具体事件：待填写"); // 没答的字段保持占位
    const core = ov.get(CORE_SETTING_DOC)!;
    expect(core).toContain("- 时代、地点与本阶段环境：架空古代");
    expect(core).toContain("- 核心冲突与结局方向：复仇线与登顶");
    expect(core).toContain("- 关键能力、职业、技术或制度：待填写");
  });

  it("只填一个字段时只覆盖一份文档", () => {
    const ov = onboardingOverrides({ ...EMPTY_ONBOARDING, world: "近未来" });
    expect(ov.size).toBe(1);
    expect(ov.has(CORE_SETTING_DOC)).toBe(true);
  });
});

describe("createProject + overrides（落盘集成）", () => {
  let booksRoot: string;
  const fs = createNodeFs();

  beforeAll(async () => {
    booksRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "deepcompose-onboarding-"));
  });
  afterAll(async () => {
    if (booksRoot) await fsp.rm(booksRoot, { recursive: true, force: true });
  });

  it("引导答案在创建那一刻落盘：替换值 + {书名} 占位 + CRLF 一个都不少", async () => {
    const answers = { ...EMPTY_ONBOARDING, premise: "少年下山复仇", world: "架空古代" };
    const ref = await createProject(fs, booksRoot, "引导书", onboardingOverrides(answers));
    const pos = await fsp.readFile(path.join(ref.root, "小说资料", POSITIONING_DOC), "utf8");
    expect(pos).toContain("- 一句话故事：少年下山复仇");
    expect(pos).toMatch(/^暂定书名：引导书\r?$/m); // 非引导字段用自然段，{书名} 仍须替换
    expect(pos).toContain("- 目标平台与读者：待填写"); // 没答的保持占位
    expect(pos).toContain("\r\n"); // 磁盘格式：CRLF
    expect(pos).not.toMatch(/[^\r]\n/); // 没有孤 LF
    const core = await fsp.readFile(path.join(ref.root, "小说资料", CORE_SETTING_DOC), "utf8");
    expect(core).toContain("- 时代、地点与本阶段环境：架空古代");
  });

  it("不传 overrides：新结构 12 件与空白模板逐字节一致", async () => {
    const ref = await createProject(fs, booksRoot, "空白书");
    for (const t of DOC_TEMPLATES) {
      const disk = await fsp.readFile(path.join(ref.root, "小说资料", t.name), "utf8");
      expect(disk).toBe(renderTemplate(t.content, "空白书"));
    }
  });
});
