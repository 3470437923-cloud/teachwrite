/**
 * 资料表格视图（B7）的回归锁：解析正确性、节级回落、类型默认视图。
 * 2026-10-06 全覆盖改造新增：通用回落（任何文档都有视图）、CellAddr 落点、
 * applyCellEdit / applyRangeDelete / applyInsertBlock 的行级手术往返。
 */
import { describe, expect, it } from "vitest";
import {
  COLUMN_WEIGHTS,
  applyCellEdit,
  applyInsertBlock,
  applyRangeDelete,
  buildEntryBlock,
  columnWeightsFor,
  defaultTableView,
  docTableFor,
  hasRealTable,
  type CellAddr,
} from "../../src/core/store/doctable";
import { DOC_TEMPLATES, TRACKER_MODULES, XIGANG_DOC_SAMPLE } from "../../src/core/store/templates";

/** 取第一个 grid 部分（类型收窄小帮手） */
function gridOf(t: ReturnType<typeof docTableFor>) {
  const g = t.parts.find((p) => p.kind === "grid");
  if (!g || g.kind !== "grid") throw new Error("no grid part");
  return g;
}

describe("docTableFor：各文档的表格化", () => {
  it("00-项目状态：头部字段与固定节都成 kv", () => {
    const t = docTableFor("00-项目状态.md", DOC_TEMPLATES.find((x) => x.name === "00-项目状态.md")!.content)!;
    const kv = t.parts.filter((p) => p.kind === "kv");
    expect(kv.length).toBeGreaterThanOrEqual(2); // 头部 + 各节
    const header = kv[0];
    if (header.kind !== "kv") throw new Error("unexpected");
    expect(header.rows.some((r) => r.label === "启用模块")).toBe(true);
  });

  it("追踪-伏笔：统计块成 kv、条目成 grid、状态列在", () => {
    const tpl = TRACKER_MODULES.find((m) => m.key === "伏笔")!.template;
    const t = docTableFor("追踪-伏笔.md", tpl.content)!;
    const kv = t.parts.find((p) => p.kind === "kv");
    expect(kv && kv.kind === "kv" && kv.title?.startsWith("伏笔统计")).toBe(true);
    const grid = t.parts.find((p) => p.kind === "grid");
    expect(grid && grid.kind === "grid" && grid.columns).toContain("状态");
    expect(grid && grid.kind === "grid" && grid.rows[0].cells[0]).toContain("F001");
  });

  it("人物库：每人一块 kv 卡；说明段以 prose 呈现", () => {
    const tpl = DOC_TEMPLATES.find((x) => x.name === "人物库.md")!;
    const t = docTableFor("人物库.md", tpl.content)!;
    const kv = t.parts.find((p) => p.kind === "kv" && p.title?.includes("人物名"));
    expect(kv).toBeTruthy();
    expect(t.parts.some((p) => p.kind === "prose")).toBe(true);
  });

  it("04-粗纲：弧段标题拆出范围与卷名", () => {
    const t = docTableFor("04-粗纲.md", "# 粗纲\n\n## 第1-20章 起步\n一段话。\n")!;
    const grid = t.parts[0];
    if (grid.kind !== "grid") throw new Error("unexpected");
    expect(grid.rows[0].cells).toEqual(["第1-20章", "起步", "一段话。"]);
  });

  it("细纲：头部字段 kv + 每章一行 grid", () => {
    const t = docTableFor("第1-3章细纲.md", XIGANG_DOC_SAMPLE)!;
    expect(t.parts.some((p) => p.kind === "kv")).toBe(true);
    const grid = t.parts.find((p) => p.kind === "grid");
    expect(grid && grid.kind === "grid" && grid.columns).toEqual(["章", "承接与目标", "主要场面", "依据与约束", "变化与章尾"]);
  });

  it("06-写作风格：禁用列表成行；旧的自然段「风格规则」仍是散文（向后兼容）", () => {
    const t = docTableFor("06-写作风格.md", "# 写作风格\n## 风格规则\n第一人称。\n\n## 禁用列表\n- 禁止：滥用「不禁」（来源：用户指定）\n")!;
    const grid = t.parts.find((p) => p.kind === "grid");
    expect(grid && grid.kind === "grid" && grid.rows[0].cells[0]).toBe("滥用「不禁」");
    expect(grid && grid.kind === "grid" && grid.rows[0].cells[1]).toBe("用户指定");
    expect(t.parts.some((p) => p.kind === "prose")).toBe(true);
  });

  it("06-写作风格：新格式 ### SR-编号 块成四列 grid", () => {
    const text = [
      "# 写作风格",
      "## 风格规则",
      "",
      "### SR-001",
      "- 规则分类：视角",
      "- 规则来源：用户指定",
      "- 具体内容：第三人称有限视角。",
      "",
      "### SR-002",
      "- 规则分类：对话",
      "- 规则来源：手改回流·GL-011",
      "- 具体内容：台词写完整，不设字数上限。",
      "",
      "## 禁用列表",
      "- 禁止：破折号（来源：用户指定）",
      "",
    ].join("\n");
    const t = docTableFor("06-写作风格.md", text)!;
    const grids = t.parts.filter((p) => p.kind === "grid");
    expect(grids.length).toBe(2); // 风格规则 + 禁用列表
    const rules = grids[0];
    if (rules.kind !== "grid") throw new Error("unexpected");
    expect(rules.columns).toEqual(["规则编号", "规则分类", "规则来源", "具体内容"]);
    expect(rules.title).toBe("风格规则");
    expect(rules.rows.map((r) => r.cells)).toEqual([
      ["SR-001", "视角", "用户指定", "第三人称有限视角。"],
      ["SR-002", "对话", "手改回流·GL-011", "台词写完整，不设字数上限。"],
    ]);
    // 规则编号 = ### 标题：只读；三个字段都可改
    expect(rules.rows[0].addrs[0]).toBeNull();
    expect(rules.rows[0].addrs.slice(1).every(Boolean)).toBe(true);
    // 旧格式那节没有散文卡了（新格式解析成 grid）
    expect(t.parts.some((p) => p.kind === "prose")).toBe(false);
  });

  it("06-写作风格：改「具体内容」只动该行值，其余逐字节不变", () => {
    const text = "# 写作风格\n## 风格规则\n\n### SR-001\n- 规则分类：视角\n- 规则来源：用户指定\n- 具体内容：旧内容。\n\n## 禁用列表\n暂无。\n";
    const t = docTableFor("06-写作风格.md", text)!;
    const g = t.parts.find((p) => p.kind === "grid");
    if (!g || g.kind !== "grid") throw new Error("no grid");
    const out = applyCellEdit(text, g.rows[0].addrs[3]!, "新内容。");
    expect(out).toContain("- 具体内容：新内容。");
    expect(out).toContain("- 规则分类：视角"); // 键与前缀逐字节保留
    expect(out).toContain("### SR-001");
    expect(out).not.toContain("旧内容。");
  });

  it("06-写作风格：加行生成 ### SR-编号 块（编号续号 + 三字段 + 尾随空行）", () => {
    const text = "# 写作风格\n## 风格规则\n\n### SR-001\n- 规则分类：视角\n- 规则来源：用户指定\n- 具体内容：一。\n\n## 禁用列表\n暂无。\n";
    const t = docTableFor("06-写作风格.md", text)!;
    const g = t.parts.find((p) => p.kind === "grid");
    if (!g || g.kind !== "grid") throw new Error("no grid");
    const block = buildEntryBlock("06-写作风格.md", g.columns, g.rows.map((r) => r.cells[0]))!;
    expect(block).toContain("### SR-002");
    // 绝不能是 h2（会被 docschema 判成「规定以外的节」）——按行首精确判层级
    expect(block.split("\n").find((l) => l.includes("SR-002"))).toBe("### SR-002");
    expect(block).toContain("- 规则分类：待填写");
    expect(block).toContain("- 规则来源：待填写");
    expect(block).toContain("- 具体内容：待填写");
    // 加行 → 重解析：新规则出现在表里，且「禁用列表」节没被吞进规则块
    const out = applyInsertBlock(text, g.appendAt!, block);
    const g2 = gridOf(docTableFor("06-写作风格.md", out));
    expect(g2.rows.map((r) => r.cells[0])).toEqual(["SR-001", "SR-002"]);
    expect(out).toContain("## 禁用列表");
  });

  // ── B22 深度自查回归锁 ──

  it("06-写作风格：禁止项含括号时来源不被截断（贪婪匹配）", () => {
    const text = "# 写作风格\n## 风格规则\n\n### SR-001\n- 规则分类：用词\n- 规则来源：用户指定\n- 具体内容：一。\n\n## 禁用列表\n- 禁止：以「但」转折（频繁时）（来源：用户指定）\n";
    const t = docTableFor("06-写作风格.md", text)!;
    const grids = t.parts.filter((p) => p.kind === "grid");
    const ban = grids.find((g) => g.kind === "grid" && g.columns[0] === "禁止项");
    if (!ban || ban.kind !== "grid") throw new Error("no ban grid");
    // 禁止项应保留「（频繁时）」，来源应是「用户指定」——非贪婪会把第一个「）」当结尾
    expect(ban.rows[0].cells[0]).toBe("以「但」转折（频繁时）");
    expect(ban.rows[0].cells[1]).toBe("用户指定");
  });

  it("06-写作风格：风格规则节内前言（### SR- 之前的说明）成散文卡，不消失", () => {
    const text = [
      "# 写作风格",
      "## 风格规则",
      "一条规则一个 ### SR-编号 块，三行字段。",
      "",
      "### SR-001",
      "- 规则分类：视角",
      "- 规则来源：用户指定",
      "- 具体内容：第三人称。",
      "",
      "## 禁用列表",
      "- 禁止：破折号（来源：用户指定）",
      "",
    ].join("\n");
    const t = docTableFor("06-写作风格.md", text)!;
    const pre = t.parts.find((p) => p.kind === "prose" && p.text.includes("一条规则一个"));
    expect(pre).toBeTruthy(); // 前言没被吞
    const g = t.parts.find((p) => p.kind === "grid" && p.columns[0] === "规则编号");
    if (!g || g.kind !== "grid") throw new Error("no rule grid");
    expect(g.rows.map((r) => r.cells[0])).toEqual(["SR-001"]); // 前言没混进表行
  });

  it("06-写作风格：SR 块一个字段都没有 → 回落散文卡并计数（正文不消失）", () => {
    const text = [
      "# 写作风格",
      "## 风格规则",
      "",
      "### SR-001",
      "- 规则分类：视角",
      "- 规则来源：用户指定",
      "- 具体内容：第三人称。",
      "",
      "### SR-002",
      "这段是纯散文，手改时把字段行删光了，挂在 ### 下。",
      "",
      "## 禁用列表",
      "- 禁止：破折号（来源：用户指定）",
      "",
    ].join("\n");
    const t = docTableFor("06-写作风格.md", text)!;
    const g = t.parts.find((p) => p.kind === "grid" && p.columns[0] === "规则编号");
    if (!g || g.kind !== "grid") throw new Error("no rule grid");
    expect(g.rows.map((r) => r.cells[0])).toEqual(["SR-001"]); // SR-002 不作空行进表
    // SR-002 的散文还在（回落成 prose 卡）
    const orphan = t.parts.find((p) => p.kind === "prose" && p.text.includes("这段是纯散文"));
    expect(orphan).toBeTruthy();
    expect(t.unparsedBlocks).toBe(1); // 顶部回落提示会亮
  });

  it("章节摘要：非章的 ###（如「### 说明」）不当章行吞，走散文", () => {
    const text = [
      "# 章节摘要",
      "",
      "## 原文连续篇章（未设分卷）",
      "",
      "### 第1章 不速之客 摘要",
      "五月，沈逸回到和谐城。",
      "",
      "### 说明",
      "本摘要不再追加。",
      "",
    ].join("\n");
    const t = docTableFor("章节摘要.md", text)!;
    const g = t.parts.find((p) => p.kind === "grid");
    if (!g || g.kind !== "grid") throw new Error("no grid");
    expect(g.rows.map((r) => r.cells[0])).toEqual(["第1章 不速之客"]); // 「说明」没混进章行
    expect(g.rows[0].cells[1]).toContain("五月");
    // 「说明」正文仍在
    expect(t.parts.some((p) => p.kind === "prose" && p.text.includes("本摘要不再追加"))).toBe(true);
  });

  it("节级回落：认不出的块按原文呈现并计数，不拖垮整页", () => {
    const t = docTableFor("追踪-时间线.md", "# 追踪-时间线\n\n## T001\n- 状态：开放\n\n## 随笔\n随手写的散文，没有字段。\n")!;
    expect(t.unparsedBlocks).toBe(1);
    expect(t.parts.some((p) => p.kind === "prose" && p.title === "随笔")).toBe(true);
    expect(t.parts.some((p) => p.kind === "grid")).toBe(true); // T001 照常进表
  });
});

