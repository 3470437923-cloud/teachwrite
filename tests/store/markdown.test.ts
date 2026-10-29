/**
 * 维护文档回写：把「格式优先」锁成回归测试。
 * 判定标准不是"内容看起来对"，而是"目标区间之外逐字节不变"。
 */
import { describe, expect, it } from "vitest";
import {
  appendToDoc,
  appendToSection,
  findSection,
  joinLines,
  parseSections,
  replaceInSection,
  sectionBody,
  splitLines,
} from "../../src/core/store/markdown";

/** 用户自己改过格式的维护文档（增了字段、调了结构，绝不能被"恢复模板"） */
const CUSTOM_DOC =
  "# 人物库\r\n" +
  "\r\n" +
  "## 主角\r\n" +
  "- 姓名：林晚\r\n" +
  "- 年龄：26\r\n" +
  "- 自定义字段：怕黑\r\n" +
  "\r\n" +
  "## 配角\r\n" +
  "- 姓名：老周\r\n" +
  "\r\n" +
  "## 附：用户自建小节\r\n" +
  "随手记的东西\r\n";

describe("行级拆分：保留原始 EOL", () => {
  it("CRLF 文档往返后逐字节一致", () => {
    const doc = splitLines(CUSTOM_DOC);
    expect(joinLines(doc)).toBe(CUSTOM_DOC);
  });

  it("LF 文档往返后逐字节一致", () => {
    const t = "# 世界观\n\n设定一\n设定二\n";
    expect(joinLines(splitLines(t))).toBe(t);
  });

  it("末尾无换行的文档往返后一致", () => {
    const t = "# 世界观\n设定一";
    expect(joinLines(splitLines(t))).toBe(t);
  });

  it("空文档不炸", () => {
    expect(splitLines("").lines).toEqual([""]);
    expect(joinLines(splitLines(""))).toBe("");
  });
});

describe("标题结构解析", () => {
  it("按 ATX 标题切节，节尾是下一个同级或更高级标题", () => {
    const secs = parseSections(CUSTOM_DOC);
    const titles = secs.map((s) => s.title);
    // 文档首行即标题，故没有前导无名节
    expect(titles).toEqual(["人物库", "主角", "配角", "附：用户自建小节"]);
    const zhu = secs.find((s) => s.title === "主角")!;
    expect(zhu.level).toBe(2);
    // 主角节含 4 行正文（- 姓名/- 年龄/- 自定义字段/空行）
    expect(zhu.bodyEnd - zhu.bodyStart).toBe(4);
  });

  it("标题之前有正文时，前导内容作为无名节保留", () => {
    const secs = parseSections("卷首语\n\n# 世界观\n设定\n");
    expect(secs.map((s) => s.title)).toEqual(["", "世界观"]);
    expect(secs[0].bodyStart).toBe(0);
    expect(secs[0].bodyEnd).toBe(2);
  });

  it("findSection / sectionBody 命中同一节", () => {
    expect(findSection(CUSTOM_DOC, "配角")?.title).toBe("配角");
    expect(sectionBody(CUSTOM_DOC, "配角")).toBe("- 姓名：老周\r\n\r\n");
    expect(findSection(CUSTOM_DOC, "不存在")).toBeNull();
  });

  it("无标题文档视作一个 level=0 的整篇节", () => {
    const secs = parseSections("随手记\n第二行\n");
    expect(secs).toHaveLength(1);
    expect(secs[0].headingLine).toBe(-1);
    expect(secs[0].bodyEnd).toBe(2);
  });
});

describe("appendToDoc：只在末尾追加", () => {
  it("原文档整体作为前缀逐字节不变", () => {
    const out = appendToDoc(CUSTOM_DOC, "## 新增\r\n新内容\r\n");
    expect(out.startsWith(CUSTOM_DOC)).toBe(true);
    expect(out.slice(CUSTOM_DOC.length)).toBe("## 新增\r\n新内容\r\n");
  });

  it("原文末尾无换行时先补一个换行，原文仍不变", () => {
    const out = appendToDoc("# 章节摘要\n摘要一", "摘要二");
    expect(out).toBe("# 章节摘要\n摘要一\n摘要二");
  });

  it("追加空串是恒等操作", () => {
    expect(appendToDoc(CUSTOM_DOC, "")).toBe(CUSTOM_DOC);
  });

  it("空文档追加不产生前导空行（幻影空行回归锁）", () => {
    // splitLines("") 会产出一个空行占位；若不特判，输出会凭空多出前导 EOL
    expect(appendToDoc("", "x\r\n")).toBe("x\r\n");
    expect(appendToDoc("", "x")).toBe("x");
  });
});

