/**
 * 作品目录协议：与既有布局逐项对齐，并做一次既有目录只读集成校验。
 */
import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeFs } from "../support/nodeFs";
import {
  buildContentTree,
  chapterLabelOf,
  createProject,
  kindForRel,
  listChapters,
  listDocs,
  listPending,
  listProcessed,
  loadProject,
  naturalCompareNames,
  projectExists,
  scanBooksRoot,
  validateProject,
} from "../../src/core/store/project";
import { CORE_DOC_TEMPLATES, DOC_TEMPLATES, LEGACY_DOC_TEMPLATES, renderTemplate } from "../../src/core/store/templates";
import { compareChapterFiles, parseChapterName, parseCnNumber } from "../../src/core/store/chapter";
// 相对路径（rel）的期望值用被测代码自己的 join 构造：Windows 得 '\'、macOS 得 '/'。
// 注意本文件的 `path.join`（node:path）只用于真实磁盘 I/O，两者不可混用。
import { join as joinRel } from "../../src/core/dirs";

let booksRoot: string;
const fs = createNodeFs();

beforeAll(async () => {
  // 临时目录前缀用产品名 deepcompose-（非磁盘契约，随改名规则走）
  booksRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "deepcompose-books-"));
});

afterAll(async () => {
  if (booksRoot) await fsp.rm(booksRoot, { recursive: true, force: true });
});

describe("中文数字与章号解析", () => {
  it("阿拉伯数字与全角数字", () => {
    expect(parseCnNumber("12")).toBe(12);
    expect(parseCnNumber("１２")).toBe(12);
  });

  it("中文数字：十 / 十一 / 二十 / 一百零三 / 一千零二十", () => {
    expect(parseCnNumber("十")).toBe(10);
    expect(parseCnNumber("十一")).toBe(11);
    expect(parseCnNumber("二十")).toBe(20);
    expect(parseCnNumber("一百零三")).toBe(103);
    expect(parseCnNumber("一千零二十")).toBe(1020);
  });

  it("复合中文数字与万级：一百二十三 / 一万二千三百四十五", () => {
    expect(parseCnNumber("一百二十三")).toBe(123);
    expect(parseCnNumber("一万二千三百四十五")).toBe(12345);
    expect(parseCnNumber("万")).toBe(10000); // 「万」单独出现按一万处理
    expect(parseChapterName("第一百二十三章 风起")).toEqual({ no: 123, unit: "章", rest: "风起" });
  });

  it("全角章号：parseChapterName 先归一再解析", () => {
    expect(parseChapterName("第１２章")).toEqual({ no: 12, unit: "章", rest: "" });
    expect(parseChapterName("第１０８回")).toEqual({ no: 108, unit: "回", rest: "" });
  });

  it("非数字串返回 null", () => {
    expect(parseCnNumber("序章")).toBeNull();
    expect(parseCnNumber("")).toBeNull();
    // 阿拉伯数字与中文单位混写不解析（保守回落到「无章号」桶）
    expect(parseCnNumber("3十")).toBeNull();
  });

  it("parseChapterName 支持 章/节/卷/回/部/集 与标题残余", () => {
    expect(parseChapterName("第12章")).toEqual({ no: 12, unit: "章", rest: "" });
    expect(parseChapterName("第十二章 启程")).toEqual({ no: 12, unit: "章", rest: "启程" });
    expect(parseChapterName("第1卷")).toEqual({ no: 1, unit: "卷", rest: "" });
    expect(parseChapterName("第 3 回 入城")).toEqual({ no: 3, unit: "回", rest: "入城" });
    expect(parseChapterName("随便一个名字")).toBeNull();
  });
});