describe("docTableFor：全覆盖（任何文档都有视图，不再返回 null）", () => {
  it("纯叙述文档（03-全书大纲）走通用回落：散文卡", () => {
    const t = docTableFor("03-全书大纲.md", "# 全书大纲\n几段话。\n");
    expect(t.parts.length).toBeGreaterThan(0);
  });

  it("旧结构文件（章节摘要/04-分卷大纲）也有视图", () => {
    expect(docTableFor("章节摘要.md", "# 章节摘要\n- 第一章：捡贝壳。\n").parts.length).toBeGreaterThan(0);
    expect(docTableFor("04-分卷大纲.md", "# 分卷大纲\n\n## 第一卷\n目标。\n").parts.length).toBeGreaterThan(0);
  });

  it("用户自建文档：头部字段成 kv、散文节成卡", () => {
    const t = docTableFor("世界观.md", "# 世界观\n- 时代：架空\n\n## 地理\n南边有海。\n");
    const kv = t.parts.find((p) => p.kind === "kv");
    expect(kv && kv.kind === "kv" && kv.rows.some((r) => r.label === "时代" && r.value === "架空")).toBe(true);
    expect(t.parts.some((p) => p.kind === "prose" && p.title === "地理")).toBe(true);
  });
});

describe("CellAddr 落点：解析出的地址指向原文正确位置", () => {
  it("kv 行的 addr 命中「- 键：值」行，valueCol 之后就是值", () => {
    const text = "# 项目状态\n- 当前阶段：连续写作\n- 当前章节：第5章\n\n## 约定\n约定内容。\n";
    const t = docTableFor("00-项目状态.md", text);
    const kv = t.parts[0];
    if (kv.kind !== "kv") throw new Error("unexpected");
    const row = kv.rows.find((r) => r.label === "当前章节")!;
    const lines = text.split("\n");
    const addr = row.addr!;
    expect(lines[addr.startLine].slice(addr.valueCol!)).toBe("第5章");
  });

  it("追踪表条目格子的 addr 命中字段行；首列（条目名）命中 ## 标题行", () => {
    const text = "# 追踪-伏笔\n\n## F001\n- 内容与涉及对象：贝壳\n- 状态：开放\n";
    const g = gridOf(docTableFor("追踪-伏笔.md", text));
    const row = g.rows[0];
    const lines = text.split("\n");
    const titleAddr = row.addrs[0]!;
    expect(lines[titleAddr.startLine]).toContain("F001");
    const statusAddr = row.addrs[5]!; // columns: 条目/内容与涉及对象/首次出现/当前进展/预计回收/状态/来源
    expect(lines[statusAddr.startLine].slice(statusAddr.valueCol!)).toBe("开放");
    // 整块区间：从 ## 行起到块尾
    expect(row.block!.startLine).toBe(titleAddr.startLine);
  });
});