describe("appendToSection：节尾追加，节外不动", () => {
  it("插入到该节正文末尾、下一个标题之前", () => {
    const out = appendToSection(CUSTOM_DOC, "主角", "- 新增：怕打雷\r\n");
    expect(out).toContain("- 自定义字段：怕黑\r\n- 新增：怕打雷\r\n");
    // 配角及其后内容完全不动
    expect(out.endsWith("## 配角\r\n- 姓名：老周\r\n\r\n## 附：用户自建小节\r\n随手记的东西\r\n")).toBe(true);
  });

  it("除插入点外逐字节不变（切出插入点前后做前缀/后缀比对）", () => {
    const out = appendToSection(CUSTOM_DOC, "配角", "- 新增：话少\r\n");
    const before = CUSTOM_DOC.slice(0, CUSTOM_DOC.indexOf("- 姓名：老周") + "- 姓名：老周\r\n".length);
    const after = CUSTOM_DOC.slice(before.length);
    expect(out.startsWith(before + "- 新增：话少\r\n")).toBe(true);
    expect(out.endsWith(after)).toBe(true);
  });

  it("标题不存在时抛错（不静默新建节，避免改坏用户格式）", () => {
    expect(() => appendToSection(CUSTOM_DOC, "主线", "x")).toThrow(/未找到标题/);
  });

  it("中文标题与空白标题都能命中", () => {
    const out = appendToSection(CUSTOM_DOC, "附：用户自建小节", "又记一笔\r\n");
    expect(out).toContain("随手记的东西\r\n又记一笔\r\n");
  });

  it("追加内容不带结尾换行时自动补主导 EOL，不与下一行粘连（粘连回归锁）", () => {
    const doc = "## A\r\nx\r\n## B\r\ny\r\n";
    // 修复前会输出 "…x\r\nz## B\r\n…"——追加文本与下一节标题粘成同一行
    expect(appendToSection(doc, "A", "z")).toBe("## A\r\nx\r\nz\r\n## B\r\ny\r\n");
    // 插在文件末尾（后面没有内容）则保持无结尾换行，与 appendToDoc 语义一致
    expect(appendToSection(doc, "B", "z")).toBe("## A\r\nx\r\n## B\r\ny\r\nz");
  });
});

describe("replaceInSection：只在节内替换", () => {
  it("替换首个匹配，节外不变", () => {
    const out = replaceInSection(CUSTOM_DOC, "主角", "- 年龄：26", "- 年龄：27");
    expect(out).toContain("- 年龄：27\r\n");
    expect(out).not.toContain("- 年龄：26");
    expect(out.endsWith("## 配角\r\n- 姓名：老周\r\n\r\n## 附：用户自建小节\r\n随手记的东西\r\n")).toBe(true);
    expect(out.startsWith("# 人物库\r\n\r\n## 主角\r\n- 姓名：林晚\r\n")).toBe(true);
  });

  it("同名文本出现在别的节时不受影响", () => {
    const doc = "## A\r\n重复\r\n## B\r\n重复\r\n";
    const out = replaceInSection(doc, "B", "重复", "已改");
    expect(out).toBe("## A\r\n重复\r\n## B\r\n已改\r\n");
  });

  it("replaceAll=true 替换节内全部匹配", () => {
    const doc = "## A\r\nx\r\nx\r\n";
    expect(replaceInSection(doc, "A", "x", "y", true)).toBe("## A\r\ny\r\ny\r\n");
    expect(replaceInSection(doc, "A", "x", "y", false)).toBe("## A\r\ny\r\nx\r\n");
  });

  it("节内找不到旧文本时抛错，不误改别处", () => {
    expect(() => replaceInSection(CUSTOM_DOC, "配角", "- 年龄：26", "- 年龄：27")).toThrow(
      /未找到待替换文本/,
    );
  });

  it("节不存在时抛错", () => {
    expect(() => replaceInSection(CUSTOM_DOC, "反派", "a", "b")).toThrow(/未找到标题/);
  });

  it("替换文本中的 $& / $' 等模式按字面写入（$ 注入回归锁）", () => {
    const doc = "## A\r\nprice old end\r\n";
    // 修复前 String.replace 会把 $& 展开为匹配原文、$' 展开为匹配后文本
    expect(replaceInSection(doc, "A", "old", "$& $' x")).toBe("## A\r\nprice $& $' x end\r\n");
    expect(replaceInSection(doc, "A", "old", "$$100", true)).toBe("## A\r\nprice $$100 end\r\n");
  });
});

describe("格式优先回归：用户自定义格式在回写后不被模板化", () => {
  it("连续 3 次回写后，用户自建小节与自定义字段仍在，且除目标区间外无差异", () => {
    let doc = CUSTOM_DOC;
    doc = appendToSection(doc, "主角", "- 新增：弟弟林越\r\n");
    doc = replaceInSection(doc, "主角", "- 年龄：26", "- 年龄：27");
    doc = appendToSection(doc, "配角", "- 新增：开面馆\r\n");

    expect(doc).toContain("- 自定义字段：怕黑\r\n");
    expect(doc).toContain("## 附：用户自建小节\r\n随手记的东西\r\n");
    expect(doc).toContain("- 年龄：27\r\n");
    // 三个固定事实仍在原位
    expect(doc.startsWith("# 人物库\r\n\r\n## 主角\r\n- 姓名：林晚\r\n")).toBe(true);
    // 行数 = 原文 12 行 + 两次节尾追加各 1 行（replace 是同行替换，不增行）
    expect(splitLines(doc).lines.length).toBe(splitLines(CUSTOM_DOC).lines.length + 2);
  });
});
