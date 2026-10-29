/**
 * 冷读（D-045 重构）的回归锁：
 *  - 隔离：系统提示词不携带项目上下文；零工具请求体不含 tools 键；
 *  - 双通道：plot 完全冷（无资料）/ style 注入风格档案（只进用户消息，不进系统提示词）；
 *  - 结构化输出契约：提示词里的格式契约与 parseColdReadIssues 的解析互为镜像；
 *  - 解析容错：字段缺失给空串、未知类别归「其他」、块外散文进 leftover、不丢内容；
 *  - 修复任务组装：buildColdFixMessage 的路径与「只改列出的问题」纪律。
 *
 * 这是「隔离由代码物理保证」的回归锁：任何往冷读系统提示词里掺项目路径、
 * 往零工具请求体里掺 tools 键的改动都会在这里被拦下。
 */
import { describe, expect, it } from "vitest";
import { buildRequest, type ProviderConfig } from "../../src/core/ai/protocol";
import {
  COLD_READ_CATEGORIES,
  buildColdFixMessage,
  buildColdReadUserMessage,
  coldReadSystem,
  parseColdReadIssues,
  type ColdIssue,
} from "../../src/core/ai/coldread";

const cfg: ProviderConfig = {
  baseUrl: "https://api.example.com",
  apiKey: "sk-test",
  model: "test-model",
  temperature: 0.7,
  useAnthropicFormat: false,
};

describe("冷读系统提示词（隔离内容）", () => {
  it("plot 通道：完全冷身份 + 四核对方面，不含任何项目路径/设定引用", () => {
    const s = coldReadSystem("plot");
    expect(s).toContain("第一次阅读");
    expect(s).toContain("剧情连贯度");
    // 契约目录名与资料文件不得出现在冷读提示词里（隔离的反向断言）
    expect(s).not.toContain("小说资料");
    expect(s).not.toContain("00-项目状态");
    expect(s).not.toContain("06-写作风格");
    expect(s).not.toContain("skills");
    expect(s).not.toContain("file_write");
    expect(s).not.toContain("file_read");
  });

  it("style 通道：半冷身份（只拿风格档案），同样不含项目路径引用", () => {
    const s = coldReadSystem("style");
    expect(s).toContain("写作风格档案");
    expect(s).toContain("风格");
    // 风格档案的内容走用户消息注入；系统提示词里不出现契约目录名
    expect(s).not.toContain("小说资料");
    expect(s).not.toContain("00-项目状态");
    expect(s).not.toContain("file_write");
  });

  it("两个通道不同，且都带格式契约与报告制纪律", () => {
    const a = coldReadSystem("plot");
    const b = coldReadSystem("style");
    expect(a).not.toBe(b);
    for (const s of [a, b]) {
      expect(s).toContain("【问题】");
      expect(s).toContain("类别");
      expect(s).toContain("位置");
      expect(s).toContain("【无问题】");
      expect(s).toContain("不打分");
      expect(s).toContain("不替写正文");
    }
  });

  it("类别封闭集合写进提示词（与解析器的归一表同一份）", () => {
    expect(coldReadSystem("plot")).toContain("连贯断裂 / 硬性bug / 状态矛盾 / 信息缺失 / 其他");
    expect(coldReadSystem("style")).toContain("禁用词命中 / 句式节奏 / 语气不符 / 人设声线 / 其他");
    expect(COLD_READ_CATEGORIES.plot).toContain("其他");
    expect(COLD_READ_CATEGORIES.style).toContain("其他");
  });
});

describe("零工具请求体（物理隔离）", () => {
  it("tools=[] 时 body 不含 tools 键（模型无法调用文件工具）", () => {
    const req = buildRequest(cfg, [], [], coldReadSystem("plot"));
    expect("tools" in req.body).toBe(false);
    const msgs = req.body.messages as { role: string; content: string }[];
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("第一次阅读");
  });

  it("Anthropic 协议同样不带 tools", () => {
    const req = buildRequest({ ...cfg, useAnthropicFormat: true }, [], [], coldReadSystem("style"));
    expect("tools" in req.body).toBe(false);
    expect(req.body.system).toContain("审读");
  });
});

describe("用户消息装配（双通道）", () => {
  it("plot：含审读对象全文与前文块（前文在对象之前）", () => {
    const m = buildColdReadUserMessage("plot", "第3章", "第三章正文。", [
      { title: "第1章", text: "第一章正文。" },
      { title: "第2章", text: "第二章正文。" },
    ]);
    expect(m).toContain("【前文（读者已读部分）：第1章】");
    expect(m).toContain("【本次审读对象：第3章】");
    expect(m.indexOf("第1章")).toBeLessThan(m.indexOf("本次审读对象"));
    expect(m).not.toContain("风格档案");
  });

  it("style：注入风格档案，不带前文", () => {
    const m = buildColdReadUserMessage("style", "第3章", "第三章正文。", [
      { title: "第2章", text: "第二章正文。" },
    ], "禁用：很、非常。");
    expect(m).toContain("【写作风格档案】");
    expect(m).toContain("禁用：很、非常。");
    expect(m).toContain("【本次审读对象：第3章】");
    expect(m).not.toContain("前文（读者已读部分）");
  });
});