describe("行级手术：applyCellEdit / applyRangeDelete / applyInsertBlock", () => {
  it("单行值编辑：只动值，前缀与 CRLF 逐字节保留", () => {
    const text = "# 项目状态\r\n- 当前章节：第5章\r\n- 下一步：写\r\n";
    const addr: CellAddr = { startLine: 1, endLine: 2, valueCol: "- 当前章节：".length };
    const out = applyCellEdit(text, addr, "第6章");
    expect(out).toBe("# 项目状态\r\n- 当前章节：第6章\r\n- 下一步：写\r\n");
  });

  it("区间替换（散文块）：区间外字节不变", () => {
    const text = "# 粗纲\n\n## 第1-20章 起步\n旧内容。\n\n## 第21-40章 发展\n别动我。\n";
    const addr: CellAddr = { startLine: 3, endLine: 4, valueCol: null };
    const out = applyCellEdit(text, addr, "新内容。\n两行。");
    expect(out).toContain("新内容。\n两行。");
    expect(out).toContain("## 第21-40章 发展\n别动我。");
    expect(out.startsWith("# 粗纲\n\n## 第1-20章 起步\n")).toBe(true);
  });

  it("落点漂移（行数对不上）：原样返回，不乱写", () => {
    const text = "a\nb\n";
    const out = applyCellEdit(text, { startLine: 9, endLine: 10, valueCol: null }, "x");
    expect(out).toBe(text);
  });

  it("删条目块：整段消失，其余不变", () => {
    const text = "# 追踪-伏笔\n\n## F001\n- 状态：开放\n\n## F002\n- 状态：废弃\n";
    const out = applyRangeDelete(text, { startLine: 2, endLine: 4 });
    expect(out).not.toContain("F001");
    expect(out).toContain("## F002\n- 状态：废弃");
  });

  it("加条目块：插在末尾，与前文分行", () => {
    const text = "# 追踪-伏笔\n\n## F001\n- 状态：开放\n";
    const out = applyInsertBlock(text, 4, "\n## F002\n- 状态：待填写");
    expect(out).toContain("## F002");
    expect(out.indexOf("F001")).toBeLessThan(out.indexOf("F002"));
    // 手术往返：重新解析能看到新条目
    const g = gridOf(docTableFor("追踪-伏笔.md", out));
    expect(g.rows.map((r) => r.cells[0])).toEqual(["F001", "F002"]);
  });

  it("往返锁：解析 → 定位 → 替换 → 重解析，值已变、结构不变", () => {
    const text = "# 追踪-伏笔\r\n\r\n## F001\r\n- 内容与涉及对象：贝壳\r\n- 状态：开放\r\n";
    const g1 = gridOf(docTableFor("追踪-伏笔.md", text));
    const addr = g1.rows[0].addrs[5]!; // 状态格
    const out = applyCellEdit(text, addr, "已回收");
    expect(out).toContain("\r\n"); // CRLF 保持
    const g2 = gridOf(docTableFor("追踪-伏笔.md", out));
    expect(g2.rows[0].cells[5]).toBe("已回收");
    expect(g2.rows[0].cells[1]).toBe("贝壳");
  });
});

