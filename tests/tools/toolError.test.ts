/** N-42 回归锁：工具失败判定只认 {"error":"…"} 的结构，不做子串嗅探 */
import { describe, expect, it } from "vitest";
import { isToolErrorResult } from "../../src/core/tools/exec";

describe("isToolErrorResult", () => {
  it("契约失败形态（err() 的输出）判为失败", () => {
    expect(isToolErrorResult(JSON.stringify({ error: "operation is required" }))).toBe(true);
    expect(isToolErrorResult('{"error":"路径越权"}')).toBe(true);
  });

  it("成功结果里内容含 error 字样不误标（子串嗅探时代的隐患）", () => {
    // file_read 成功：文件内容里带引号的 "error" 字样
    const read = JSON.stringify({ path: "a.md", content: 'the "error" word and {"error":"x"} sample' });
    expect(isToolErrorResult(read)).toBe(false);
    // search 成功：命中行里有 error
    const search = JSON.stringify({
      success: true,
      search_text: "error",
      results: [{ file: "a.md", matches: [{ line: 3, content: '"error" 出现在这行' }] }],
      files_found: 1,
      files_skipped: 0,
    });
    expect(isToolErrorResult(search)).toBe(false);
    // question 成功：答案文本就是 "error"
    const q = JSON.stringify({ output: 'User has answered: "error". continue.', answers: ['"error"'] });
    expect(isToolErrorResult(q)).toBe(false);
  });

  it("多键对象即使带 error 字段也不算契约失败形态", () => {
    expect(isToolErrorResult('{"error":"x","success":true}')).toBe(false);
  });

  it("空值 / 非 JSON / 非对象一律不是失败", () => {
    expect(isToolErrorResult(null)).toBe(false);
    expect(isToolErrorResult(undefined)).toBe(false);
    expect(isToolErrorResult("")).toBe(false);
    expect(isToolErrorResult("plain text mentioning {\"error\": …}")).toBe(false);
    expect(isToolErrorResult('["error"]')).toBe(false);
    expect(isToolErrorResult('{"error":123}')).toBe(false);
  });
});
