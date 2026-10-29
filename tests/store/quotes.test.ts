import { describe, expect, it } from "vitest";
import { unifyDoubleQuotes } from "../../src/core/store/quotes";

describe("统一引号（只转双引号，逐行交替配对）", () => {
  it("成对引号转中文开闭引号", () => {
    const r = unifyDoubleQuotes('他说"你好。"\n她答："嗯。"');
    expect(r.text).toBe("他说“你好。”\n她答：“嗯。”");
    expect(r.converted).toBe(4);
    expect(r.oddLines).toEqual([]);
  });

  it("逐行重置：跨段连续对话，每段段首仍是开引号", () => {
    const r = unifyDoubleQuotes('"第一段话，\n"第二段话。"');
    expect(r.text).toBe("“第一段话，\n“第二段话。”");
    expect(r.oddLines).toEqual([1]);
  });

  it("一行多组对话照常交替", () => {
    const r = unifyDoubleQuotes('"甲"乙"丙"丁"');
    // 5 个引号：开闭开闭开（奇数行照常转换并报行号复核）
    expect(r.text).toBe("“甲”乙“丙”丁“");
    expect(r.oddLines).toEqual([1]);
  });

  it("单引号与已有中文引号原样不动", () => {
    const r = unifyDoubleQuotes("it's “已定” 'single'");
    expect(r.text).toBe("it's “已定” 'single'");
    expect(r.converted).toBe(0);
  });

  it("空文本与无引号文本零转换", () => {
    expect(unifyDoubleQuotes("").converted).toBe(0);
    expect(unifyDoubleQuotes("没有引号的一章").text).toBe("没有引号的一章");
  });

  it("CRLF 行尾保持，行号统计不受影响", () => {
    const r = unifyDoubleQuotes('"a"\r\n"b"');
    expect(r.text).toBe("“a”\r\n“b”");
    expect(r.oddLines).toEqual([]);
  });
});