describe("buildEntryBlock（grid 加行）", () => {
  it("追踪表：编号自动续、列字段逐条待填写", () => {
    const block = buildEntryBlock("追踪-伏笔.md", ["条目", "内容与涉及对象", "状态"], ["F001", "F002"])!;
    expect(block).toContain("## F003");
    expect(block).toContain("- 内容与涉及对象：待填写");
    expect(block).toContain("- 状态：待填写");
    expect(block.startsWith("\n")).toBe(true); // 与上一条目空行分隔
  });

  it("规则台账 GL 带连字符；角色状态占位人名", () => {
    expect(buildEntryBlock("规则台账.md", ["编号", "规则", "状态"], ["GL-001", "GL-009"])).toContain("## GL-010");
    expect(buildEntryBlock("追踪-角色状态.md", ["条目", "当前目标", "状态"], ["林砚"])).toContain("## 新人物");
  });

  it("06-写作风格：默认表格视图（批 3 真表格化）", () => {
    expect(defaultTableView("06-写作风格.md")).toBe(true);
  });

  it("不支持的形态返回 null（细纲章块/粗纲弧段/06 禁用列表）", () => {
    expect(buildEntryBlock("第1-3章细纲.md", ["章"], [])).toBeNull();
    expect(buildEntryBlock("04-粗纲.md", ["弧段"], [])).toBeNull();
    // 06 有两张 grid：禁用列表（禁止项 + 来源）不是「编号 + 字段」形态 → 不给加行
    expect(buildEntryBlock("06-写作风格.md", ["禁止项", "来源"], [])).toBeNull();
    // 规则表才是可加行的形态
    expect(buildEntryBlock("06-写作风格.md", ["规则编号", "规则分类", "规则来源", "具体内容"], [])).toContain("### SR-001");
  });
  it("加行 → 重解析：新条目出现在表格里", () => {
    const text = "# 追踪-伏笔\n\n## F001\n- 内容与涉及对象：贝壳\n- 状态：开放\n";
    const g1 = gridOf(docTableFor("追踪-伏笔.md", text));
    const block = buildEntryBlock("追踪-伏笔.md", g1.columns, g1.rows.map((r) => r.cells[0]))!;
    const out = applyInsertBlock(text, g1.appendAt!, block);
    const g2 = gridOf(docTableFor("追踪-伏笔.md", out));
    expect(g2.rows.map((r) => r.cells[0])).toEqual(["F001", "F002"]);
  });
});