describe("结构化输出解析（parseColdReadIssues）", () => {
  const sample =
    "开头说明一句。\n\n" +
    "【问题】\n类别：连贯断裂\n位置：第12段「她明明把信烧了」\n问题：信在上一章已经烧掉，本章又出现。\n依据：第12段引文。\n补足：改为提及灰烬。\n\n" +
    "【问题】\n类别：编造的类别\n位置：第3段「他突然开口」\n问题：无铺垫。\n依据：前文未提。\n补足：补一句铺垫。\n\n" +
    "结尾汇总两句。";

  it("良好格式：逐字段解析，位置里的「」拆出定位引文", () => {
    const r = parseColdReadIssues(sample, "plot");
    expect(r.issues).toHaveLength(2);
    expect(r.issues[0]).toMatchObject({
      category: "连贯断裂",
      location: "第12段",
      quote: "她明明把信烧了",
      problem: "信在上一章已经烧掉，本章又出现。",
      basis: "第12段引文。",
      fix: "改为提及灰烬。",
    });
    // 块外散文进 leftover（开头 + 结尾都保留）
    expect(r.leftover).toContain("开头说明一句。");
    expect(r.leftover).toContain("结尾汇总两句。");
    expect(r.noIssues).toBe(false);
  });

  it("未知类别归「其他」，行 id 稳定（通道+序号）", () => {
    const r = parseColdReadIssues(sample, "plot");
    expect(r.issues[1].category).toBe("其他");
    expect(r.issues[0].id).toBe("plot-0");
  });

  it("字段续行并入上一字段；缺字段给空串", () => {
    const text =
      "【问题】\n类别：状态矛盾\n位置：第5段「他扔下伞」\n问题：伞已经扔了，\n后文又撑着伞。\n依据：第5段。\n";
    const r = parseColdReadIssues(text, "plot");
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].problem).toBe("伞已经扔了，\n后文又撑着伞。");
    expect(r.issues[0].fix).toBe("");
  });

  it("【无问题】：issues 为空，说明文字进 note，不进 leftover", () => {
    const r = parseColdReadIssues("【无问题】\n核对了连贯断裂与状态矛盾两方面。", "plot");
    expect(r.issues).toEqual([]);
    expect(r.noIssues).toBe(true);
    expect(r.note).toContain("核对了连贯断裂");
    expect(r.leftover).toBe("");
  });

  it("模型完全不按格式：整块进 leftover，不硬造条目、不丢内容", () => {
    const text = "这是一段自由散文，没有任何块。\n第二章也有问题。";
    const r = parseColdReadIssues(text, "style");
    expect(r.issues).toEqual([]);
    expect(r.noIssues).toBe(false);
    expect(r.leftover).toContain("自由散文");
  });

  it("style 通道的类别集合独立（剧情类别在 style 里归「其他」）", () => {
    const text = "【问题】\n类别：连贯断裂\n位置：第1段「x」\n问题：p\n依据：b\n补足：f\n";
    const r = parseColdReadIssues(text, "style");
    expect(r.issues[0].category).toBe("其他");
  });
});

describe("修复任务组装（buildColdFixMessage）", () => {
  const issues: ColdIssue[] = [
    { id: "plot-0", category: "连贯断裂", location: "第12段", quote: "她明明把信烧了", problem: "信又出现了", basis: "引文", fix: "改为灰烬" },
    { id: "plot-1", category: "信息缺失", location: "", quote: "", problem: "新物件无来历", basis: "", fix: "" },
  ];

  it("含章节路径与全部勾选行；多行字段折成单行", () => {
    const m = buildColdFixMessage("第3章", "章节内容/第3章.md", issues);
    expect(m).toContain("【冷读修复】");
    expect(m).toContain("章节内容/第3章.md");
    expect(m).toContain("1. [连贯断裂] 第12段「她明明把信烧了」");
    expect(m).toContain("2. [信息缺失] 位置未标注");
    expect(m).toContain("问题：信又出现了");
  });

  it("纪律锁定：只改列出的问题、不顺手润色、快照由系统保留、不成立的不改", () => {
    const m = buildColdFixMessage("第3章", "章节内容/第3章.md", issues);
    expect(m).toContain("只处理上面列出的问题");
    expect(m).toContain("不顺手润色");
    expect(m).toContain("写前快照由系统保留");
    expect(m).toContain("不成立的说明理由、不要改");
  });
});