describe("章节排序", () => {
  it("按数值排序而非字典序（第10章 在 第2章 之后）", () => {
    const files = ["第10章.md", "第2章.md", "第1章.md"];
    expect([...files].sort(compareChapterFiles)).toEqual(["第1章.md", "第2章.md", "第10章.md"]);
  });

  it("不能解析出章号的文件排在最后", () => {
    const files = ["1.md", "第3章.md", "序.md"];
    const sorted = [...files].sort(compareChapterFiles);
    expect(sorted[0]).toBe("第3章.md");
    expect(sorted.slice(1).sort()).toEqual(["1.md", "序.md"]);
  });
});

describe("新建作品：新结构（核心 7 件 + 细纲栏目 + 可选追踪模块，D-043）", () => {
  it("默认（AI 工具路径）生成核心 7 件 + 全部 5 份追踪表 + 细纲目录 + 清单", async () => {
    const p = await createProject(fs, booksRoot, "测试书籍");
    const entries = await fsp.readdir(p.root);
    expect(entries.sort()).toEqual(
      ["小说资料", "章节内容", "待确认", ".openwrite_manifest.json"].sort(),
    );

    const docEntries = (await fsp.readdir(path.join(p.root, "小说资料"))).sort();
    expect(docEntries).toEqual([...DOC_TEMPLATES.map((t) => t.name), "细纲"].sort());
    expect(DOC_TEMPLATES.length).toBe(12); // 核心 7 + 追踪模块 5

    // 模板占位替换 + CRLF 落盘
    const state = await fsp.readFile(path.join(p.root, "小说资料", "00-项目状态.md"), "utf8");
    expect(state).toContain("项目名称：测试书籍");
    expect(state).toContain("- 启用模块：伏笔、角色状态、时间线、资源与权限、废弃设定");
    expect(state).not.toContain("{书名}");
    expect(state).toContain("\r\n");
    expect(state.includes("\n") && !state.match(/(?<!\r)\n/)).toBe(true); // 全部 \n 都带 \r

    // 新结构用 04-粗纲 / 06-写作风格，不再生成旧名
    expect(docEntries).toContain("04-粗纲.md");
    expect(docEntries).toContain("06-写作风格.md");
    expect(docEntries).not.toContain("04-分卷大纲.md");
    expect(docEntries).not.toContain("05-滚动细纲.md");
    expect(docEntries).not.toContain("章节摘要.md");
    expect(docEntries).not.toContain("06-写作规则.md");

    expect((await fsp.readdir(path.join(p.root, "章节内容"))).length).toBe(0);
    expect((await fsp.readdir(path.join(p.root, "待确认"))).length).toBe(0);
    expect((await fsp.readdir(path.join(p.root, "小说资料", "细纲"))).length).toBe(0);
    // 审核/个人改稿/已处理 按首次使用创建，不预建
    expect(await fs.exists(path.join(p.root, "小说资料", "审核"))).toBe(false);
    expect(await fs.exists(path.join(p.root, "待确认", "已处理"))).toBe(false);

    const manifest = JSON.parse(
      await fsp.readFile(path.join(p.root, ".openwrite_manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.version).toBe(1);
    expect(manifest.items).toEqual({});
    expect(manifest.orders).toEqual({});
    expect(manifest.manualOrderParents).toEqual([]);
  });

  it("模块勾选：只开角色状态 → 只建核心 7 件加一份追踪表，00 声明同步", async () => {
    const p = await createProject(fs, booksRoot, "模块书", undefined, ["角色状态"]);
    const docEntries = (await fsp.readdir(path.join(p.root, "小说资料"))).sort();
    expect(docEntries).toEqual(
      [...CORE_DOC_TEMPLATES.map((t) => t.name), "追踪-角色状态.md", "细纲"].sort(),
    );
    const state = await fsp.readFile(path.join(p.root, "小说资料", "00-项目状态.md"), "utf8");
    expect(state).toContain("- 启用模块：角色状态");
  });

  it("模块全关：只建核心 7 件，00 写「启用模块：无」", async () => {
    const p = await createProject(fs, booksRoot, "无模块书", undefined, []);
    const docEntries = (await fsp.readdir(path.join(p.root, "小说资料"))).sort();
    expect(docEntries).toEqual([...CORE_DOC_TEMPLATES.map((t) => t.name), "细纲"].sort());
    const state = await fsp.readFile(path.join(p.root, "小说资料", "00-项目状态.md"), "utf8");
    expect(state).toContain("- 启用模块：无");
  });

  it("renderTemplate 替换书名并统一 CRLF", () => {
    const out = renderTemplate("# {书名}\n第二行\n", "书名A");
    expect(out).toBe("# 书名A\r\n第二行\r\n");
  });

  it("同名作品拒绝重复创建", async () => {
    await expect(createProject(fs, booksRoot, "测试书籍")).rejects.toThrow(/已存在/);
  });

  it("书名含非法字符时拒绝", async () => {
    await expect(createProject(fs, booksRoot, "a/b")).rejects.toThrow(/不合法/);
    await expect(createProject(fs, booksRoot, "   ")).rejects.toThrow(/不能为空/);
  });

  it("保留设备名 / 冒号(ADS) / 尾随点 也在建目录之前挡掉（KL-ST-02）", async () => {
    // 这些名字在 Windows 上要么建不出来，要么写进别的地方 —— 必须在 mkdir 之前拒绝
    for (const bad of ["CON", "nul.md", "aux", "COM1", "第1章.md:payload", "雾都."]) {
      await expect(createProject(fs, booksRoot, bad)).rejects.toThrow(/不合法/);
    }
    // 没被误伤的正常名字
    for (const ok of ["COM0", "console", "雾都谍影"]) {
      const ref = await createProject(fs, booksRoot, ok);
      expect(await fs.exists(ref.root)).toBe(true);
    }
  });
});

describe("读取作品", () => {
  it("scanBooksRoot 跳过隐藏目录（回收站）", async () => {
    await createProject(fs, booksRoot, "第二本");
    await fsp.mkdir(path.join(booksRoot, ".openwrite_recycle"), { recursive: true });
    const list = await scanBooksRoot(fs, booksRoot);
    const names = list.map((p) => p.name);
    // 只断言"过滤"而不是整表相等：本文件的用例共享同一个作品根，整表相等会被别的用例带崩
    expect(names).not.toContain(".openwrite_recycle");
    expect(names).toContain("第二本");
    expect(names).toContain("测试书籍");
  });

  it("scanBooksRoot 也跳过 writerd_* 与清单文件（KL-ST-04）", async () => {
    // 早期只跳 `.` 前缀：作品根下冒出 writerd_* 目录时会被当成一部作品列出来
    await fsp.mkdir(path.join(booksRoot, "writerd_backup"), { recursive: true });
    await fsp.mkdir(path.join(booksRoot, "recycle_manifest.json"), { recursive: true });
    const list = await scanBooksRoot(fs, booksRoot);
    const names = list.map((p) => p.name);
    expect(names).not.toContain("writerd_backup");
    expect(names).not.toContain("recycle_manifest.json");
    expect(names).toContain("测试书籍");
  });

  it("listDocs / listChapters 认 .md，且章节按章号排序", async () => {
    const root = path.join(booksRoot, "测试书籍");
    const chDir = path.join(root, "章节内容");
    await fsp.writeFile(path.join(chDir, "第10章.md"), "十\r\n", "utf8");
    await fsp.writeFile(path.join(chDir, "第2章.md"), "二\r\n", "utf8");
    await fsp.writeFile(path.join(chDir, "第1章.md"), "一\r\n", "utf8");
    await fsp.writeFile(path.join(chDir, "1.md"), "旧命名\r\n", "utf8");
    await fsp.writeFile(path.join(chDir, "笔记.txt"), "不是 md\r\n", "utf8");
    await fsp.writeFile(path.join(root, "小说资料", "写作禁忌.md"), "# 禁忌\r\n", "utf8");

    const chapters = await listChapters(fs, root);
    expect(chapters.map((c) => c.name)).toEqual(["第1章.md", "第2章.md", "第10章.md", "1.md"]);
    expect(chapters[0].rel).toBe(joinRel("章节内容", "第1章.md"));

    const docs = await listDocs(fs, root);
    expect(docs.map((d) => d.name)).toContain("写作禁忌.md");
    expect(docs.length).toBe(DOC_TEMPLATES.length + 1); // 14 模板 + 用户自建
  });

  it("loadProject 返回作品索引（用户自建文档平级列出，不做模板纠正）", async () => {
    const root = path.join(booksRoot, "测试书籍");
    const data = await loadProject(fs, root);
    expect(data.ref.name).toBe("测试书籍");
    expect(data.docs.map((d) => d.name)).toContain("写作禁忌.md");
    expect(data.chapters.length).toBe(4);
    expect(data.manifest.version).toBe(1);
  });
});

describe("候选区与通用内容树", () => {
  const root = () => path.join(booksRoot, "测试书籍");

  it("listPending / listProcessed 按章号排序，已处理不计入待确认", async () => {
    const r = root();
    const pend = path.join(r, "待确认");
    await fsp.writeFile(path.join(pend, "第10章-v2-候选.md"), "十候\r\n", "utf8");
    await fsp.writeFile(path.join(pend, "第2章-v1-初稿.md"), "二初\r\n", "utf8");
    await fsp.writeFile(path.join(pend, "第2章-v2-候选.md"), "二候\r\n", "utf8");
    await fsp.mkdir(path.join(pend, "已处理"), { recursive: true });
    await fsp.writeFile(path.join(pend, "已处理", "第1章-v2-候选.md"), "旧候\r\n", "utf8");

    const pending = await listPending(fs, r);
    expect(pending.map((p) => p.name)).toEqual(["第2章-v1-初稿.md", "第2章-v2-候选.md", "第10章-v2-候选.md"]);
    expect(pending[0].rel).toBe(joinRel("待确认", "第2章-v1-初稿.md"));

    const processed = await listProcessed(fs, r);
    expect(processed.map((p) => p.name)).toEqual(["第1章-v2-候选.md"]);
    expect(processed[0].rel).toBe(joinRel("待确认", "已处理", "第1章-v2-候选.md"));
  });

  it("buildContentTree：系统条目排除、目录在前、已知目录固定次序", async () => {
    const r = root();
    // 系统级条目（左栏不得出现）
    await fsp.mkdir(path.join(r, "writerd_oplog"), { recursive: true });
    await fsp.writeFile(path.join(r, "writerd_oplog", "log.jsonl"), "{}\n", "utf8");
    await fsp.mkdir(path.join(r, ".openwrite_recycle"), { recursive: true });
    await fsp.writeFile(path.join(r, "recycle_manifest.json"), "{}", "utf8");
    // 小说资料 子目录
    await fsp.mkdir(path.join(r, "小说资料", "审核"), { recursive: true });
    await fsp.writeFile(path.join(r, "小说资料", "审核", "第2章-冷读-clarity-20260101-1200.md"), "# 报告\r\n", "utf8");

    const tree = await buildContentTree(fs, r);
    const topNames = tree.map((n) => n.name);
    expect(topNames).not.toContain("writerd_oplog");
    expect(topNames).not.toContain(".openwrite_recycle");
    expect(topNames).not.toContain("recycle_manifest.json");
    expect(topNames).not.toContain(".openwrite_manifest.json");
    // 目录在前 + 固定次序：小说资料 < 章节内容 < 待确认
    expect(topNames.slice(0, 3)).toEqual(["小说资料", "章节内容", "待确认"]);

    const docs = tree.find((n) => n.name === "小说资料")!;
    const docsDirs = docs.children.filter((c) => c.isDir).map((c) => c.name);
    expect(docsDirs).toEqual(["审核", "细纲"]); // 目录排在文件前；细纲是新结构的核心栏目（D-043）
    const review = docs.children.find((c) => c.name === "审核")!;
    expect(review.children.map((c) => c.name)).toEqual(["第2章-冷读-clarity-20260101-1200.md"]);

    const pend = tree.find((n) => n.name === "待确认")!;
    const pendFiles = pend.children.filter((c) => !c.isDir).map((c) => c.name);
    expect(pendFiles).toEqual(["第2章-v1-初稿.md", "第2章-v2-候选.md", "第10章-v2-候选.md"]);
    const processedNode = pend.children.find((c) => c.isDir)!;
    expect(processedNode.name).toBe("已处理");
    expect(processedNode.rel).toBe(joinRel("待确认", "已处理"));

    // loadProject 同时给出 tree 与 pending
    const data = await loadProject(fs, r);
    expect(data.tree.length).toBeGreaterThan(0);
    expect(data.pending.length).toBe(3);
    expect(data.processed.length).toBe(1);
  });

  it("buildContentTree：隐藏导览与审读专用目录，普通资料和旧审核仍可见且原文件不动", async () => {
    const r = path.join(booksRoot, "教学专用目录树样本");
    const files = [
      ["小说资料/写作导览/第1章-导览.md", "含尚未解锁的后续场景"],
      ["小说资料/写作导览/.history/旧版.md", "旧导览"],
      ["小说资料/审核/审读/batch.json", '{"status":"accepted"}'],
      ["小说资料/普通资料.md", "普通资料"],
      ["小说资料/审核/旧审核.md", "旧审核裁决"],
      ["小说资料/写作导览笔记/作者笔记.md", "普通作者笔记"],
      ["小说资料/审核/审读旧稿/原报告.md", "普通旧稿报告"],
    ];
    for (const [rel, content] of files) await fs.writeText(path.join(r, rel), content);
    const tree = await buildContentTree(fs, r);
    const docs = tree.find(node => node.name === "小说资料")!;
    expect(docs).toBeDefined();
    expect(docs.children.some(node => node.name === "写作导览")).toBe(false);
    expect(docs.children.some(node => node.name === "普通资料.md")).toBe(true);
    expect(docs.children.some(node => node.name === "写作导览笔记")).toBe(true);
    const review = docs.children.find(node => node.name === "审核")!;
    expect(review).toBeDefined();
    expect(review.children.some(node => node.name === "审读")).toBe(false);
    expect(review.children.some(node => node.name === "旧审核.md")).toBe(true);
    expect(review.children.some(node => node.name === "审读旧稿")).toBe(true);
    const stack = [...tree];
    const visible: string[] = [];
    while (stack.length) {
      const node = stack.pop()!;
      visible.push(node.rel.replace(/\\/g, "/"));
      stack.push(...node.children);
    }
    expect(visible).not.toContain("小说资料/写作导览/第1章-导览.md");
    expect(visible).not.toContain("小说资料/审核/审读/batch.json");
    for (const dir of ["小说资料/写作导览", "小说资料/审核/审读"]) expect(await fs.exists(path.join(r, dir))).toBe(true);
    for (const [rel, content] of files) {
      expect(await fs.exists(path.join(r, rel))).toBe(true);
      expect(await fs.readText(path.join(r, rel))).toBe(content);
    }
  });

  it("buildContentTree：超深目录打 truncated 标记而非静默消失（I-7 回归锁）", async () => {
    const r = root();
    // 造 5 层嵌套：a\b\c\d\e\x.md，用 maxDepth=3 构建
    await fsp.mkdir(path.join(r, "a", "b", "c", "d", "e"), { recursive: true });
    await fsp.writeFile(path.join(r, "a", "b", "c", "d", "e", "x.md"), "深\r\n", "utf8");
    const tree = await buildContentTree(fs, r, 3);
    const a = tree.find((n) => n.name === "a")!;
    const b = a.children.find((n) => n.name === "b")!;
    const c = b.children.find((n) => n.name === "c")!;
    // 第 3 层被截断：children 为空但带 truncated 标记（修复前：静默消失、无任何痕迹）
    expect(c.children).toEqual([]);
    expect(c.truncated).toBe(true);
    await fsp.rm(path.join(r, "a"), { recursive: true, force: true });
  });

  it("buildContentTree：非章节目录按自然序（细纲 1-6 → 7-9 → 10-12 → 102-106）", async () => {
    const r = path.join(booksRoot, "排序样本");
    const xg = path.join(r, "小说资料", "细纲");
    await fsp.mkdir(xg, { recursive: true });
    for (const n of ["第102-106章细纲.md", "第10-12章细纲.md", "第1-6章细纲.md", "第7-9章细纲.md"]) {
      await fsp.writeFile(path.join(xg, n), "# 细纲\r\n", "utf8");
    }
    const tree = await buildContentTree(fs, r);
    const docs = tree.find((n) => n.name === "小说资料")!;
    const xgNode = docs.children.find((c) => c.name === "细纲")!;
    // 旧实现是纯字典序：'1'<'7'，第102-106章会紧跟在第1-6章后面（第7-9章之前）
    expect(xgNode.children.map((c) => c.name)).toEqual([
      "第1-6章细纲.md",
      "第7-9章细纲.md",
      "第10-12章细纲.md",
      "第102-106章细纲.md",
    ]);
    expect(naturalCompareNames("第1-6章细纲.md", "第102-106章细纲.md")).toBeLessThan(0);
    expect(naturalCompareNames("改稿对比-第3章.md", "改稿对比-第12章.md")).toBeLessThan(0);
    expect(naturalCompareNames("a.md", "a.md")).toBe(0);
    await fsp.rm(r, { recursive: true, force: true });
  });

  it("validateProject：新建作品无 error/warn；缺清单 → manifest-missing 警告（I-12）", async () => {
    const ref = await createProject(fs, booksRoot, "校验样本");
    const ok = await validateProject(fs, ref.root);
    expect(ok.filter((i) => i.level !== "info")).toEqual([]);

    // 手工建的"半受管"作品：有内容目录但没清单
    const half = path.join(booksRoot, "半受管样本");
    await fsp.mkdir(path.join(half, "章节内容"), { recursive: true });
    await fsp.writeFile(path.join(half, "章节内容", "第1章.md"), "一\r\n第3章跳号\r\n", "utf8");
    await fsp.writeFile(path.join(half, "章节内容", "第3章.md"), "三\r\n", "utf8");
    const issues = await validateProject(fs, half);
    expect(issues.some((i) => i.check === "manifest-missing" && i.level === "warn")).toBe(true);
    expect(issues.some((i) => i.check === "dir-missing")).toBe(true); // 缺 小说资料/待确认
    expect(issues.some((i) => i.check === "chapter-gap")).toBe(true); // 1 → 3 断档
    await fsp.rm(half, { recursive: true, force: true });
  });

  it("validateProject：状态声明的进度跑在正文前面 → status-chapter-ahead 警告（I-3）", async () => {
    const ref = await createProject(fs, booksRoot, "状态漂移样本");
    // 新建作品默认 当前章节：第000章 + 无正文 → 不该报
    const fresh = await validateProject(fs, ref.root);
    expect(fresh.some((i) => i.check === "status-chapter-ahead")).toBe(false);

    // 磁盘上只有第1章，状态却声称当前章节=第5章（=正文该有 4 章）
    await fsp.writeFile(path.join(ref.root, "章节内容", "第1章.md"), "一\r\n", "utf8");
    await fsp.writeFile(
      path.join(ref.root, "小说资料", "00-项目状态.md"),
      "# 项目状态\r\n- 当前阶段：连续写作\r\n- 当前章节：第5章\r\n- 正文处理进度：起草中\r\n\r\n## 开书大纲自检\r\n- 状态：可试写\r\n",
      "utf8",
    );
    const issues = await validateProject(fs, ref.root);
    expect(issues.some((i) => i.check === "status-chapter-ahead" && i.level === "warn")).toBe(true);

    // 状态与正文对齐（第2章 = 下一个要写的章）→ 不再报
    await fsp.writeFile(
      path.join(ref.root, "小说资料", "00-项目状态.md"),
      "- 当前阶段：连续写作\r\n- 当前章节：第2章\r\n- 正文处理进度：起草中\r\n",
      "utf8",
    );
    const aligned = await validateProject(fs, ref.root);
    expect(aligned.some((i) => i.check === "status-chapter-ahead")).toBe(false);
  });

  it("validateProject：伏笔自述统计与条目数不一致 → foreshadow-count-mismatch 警告（I-4）", async () => {
    const ref = await createProject(fs, booksRoot, "伏笔核对样本");
    // 新建作品：模板统计行全是「待填写」＝没有自述 → 不报
    const fresh = await validateProject(fs, ref.root);
    expect(fresh.some((i) => i.check === "foreshadow-count-mismatch")).toBe(false);

    // 自述 29 条已回收，正文却只有 1 条 → 报
    await fsp.writeFile(
      path.join(ref.root, "小说资料", "追踪-伏笔.md"),
      "# 追踪-伏笔\r\n## 伏笔统计\r\n- 已回收：29\r\n\r\n## F001 x\r\n- 状态：已回收\r\n",
      "utf8",
    );
    const issues = await validateProject(fs, ref.root);
    expect(issues.some((i) => i.check === "foreshadow-count-mismatch" && i.level === "warn")).toBe(true);

    // 自述与条目一致 → 不再报
    await fsp.writeFile(
      path.join(ref.root, "小说资料", "追踪-伏笔.md"),
      "# 追踪-伏笔\r\n## 伏笔统计\r\n- 已回收：1\r\n\r\n## F001 x\r\n- 状态：已回收\r\n",
      "utf8",
    );
    const aligned = await validateProject(fs, ref.root);
    expect(aligned.some((i) => i.check === "foreshadow-count-mismatch")).toBe(false);
  });

  it("validateProject：新结构启用模块缺文件 → module-file-missing；老结构走 14 件套口径（D-043）", async () => {
    const ref = await createProject(fs, booksRoot, "模块漂移书", undefined, ["伏笔"]);
    // 启用伏笔但删掉文件 → 结构不一致警告
    await fsp.rm(path.join(ref.root, "小说资料", "追踪-伏笔.md"));
    const issues = await validateProject(fs, ref.root);
    expect(issues.some((i) => i.check === "module-file-missing")).toBe(true);
    expect(issues.some((i) => i.check === "templates-missing")).toBe(false); // 核心 7 件都在，不误报
    await fsp.rm(ref.root, { recursive: true, force: true });

    // 老结构（00 无「启用模块」行、无 04-粗纲、无细纲目录）→ 按 14 件套口径报缺失，且不提新结构名
    const legacy = path.join(booksRoot, "老结构书");
    await fsp.mkdir(path.join(legacy, "小说资料"), { recursive: true });
    await fsp.mkdir(path.join(legacy, "章节内容"), { recursive: true });
    await fsp.mkdir(path.join(legacy, "待确认"), { recursive: true });
    await fsp.writeFile(
      path.join(legacy, "小说资料", "00-项目状态.md"),
      "# 项目状态\r\n- 当前阶段：开书准备\r\n- 当前章节：第000章\r\n- 正文处理进度：未开始\r\n",
      "utf8",
    );
    const legacyIssues = await validateProject(fs, legacy);
    const tm = legacyIssues.find((i) => i.check === "templates-missing");
    expect(tm?.message).toContain("14 件套缺");
    expect(tm?.message).not.toContain("04-粗纲");
    await fsp.rm(legacy, { recursive: true, force: true });
  });

  it("projectExists：清单缺失但有内容目录 → 也算受管（I-1 回归锁：判据与可见性统一）", async () => {
    const half = path.join(booksRoot, "半受管样本2");
    await fsp.mkdir(path.join(half, "小说资料"), { recursive: true });
    expect(await projectExists(fs, half)).toBe(true);
    expect(await projectExists(fs, path.join(booksRoot, "不存在"))).toBe(false);
    await fsp.rm(half, { recursive: true, force: true });
  });

  it("kindForRel 按路径判类；chapterLabelOf 提取章号标签", () => {
    expect(kindForRel("章节内容\\第3章.md")).toBe("chapter");
    expect(kindForRel("待确认/第3章-候选.md")).toBe("candidate");
    expect(chapterLabelOf("第3章-候选.md")).toBe("第3章");
    expect(kindForRel("待确认/第3章-v2-候选.md")).toBe("candidate");
    expect(kindForRel("待确认\\已处理\\第1章-v1-初稿.md")).toBe("candidate");
    expect(kindForRel("小说资料\\00-项目状态.md")).toBe("doc");
    expect(kindForRel("笔记.md")).toBe("doc");

    expect(chapterLabelOf("第3章-v2-候选.md")).toBe("第3章");
    expect(chapterLabelOf("第十二章 启程.md")).toBe("第十二章");
    expect(chapterLabelOf("随便一个名字.md")).toBeNull();
    // 大写数字与全角数字同样能提取（字符类与 chapter.ts 的 CHAPTER_RE 对齐）
    expect(chapterLabelOf("第壹章-v2-候选.md")).toBe("第壹章");
    expect(chapterLabelOf("第１２章-v1-初稿.md")).toBe("第１２章");
    expect(chapterLabelOf("第 3 章-v2.md")).toBe("第3章"); // 标签内部空白去除
  });
});

// —— 既有目录只读集成校验（目录不存在时自动跳过；只读不写，绝不改动真实作品）——
const REAL_BOOKS = "C:\\Users\\Administrator\\AI写小说";
describe.skipIf(!existsSync(REAL_BOOKS))("既有作品目录（只读）", () => {
  it("能列出真实作品，且迁移后的新结构完整（B9 试点）", async () => {
    const projects = await scanBooksRoot(fs, REAL_BOOKS);
    const names = projects.map((p) => p.name);
    // 只断言长期存在的真实作品：这条用例读的是真盘，作品会被用户增删
    // （"测试书籍"曾被断言在此，用户移入回收站后用例即红 —— 那不是回归）
    expect(names).toContain("和小熊同居后的日子");

    const xiong = projects.find((p) => p.name === "和小熊同居后的日子")!;
    const data = await loadProject(fs, xiong.root);
    const docNames = data.docs.map((d) => d.name);
    // 该书已完成新结构迁移（B9 试点）：核心 7 件 + 启用的两个追踪模块在
    for (const t of DOC_TEMPLATES.filter((x) =>
      ["00-项目状态.md", "01-开书定位.md", "02-核心设定.md", "03-全书大纲.md", "04-粗纲.md",
        "06-写作风格.md", "人物库.md", "追踪-伏笔.md", "追踪-角色状态.md"].includes(x.name),
    )) expect(docNames).toContain(t.name);
    // 旧结构名已归档（不在顶层）；停用的模块不在顶层
    for (const gone of ["04-分卷大纲.md", "05-滚动细纲.md", "06-写作规则.md", "追踪-时间线.md"]) {
      expect(docNames).not.toContain(gone);
    }
    // 章节按章号排序，第10章 必须排在 第2章 之后
    const chNames = data.chapters.map((c) => c.name);
    expect(chNames.indexOf("第10章.md")).toBeGreaterThan(chNames.indexOf("第2章.md"));
    expect(chNames[0]).toBe("第1章.md");
  });
});