describe("defaultTableView（类型默认）", () => {
  it("追踪类/台账/粗纲/细纲/00 默认表格；人物库与 01/02 默认原文", () => {
    expect(defaultTableView("追踪-伏笔.md")).toBe(true);
    expect(defaultTableView("规则台账.md")).toBe(true);
    expect(defaultTableView("04-粗纲.md")).toBe(true);
    expect(defaultTableView("第1-3章细纲.md")).toBe(true);
    expect(defaultTableView("00-项目状态.md")).toBe(true);
    expect(defaultTableView("人物库.md")).toBe(false);
    expect(defaultTableView("01-开书定位.md")).toBe(false);
  });

  it("章节摘要默认表格（2026-10-11 两列化后）", () => {
    expect(defaultTableView("章节摘要.md")).toBe(true);
  });
});

/**
 * 2026-10-11 用户逐表指定批次的回归锁：
 *  ① 列宽声明（100 分制）与「列名对不上就整体放弃」；
 *  ② 切换钮按内容驱动（hasRealTable）——纯散文文档不给钮（D-061）；
 *  ③ 章节摘要两列化；
 *  ④ 空列（原行末删钮列）不再占一列。
 */
describe("列宽声明（100 分制）", () => {
  it("每个声明的表权重之和为 100", () => {
    for (const [file, w] of Object.entries(COLUMN_WEIGHTS)) {
      const sum = Object.values(w).reduce((a, b) => a + b, 0);
      expect(sum, `${file} 权重之和`).toBe(100);
    }
  });

  it("列名逐字对上才给权重；对不上整体放弃（走自适应）", () => {
    const ledger = gridOf(docTableFor("规则台账.md", "# 规则台账\n\n## GL-001\n- 规则：断行\n- 状态：待观察\n"));
    expect(columnWeightsFor("规则台账.md", ledger.columns)).toEqual([6, 50, 8, 5, 5, 8, 18]);
    // 06「禁用列表」两列不在声明里 → 不固定，正是用户要的「禁用项表格没问题」
    expect(columnWeightsFor("06-写作风格.md", ["禁止项", "来源"])).toBeNull();
    // 06「风格规则」四列才是声明的那张表
    expect(columnWeightsFor("06-写作风格.md", ["规则编号", "规则分类", "规则来源", "具体内容"])).toEqual([10, 15, 10, 65]);
    // 列名少一个 / 多一个都放弃（部分匹配会产出比表格短的 colgroup，把表挤坏）
    expect(columnWeightsFor("规则台账.md", ["编号", "规则"])).toBeNull();
    expect(columnWeightsFor("规则台账.md", [...gridOf(docTableFor("规则台账.md", "# 规则台账\n\n## GL-001\n- 规则：断行\n")).columns, "多出来的一列"])).toBeNull();
    // 没声明的文件一律自适应（细纲/粗纲/00/01/02 一个像素都不动）
    expect(columnWeightsFor("第1-3章细纲.md", ["章", "承接与目标"])).toBeNull();
  });

  it("追踪-伏笔的列宽覆盖全部七列（删掉空列后的列集）", () => {
    const t = docTableFor("追踪-伏笔.md", TRACKER_MODULES.find((m) => m.key === "伏笔")!.template.content);
    const g = gridOf(t);
    expect(g.columns).toEqual([
      "条目",
      "内容与涉及对象",
      "首次出现章节",
      "当前进展",
      "预计触发或回收条件",
      "状态",
      "来源与最近更新章节",
    ]);
    expect(columnWeightsFor("追踪-伏笔.md", g.columns)).toEqual([5, 18, 10, 22, 18, 5, 22]);
  });
});

