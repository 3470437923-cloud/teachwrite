import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "../../src/core/dirs";
import { createNodeFs } from "../support/nodeFs";
import { computeReviewHash, parseReviewResponse, locateReviewQuote, saveReviewBatch, loadReviewBatches, type ReviewBatch } from "../../src/core/teaching/review";

const raw = { category: "连贯断裂", quote: "窗户关着。", problem: "动作缺少衔接", basis: "前后状态不一致", impact: "读者无法确认空间关系", direction: "核对动作发生的顺序" };
const parse = (value: unknown, source = raw.quote) => parseReviewResponse(JSON.stringify(value), source);

describe("审读严格 schema", () => {
  it("精确保存六字段并由程序分配身份和 pending 状态", () => {
    const [issue] = parse([raw]);
    expect(issue).toMatchObject({ ...raw, status: "pending", startLine: 1 });
    expect(issue.id).toBeTruthy();
    expect(issue.snapshotHash).toBe(createHash("sha256").update(raw.quote).digest("hex"));
    expect(parse([])).toEqual([]);
  });
  it.each([null, {}, { issues: [raw] }, "[]", [null], [1], [raw, {}]])("拒绝非数组或任一畸形条目 %#", value => {
    expect(() => parse(value)).toThrow();
  });
  it.each(["category", "quote", "problem", "basis", "impact", "direction"])("拒绝缺少或非字符串的 %s", field => {
    const missing: Record<string, unknown> = { ...raw };
    delete missing[field];
    expect(() => parse([missing])).toThrow();
    expect(() => parse([{ ...raw, [field]: 3 }])).toThrow();
    if (field !== "quote") expect(() => parse([{ ...raw, [field]: "  " }])).toThrow();
  });
  it.each(["replacement", "rewrite", "example", "status", "snapshotHash"])("拒绝额外字段 %s", field => {
    expect(() => parse([{ ...raw, [field]: "不能由模型传入" }])).toThrow();
  });
  it("拒绝 markdown 包装或散文包裹的 JSON", () => {
    expect(() => parseReviewResponse("说明" + JSON.stringify([raw]), raw.quote)).toThrow();
    expect(() => parseReviewResponse("```json\n" + JSON.stringify([raw]) + "```", raw.quote)).toThrow();
  });
  it("拒绝虚构原文；只有空 quote 表示整体问题", () => {
    expect(() => parse([raw], "不存在此句")).toThrow();
    const [whole] = parse([{ ...raw, quote: "" }]);
    expect(whole.startLine).toBeUndefined();
    expect(locateReviewQuote(raw.quote, whole)).toBeNull();
    expect(() => parse([{ ...raw, quote: "", startLine: 1 }])).toThrow();
  });
});

describe("原文定位", () => {
  it("重复引文必须由 startLine 唯一消歧，同一行重复仍拒绝", () => {
    const source = raw.quote + "\n过渡\n" + raw.quote;
    expect(() => parse([raw], source)).toThrow(/歧义/);
    const [issue] = parse([{ ...raw, startLine: 3 }], source);
    expect(locateReviewQuote(source, issue)).toEqual({ start: source.lastIndexOf(raw.quote), end: source.length, startLine: 3, endLine: 3 });
    expect(() => parse([{ ...raw, startLine: 2 }], source)).toThrow();
    expect(() => parse([{ ...raw, startLine: 1 }], raw.quote.repeat(2))).toThrow(/歧义/);
  });
  it.each([0, -1, 1.5, "1", null])("拒绝非法 startLine %s", startLine => {
    expect(() => parse([{ ...raw, startLine }])).toThrow();
  });
  it.each(["\n", "\r\n"])("支持换行 %j、跨行引用及 UTF-16 offset", newline => {
    const quote = "窗户" + newline + "关着。";
    const source = "😀门外。" + newline + quote + newline;
    const [issue] = parse([{ ...raw, quote }], source);
    const position = locateReviewQuote(source, issue)!;
    expect(position).toEqual({ start: source.indexOf(quote), end: source.indexOf(quote) + quote.length, startLine: 2, endLine: 3 });
    expect(source.slice(position.start, position.end)).toBe(quote);
  });
  it("即使引文仍存在，正文修改后也不跳转", () => {
    const [issue] = parse([raw]);
    expect(locateReviewQuote("别处增加文字\n" + raw.quote, issue)).toBeNull();
    expect(locateReviewQuote(raw.quote + "改", issue)).toBeNull();
    expect(locateReviewQuote(raw.quote, { ...issue, startLine: 2 })).toBeNull();
  });
  it.each(["", "abc", "你好😀", "a".repeat(1000)])("快照为真实 SHA-256 %#", source => {
    const [issue] = parse([{ ...raw, quote: "" }], source);
    expect(issue.snapshotHash).toBe(createHash("sha256").update(source).digest("hex"));
    expect(computeReviewHash(source)).toBe(issue.snapshotHash);
  });
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "teachwrite-review-"));
  roots.push(root);
  const fs = createNodeFs();
  const issues = parse([raw]);
  const batch: ReviewBatch = { id: "batch-1", chapter: "章节内容/第1章.md", channel: "plot", createdAt: "2026-10-15T12:00:00.000Z", snapshotHash: issues[0].snapshotHash, issues };
  return { fs, root, batch };
}

