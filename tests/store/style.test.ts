/**
 * L1/L2 回归锁：资料形态契约与体检（D-038 / docs/MATERIALS-STYLE.md）。
 *
 * 锁三件事：
 *  1. 体检规则本身（体量、框线、emoji、过程标注、表格占比、装饰线、超长行、人物库条目）；
 *  2. **模板必须在预算内**（新建作品不该一出生就报形态警告）；
 *  3. 预算表与技能资产里的表**不漂移**（模型读的是技能资产，判据是代码）。
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeFs } from "../support/nodeFs";
import {
  CAST_ENTRY_MAX_LINES,
  MATERIAL_BUDGETS,
  auditMaterials,
  budgetOf,
  checkMaterial,
  materialsSummary,
  measureMaterial,
} from "../../src/core/store/style";
import { DOC_TEMPLATES, XIGANG_DOC_SAMPLE } from "../../src/core/store/templates";
import { parseProjectStatus } from "../../src/core/store/status";
import { countForeshadowing } from "../../src/core/store/tracking";
import { sectionBody } from "../../src/core/store/markdown";
import { createProject, validateProject } from "../../src/core/store/project";

const ASCII_ART = [
  "# 世界观",
  "",
  "```",
  "┌──────────────┐",
  "│ 红佛龛       │",
  "└──────┬───────┘",
  "       │ 合作",
  "┌──────▼──────┐",
  "│ 华北生物所  │",
  "└─────────────┘",
  "```",
].join("\n");

describe("measureMaterial", () => {
  it("框线字符、箭头、装饰线、过程标注、表格行都能数出来", () => {
    const m = measureMaterial(ASCII_ART);
    expect(m.boxDrawing).toBeGreaterThan(10);
    expect(m.arrows).toBe(0);

    const mixed = measureMaterial(
      [
        "# 标题",
        "（约5500字）**一、场景**：他走向门口 → 门开了。",
        "---",
        "| A | B |",
        "| 1 | 2 |",
        "（约1200字）",
        "导入说明：本文件由源细纲重建。",
      ].join("\n"),
    );
    expect(mixed.processNotes).toBe(1); // 只计导入说明，场景篇幅计划不是过程记录
    expect(mixed.hrLines).toBe(1);
    expect(mixed.tableLines).toBe(2);
    expect(mixed.arrows).toBe(1);
    expect(mixed.boldPairs).toBe(1);
    expect(mixed.tableRatio).toBeCloseTo(2 / 7, 5);
  });

  it("空文档与纯散文安全返回", () => {
    expect(measureMaterial("").chars).toBe(0);
    const prose = measureMaterial("他推开门，屋里没有人。");
    expect(prose.boxDrawing).toBe(0);
    expect(prose.tableRatio).toBe(0);
  });
});

describe("checkMaterial：逐条判据", () => {
  it("超预算 → warn，并带上职责与倍数", () => {
    const long = "正文".repeat(2000); // 4000 字符
    const issues = checkMaterial("00-项目状态.md", long);
    const over = issues.find((i) => i.check === "material-over-budget");
    expect(over?.level).toBe("warn");
    expect(over?.message).toContain("超出预算 1500");
    expect(over?.message).toContain("不自动删除或改写");
  });

  it("场景篇幅计划不被当成过程记录，真正导入记录仍提示", () => {
    const plan = "# 滚动细纲\n## 第2章\n- 主要场面：门口争执（约1200字），返家（300字）。";
    expect(checkMaterial("05-滚动细纲.md", plan)).toEqual([]);
    expect(measureMaterial(plan).processNotes).toBe(0);
    expect(checkMaterial("05-滚动细纲.md", plan + "\n核对证据：源文件第2章")
      .some((issue) => issue.check === "material-process-notes")).toBe(true);
  });

  it("框线图 / emoji / 过程标注 / 表格占比 各自成条", () => {
    expect(checkMaterial("02-核心设定.md", ASCII_ART).some((i) => i.check === "material-box-drawing")).toBe(true);
    expect(checkMaterial("02-核心设定.md", "设定 ✅ 完成").some((i) => i.check === "material-emoji")).toBe(true);
    expect(
      checkMaterial("05-滚动细纲.md", "（约3000字）导入说明").some((i) => i.check === "material-process-notes"),
    ).toBe(true);
    const tableHeavy = Array.from({ length: 8 }, () => "| a | b |").join("\n") + "\n" + "句子。";
    expect(
      checkMaterial("03-全书大纲.md", tableHeavy).some((i) => i.check === "material-table-ratio"),
    ).toBe(true);
  });

  it("追踪表兼容存量矩阵，不因新模板默认自然段而误报", () => {
    const matrix = "# 追踪-伏笔\n" + Array.from({ length: 40 }, (_, i) => `| F00${i} | 第1章 | 第9章 | 已回收 |`).join("\n");
    expect(checkMaterial("追踪-伏笔.md", matrix).some((i) => i.check === "material-table-ratio")).toBe(false);
  });

  it("装饰分节线与超长行只给 info（不误判成错）", () => {
    const doc = "---\n---\n---\n" + "很长的一行".repeat(200);
    const issues = checkMaterial("01-开书定位.md", doc);
    expect(issues.find((i) => i.check === "material-hr-lines")?.level).toBe("info");
    expect(issues.find((i) => i.check === "material-long-line")?.level).toBe("info");
  });

  it("自然段模板不带非必需列表或装饰，固定字段例外保留", () => {
    for (const { name, content } of DOC_TEMPLATES) {
      expect(content, name).toMatch(/^# /);
      expect(content, name).not.toMatch(/^>|^\||\*\*|[→←／]|^---$/m);
      // 机器字段文档（00/01/02/追踪）+ 06 的 SR 规则块（### SR-编号 + 三行字段）是例外：
      // 它们的 `- 键：值` 是被解析的结构，不是「非必需列表」
      const machineFields = /^(00-|01-|02-|追踪-)/.test(name) || name === "06-写作风格.md";
      if (!machineFields) expect(content, name).not.toMatch(/^[-*+] /m);
    }
    expect(DOC_TEMPLATES.find((t) => t.name === "01-开书定位.md")!.content.match(/^- /gm)).toHaveLength(7);
    expect(DOC_TEMPLATES.find((t) => t.name === "02-核心设定.md")!.content.match(/^- /gm)).toHaveLength(3);
  });

  it("新模板仍可读状态、计伏笔、按标题定位自然段", () => {
    const textOf = (name: string) => DOC_TEMPLATES.find((t) => t.name === name)!.content;
    expect(parseProjectStatus(textOf("00-项目状态.md"))).toMatchObject({
      stage: "开书准备", chapter: "第000章", progress: "未开始",
    });
    // 00 声明启用模块（默认全启用），可被结构化读取
    expect(parseProjectStatus(textOf("00-项目状态.md")).modules).toEqual([
      "伏笔", "角色状态", "时间线", "资源与权限", "废弃设定",
    ]);
    const foreshadow = textOf("追踪-伏笔.md");
    expect(countForeshadowing(foreshadow)).toMatchObject({ open: 0, collected: 0, dropped: 0, unclassified: 1 });
    const active = foreshadow.replace(/^- 状态：.*$/m, "- 状态：开放");
    expect(countForeshadowing(active)).toMatchObject({ open: 1, unclassified: 0 });
    expect(sectionBody(textOf("人物库.md"), "人物名（模板，新建人物时复制本条目）"))
      .toContain("说话习惯与压力反应：待填写");
    // 细纲样例（不随作品创建，技能与测试引用的结构范本）
    expect(sectionBody(XIGANG_DOC_SAMPLE, "第N章 章名待定")).toContain("主要场面：待填写");
  });

  it("模板形态本身零提示（这是契约的基准形态）", () => {
    for (const t of DOC_TEMPLATES) {
      const issues = checkMaterial(t.name, t.content);
      expect(issues, `${t.name} 不应有形态提示：${JSON.stringify(issues)}`).toEqual([]);
    }
  });
});

describe("人物库条目与汇总", () => {
  it("单条目字段行超过上限 → 聚合成一条 info（不逐人刷屏）", () => {
    const entry = ["# 人物库", "## 陆存", ...Array.from({ length: 8 }, (_, i) => `- 特征${i}：x`)].join("\n");
    const issues = auditMaterials([{ name: "人物库.md", text: entry }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("info");
    expect(issues[0].check).toBe("material-shape");
    expect(issues[0].message).toContain("超长条目 1 个");
  });

  it("模板形态的人物库条目（6 字段 + 说明句）不误报", () => {
    const tpl = DOC_TEMPLATES.find((t) => t.name === "人物库.md")!;
    expect(auditMaterials([{ name: "人物库.md", text: tpl.content }])).toEqual([]);
    expect(CAST_ENTRY_MAX_LINES).toBe(6);
  });

  it("按文件聚合：一份文件最多一条，明细进短标签", () => {
    const issues = auditMaterials([{ name: "世界观.md", text: ASCII_ART + "\n✅ 完成\n导入说明：由旧资料核对。" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe("material-shape");
    expect(issues[0].level).toBe("warn");
    expect(issues[0].message).toContain("框线字符");
    expect(issues[0].message).toContain("装饰符号");
    expect(issues[0].message).toContain("过程性标注");
  });

  it("materialsSummary 给出总量与警告数", () => {
    expect(materialsSummary([{ name: "01-开书定位.md", text: "正常内容" }])).toContain("形态无提示");
    expect(materialsSummary([{ name: "02-核心设定.md", text: ASCII_ART }]).includes("形态警告")).toBe(true);
  });
});

describe("预算表完整性", () => {
  it("新结构 12 件每一份都有预算条目（新增模板不许无预算）", () => {
    for (const t of DOC_TEMPLATES) {
      expect(MATERIAL_BUDGETS[t.name], `${t.name} 缺预算登记`).toBeTruthy();
    }
  });

  it("未登记文档回落到附加文档默认预算", () => {
    expect(budgetOf("世界观.md").maxChars).toBe(8000);
    expect(budgetOf("追踪-伏笔.md").maxChars).toBe(20000);
  });

  it("技能资产 references/templates.md 的预算表与代码一致（防漂移）", async () => {
    const url = new URL("../../assets/builtin-skills/novel-writer/references/templates.md", import.meta.url);
    const text = await fsp.readFile(url, "utf8");
    const rows = [...text.matchAll(/\|\s*`([^`]+\.md)`\s*\|\s*([\d,]+)\s*\|/g)].map((m) => [
      m[1],
      Number(m[2].replace(/,/g, "")),
    ]) as [string, number][];
    expect(rows.length).toBeGreaterThanOrEqual(14);
    for (const [name, maxChars] of rows) {
      expect(MATERIAL_BUDGETS[name], `技能文档里的 ${name} 不在代码预算表中`).toBeTruthy();
      expect(MATERIAL_BUDGETS[name].maxChars, `${name} 预算不一致`).toBe(maxChars);
    }
  });
});

describe("validateProject 接线（打开作品即体检）", () => {
  let booksRoot: string;
  const fs = createNodeFs();

  beforeAll(async () => {
    booksRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "deepcompose-style-"));
  });
  afterAll(async () => {
    if (booksRoot) await fsp.rm(booksRoot, { recursive: true, force: true });
  });

  it("新建作品不产生形态警告（模板都在预算内）", async () => {
    const ref = await createProject(fs, booksRoot, "形态基准样本");
    const issues = await validateProject(fs, ref.root);
    expect(issues.filter((i) => i.check.startsWith("material-") && i.level === "warn")).toEqual([]);
  });

  it("塞进 ASCII 图与超长文档 → 作品校验报出形态警告", async () => {
    const ref = await createProject(fs, booksRoot, "形态超标样本");
    await fsp.writeFile(path.join(ref.root, "小说资料", "世界观.md"), ASCII_ART, "utf8");
    await fsp.writeFile(
      path.join(ref.root, "小说资料", "00-项目状态.md"),
      "# 项目状态\n- 当前阶段：开书准备\n\n## 导入说明与遗疵\n（约5500字）导入说明：本文件由源细纲重建。\n" + "填充".repeat(1000),
      "utf8",
    );
    const issues = await validateProject(fs, ref.root);
    const shape = issues.filter((i) => i.check === "material-shape");
    expect(shape.length).toBeGreaterThan(0);
    expect(shape.every((i) => i.level === "warn")).toBe(true);
    const joined = shape.map((i) => i.message).join("\n");
    expect(joined).toContain("框线字符");
    expect(joined).toContain("过程性标注");
    expect(joined).toContain("超预算");
  });
});