describe("hasRealTable：切换钮按内容驱动（D-061）", () => {
  it("纯散文文档没有真表格 → 不给「表格」钮", () => {
    // 盘上真实形态：人物库只有自然段（没有六方面标签行）
    const cast = docTableFor("人物库.md", "# 人物库\n\n## 沈逸\n\n23岁，程序员。\n\n## 段晓宇\n\n18岁，骑手。\n");
    expect(hasRealTable(cast)).toBe(false);
    // 03-全书大纲：只有节标题与自然段
    const outline = docTableFor("03-全书大纲.md", "# 全书大纲\n\n## 第一节\n\n几段话。\n");
    expect(hasRealTable(outline)).toBe(false);
    // 用户自建的纯散文文档同理
    expect(hasRealTable(docTableFor("随手记.md", "# 随手记\n\n## 今天\n\n写了点东西。\n"))).toBe(false);
  });

  it("有 grid 或 kv 的文档照常给钮", () => {
    expect(hasRealTable(docTableFor("追踪-伏笔.md", "# 追踪-伏笔\n\n## F001\n- 状态：开放\n"))).toBe(true);
    expect(hasRealTable(docTableFor("规则台账.md", "# 规则台账\n\n## GL-001\n- 规则：断行\n"))).toBe(true);
    expect(hasRealTable(docTableFor("04-粗纲.md", "# 粗纲\n\n## 第1-20章 起步\n一段话。\n"))).toBe(true);
    // 人物库写出模板字段行 → 钮自己出现（判定按内容，不按文件名）
    const cast = docTableFor("人物库.md", "# 人物库\n\n## 沈逸\n身份、背景与长期追求：程序员\n");
    expect(hasRealTable(cast)).toBe(true);
  });
});