describe("永久批次与作者状态", () => {
  it("新作品无批次；两个通道与多批次均保留，只按章节读取", async () => {
    const { fs, root, batch } = await setup();
    expect(await loadReviewBatches(fs, root, batch.chapter)).toEqual([]);
    await saveReviewBatch(fs, root, batch);
    const second: ReviewBatch = { ...batch, id: "batch-2", channel: "style", createdAt: "2026-10-15T13:00:00.000Z" };
    await saveReviewBatch(fs, root, second);
    await saveReviewBatch(fs, root, { ...batch, id: "batch-3", chapter: "章节内容/第2章.md" });
    expect(await loadReviewBatches(fs, root, batch.chapter)).toEqual([second, batch]);
    expect((await fs.list(join(root, "小说资料", "审核", "审读"))).length).toBeGreaterThan(0);
  });
  it("重复保存允许 accepted/ignored 持久化，不能覆盖原意见或快照", async () => {
    const { fs, root, batch } = await setup();
    await saveReviewBatch(fs, root, batch);
    for (const status of ["accepted", "ignored", "pending"] as const) {
      batch.issues[0].status = status;
      await saveReviewBatch(fs, root, batch);
      expect((await loadReviewBatches(fs, root, batch.chapter))[0].issues[0].status).toBe(status);
    }
    await expect(saveReviewBatch(fs, root, { ...batch, issues: [{ ...batch.issues[0], direction: "覆盖旧意见" }] })).rejects.toThrow();
    await expect(saveReviewBatch(fs, root, { ...batch, snapshotHash: "0".repeat(64) })).rejects.toThrow();
    expect((await loadReviewBatches(fs, root, batch.chapter))[0]).toEqual(batch);
  });
  it("并发同 ID 不能绕过旧批次保护", async () => {
    const { fs, root, batch } = await setup();
    const changed = { ...batch, issues: [{ ...batch.issues[0], direction: "覆盖旧意见" }] };
    const results = await Promise.allSettled([saveReviewBatch(fs, root, batch), saveReviewBatch(fs, root, changed)]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(await loadReviewBatches(fs, root, batch.chapter)).toEqual([batch]);
  });
  it("保存捕获调用时状态，排队期间作者对象变化不污染快照", async () => {
    const { fs, root, batch } = await setup();
    const saving = saveReviewBatch(fs, root, batch);
    batch.issues[0].status = "accepted";
    await saving;
    expect((await loadReviewBatches(fs, root, batch.chapter))[0].issues[0].status).toBe("pending");
  });
  it("拒绝路径逃逸 id、非法状态与不一致快照", async () => {
    const { fs, root, batch } = await setup();
    for (const id of ["../escape", "a/b", "a\\b", "", ".", "x:"]) {
      await expect(saveReviewBatch(fs, root, { ...batch, id })).rejects.toThrow();
    }
    await expect(saveReviewBatch(fs, root, { ...batch, issues: [{ ...batch.issues[0], status: "rewritten" as never }] })).rejects.toThrow();
    await expect(saveReviewBatch(fs, root, { ...batch, snapshotHash: "0".repeat(64) })).rejects.toThrow();
  });
});