describe("章节摘要两列化（2026-10-11）", () => {
  const SAMPLE = [
    "# 章节摘要",
    "",
    "历史归档索引。",
    "",
    "## 原文连续篇章（未设分卷）",
    "",
    "### 第1章 不速之客 摘要",
    "",
    "五月，沈逸回到和谐城。依据：原文第1至330行。",
    "",
    "### 第2章 隔壁的眼睛 摘要",
    "",
    "沈逸搬到隔壁。依据：原文第331至702行。",
    "",
  ].join("\n");

  it("### 章块 → 一行一章，两列（章节编号 / 具体摘要）", () => {
    const t = docTableFor("章节摘要.md", SAMPLE);
    const g = gridOf(t);
    expect(g.columns).toEqual(["章节编号", "具体摘要"]);
    expect(g.title).toBe("原文连续篇章（未设分卷）");
    expect(g.rows.map((r) => r.cells[0])).toEqual(["第1章 不速之客", "第2章 隔壁的眼睛"]);
    expect(g.rows[0].cells[1]).toBe("五月，沈逸回到和谐城。依据：原文第1至330行。");
    // 引言仍是散文卡
    expect(t.parts.some((p) => p.kind === "prose" && p.text.includes("历史归档索引"))).toBe(true);
  });

  it("章标题只读（与 ### 前缀、「摘要」后缀耦合），摘要有落点可改", () => {
    const t = docTableFor("章节摘要.md", SAMPLE);
    const g = gridOf(t);
    expect(g.rows[0].addrs[0]).toBeNull();
    expect(g.rows[0].addrs[1]).not.toBeNull();
    // 改摘要只动正文行，标题行逐字节不变
    const out = applyCellEdit(SAMPLE, g.rows[0].addrs[1]!, "改过的摘要。");
    expect(out).toContain("### 第1章 不速之客 摘要");
    expect(out).toContain("改过的摘要。");
    expect(out).not.toContain("五月，沈逸回到和谐城。");
  });

  it("没有 ### 章块的旧结构/自建文件 → 回落通用解析器（行为不变）", () => {
    const legacy = docTableFor("章节摘要.md", "# 章节摘要\n- 第一章：捡贝壳。\n");
    expect(legacy.parts.length).toBeGreaterThan(0);
    expect(legacy.parts.some((p) => p.kind === "grid")).toBe(false);
  });
});
