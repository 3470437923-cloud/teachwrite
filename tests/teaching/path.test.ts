import { afterEach, describe, expect, it } from "vitest";
import { promises as nodeFs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createNodeFs } from "../support/nodeFs";
import { assertTrustedTeachingPath } from "../../src/core/teaching/path";
import { completeGuideStep, loadGuide, saveGuide, type ChapterGuide } from "../../src/core/teaching/guide";
import { computeReviewHash, loadReviewBatches, saveReviewBatch, type ReviewBatch } from "../../src/core/teaching/review";

const roots: string[] = [];
const fs = createNodeFs();
afterEach(async () => { for (const base of roots.splice(0)) await nodeFs.rm(base, { recursive: true, force: true }); });
const makeGuide = (): ChapterGuide => ({ schemaVersion: 1, id: "guide-1", chapter: 1, version: 1, createdAt: "2026-10-12T00:00:00.000Z", completed: [], steps: [{ title: "场景", goal: "明确目标", actions: ["观察人物选择"], facts: ["已知事实"], turn: "关系变化", transition: "下一场", completion: "作者确认" }] });
const makeBatch = (): ReviewBatch => ({ id: "batch-1", chapter: "章节内容/第1章.md", channel: "plot", createdAt: "2026-10-12T00:00:00.000Z", snapshotHash: computeReviewHash("作者原稿"), issues: [] });
async function fixture() {
  const base = await nodeFs.mkdtemp(path.join(os.tmpdir(), "teachwrite-trusted-path-"));
  roots.push(base);
  const root = path.join(base, "书");
  const body = path.join(root, "章节内容", "第1章.md");
  await fs.writeText(body, "作者原稿");
  return { base, root, body };
}
async function directoryLink(link: string, target: string) {
  await nodeFs.mkdir(path.dirname(link), { recursive: true });
  await nodeFs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

describe("导览保存与读取不能穿透链接", () => {
  it("首次保存也拒绝将导览目录链接到正文目录", async () => {
    const { root, body } = await fixture();
    await directoryLink(path.join(root, "小说资料", "写作导览"), path.dirname(body));
    await expect(saveGuide(fs, root, makeGuide())).rejects.toThrow(/链接/);
    await expect(loadGuide(fs, root, 1)).rejects.toThrow(/链接/);
    expect(await fs.readText(body)).toBe("作者原稿");
    expect(await fs.exists(path.join(path.dirname(body), "第1章-导览.md"))).toBe(false);
  });
  it.each(["root", "小说资料", "小说资料/写作导览", "小说资料/写作导览/第1章-导览.md"])("拒绝链接 %s，load 与 save 都不读取/覆盖正文", async rel => {
    const { base, root, body } = await fixture();
    const guide = makeGuide();
    await saveGuide(fs, root, guide);
    const guidePath = path.join(root, "小说资料", "写作导览", "第1章-导览.md");
    const original = await fs.readText(guidePath);
    const alias = rel === "root" ? root : path.join(root, rel);
    const backup = path.join(base, "链接目标");
    if (rel.endsWith(".md")) {
      await fs.writeText(body, original);
      await nodeFs.unlink(alias);
      await nodeFs.symlink(body, alias, "file");
    } else {
      await nodeFs.rename(alias, backup);
      await directoryLink(alias, backup);
    }
    const expectedBody = await fs.readText(body);
    await expect(loadGuide(fs, root, 1)).rejects.toThrow(/链接/);
    await expect(saveGuide(fs, root, completeGuideStep(guide, 0))).rejects.toThrow(/链接/);
    expect(await fs.readText(body)).toBe(expectedBody);
    expect(await fs.readText(guidePath)).toBe(original);
  });
  it.each(["directory", "file"] as const)("历史 %s 链接不得覆盖正文，也不得覆盖当前导览", async kind => {
    const { root, body } = await fixture();
    const guide = makeGuide();
    await saveGuide(fs, root, guide);
    const guidePath = path.join(root, "小说资料", "写作导览", "第1章-导览.md");
    const original = await fs.readText(guidePath);
    const historyDirectory = path.join(root, "小说资料", "写作导览", ".history");
    const history = path.join(historyDirectory, "第1章-v1-" + computeReviewHash(original) + ".md");
    if (kind === "directory") {
      await directoryLink(historyDirectory, path.dirname(body));
    } else {
      await nodeFs.mkdir(historyDirectory, { recursive: true });
      await fs.writeText(body, original);
      await nodeFs.symlink(body, history, "file");
    }
    const expectedBody = await fs.readText(body);
    await expect(saveGuide(fs, root, completeGuideStep(guide, 0))).rejects.toThrow(/链接/);
    expect(await fs.readText(body)).toBe(expectedBody);
    expect(await fs.readText(guidePath)).toBe(original);
    if (kind === "directory") expect(await fs.exists(path.join(path.dirname(body), path.basename(history)))).toBe(false);
  });
});

describe("审读批次不能穿透链接", () => {
  it("首次批次保存也拒绝将审读目录链接到正文目录", async () => {
    const { root, body } = await fixture();
    await directoryLink(path.join(root, "小说资料", "审核", "审读"), path.dirname(body));
    const batch = makeBatch();
    await expect(saveReviewBatch(fs, root, batch)).rejects.toThrow(/链接/);
    await expect(loadReviewBatches(fs, root, batch.chapter)).rejects.toThrow(/链接/);
    expect(await fs.readText(body)).toBe("作者原稿");
    expect(await fs.exists(path.join(path.dirname(body), "batch-1.json"))).toBe(false);
  });
  it.each(["root", "小说资料", "小说资料/审核", "小说资料/审核/审读", "小说资料/审核/审读/batch-1.json"])("拒绝链接 %s，load 与 save 均报错而不丢历史", async rel => {
    const { base, root, body } = await fixture();
    const batch = makeBatch();
    await saveReviewBatch(fs, root, batch);
    const batchPath = path.join(root, "小说资料", "审核", "审读", "batch-1.json");
    const original = await fs.readText(batchPath);
    const alias = rel === "root" ? root : path.join(root, rel);
    if (rel.endsWith(".json")) {
      await fs.writeText(body, original);
      await nodeFs.unlink(alias);
      await nodeFs.symlink(body, alias, "file");
    } else {
      const backup = path.join(base, "链接目标");
      await nodeFs.rename(alias, backup);
      await directoryLink(alias, backup);
    }
    const expectedBody = await fs.readText(body);
    await expect(loadReviewBatches(fs, root, batch.chapter)).rejects.toThrow(/链接/);
    await expect(saveReviewBatch(fs, root, batch)).rejects.toThrow(/链接/);
    expect(await fs.readText(body)).toBe(expectedBody);
    expect(await fs.readText(batchPath)).toBe(original);
  });
  it("悬空批次文件链接也拒绝，不能通过 exists=false 创建正文", async () => {
    const { root } = await fixture();
    const batch = makeBatch();
    const batchPath = path.join(root, "小说资料", "审核", "审读", "batch-1.json");
    const missingBody = path.join(root, "章节内容", "第2章.md");
    await nodeFs.mkdir(path.dirname(batchPath), { recursive: true });
    await nodeFs.symlink(missingBody, batchPath, "file");
    await expect(saveReviewBatch(fs, root, batch)).rejects.toThrow(/链接/);
    expect(await fs.exists(missingBody)).toBe(false);
  });
});


describe("教学类型路径白名单与规范路径", () => {
  it.each(["writerd_oplog", "writerd_oplog/teachwrite", "writerd_oplog/teachwrite/第1章-归档.json"])("共享 guard 也保护归档目录与文件链接 %s", async rel => {
    const { root, body } = await fixture();
    const target = path.join(root, "writerd_oplog", "teachwrite", "第1章-归档.json");
    const alias = path.join(root, rel);
    if (rel.endsWith(".json")) {
      await nodeFs.mkdir(path.dirname(alias), { recursive: true });
      await nodeFs.symlink(body, alias, "file");
    } else await directoryLink(alias, path.dirname(body));
    await expect(assertTrustedTeachingPath(fs, root, target)).rejects.toThrow(/链接/);
    expect(await fs.readText(body)).toBe("作者原稿");
  });
  it.each(["小说资料/写作导览", "小说资料/写作导览/第1章-导览.md", "小说资料/写作导览/.history/旧版.md", "小说资料/审核/审读", "小说资料/审核/审读/batch.json", "writerd_oplog/teachwrite", "writerd_oplog/teachwrite/第1章-归档.json"])("允许专用目录或其后代 %s，校验不创建任何文件", async rel => {
    const { root } = await fixture();
    const before = await fs.list(root);
    await expect(assertTrustedTeachingPath(fs, root, path.join(root, rel))).resolves.toBeUndefined();
    expect(await fs.list(root)).toEqual(before);
    expect(await fs.exists(path.join(root, rel))).toBe(false);
  });
  it.each(["章节内容/第1章.md", "待确认/候选.md", "小说资料", "小说资料/普通资料.md", "小说资料/审核", "小说资料/写作导览笔记/a.md", "小说资料/审核/审读旧稿/a.md", "writerd_oplog", "writerd_oplog/teachwrite-other/a.json"])("拒绝非类型路径 %s", async rel => {
    const { root } = await fixture();
    await expect(assertTrustedTeachingPath(fs, root, path.join(root, rel))).rejects.toThrow(/教学路径/);
  });
  it("拒绝跨作品、相对路径、未规范化穿越以及别名分隔符", async () => {
    const { base, root } = await fixture();
    const prefix = path.join(root, "小说资料", "写作导览");
    const invalid = [
      path.join(base, "另一本书", "小说资料", "写作导览", "a.md"),
      root + "其他" + path.sep + "小说资料" + path.sep + "写作导览" + path.sep + "a.md",
      "小说资料/写作导览/a.md", prefix + path.sep + ".." + path.sep + "a.md",
      prefix + path.sep + "." + path.sep + "a.md", prefix + path.sep + path.sep + "a.md",
      prefix + path.sep + "bad\u0000.md",
    ];
    if (path.sep === "/") invalid.push(prefix + "\\a.md");
    for (const target of invalid) await expect(assertTrustedTeachingPath(fs, root, target)).rejects.toThrow(/教学路径/);
    await expect(assertTrustedTeachingPath(fs, "", prefix)).rejects.toThrow(/教学路径/);
    await expect(assertTrustedTeachingPath(fs, path.join(base, "x") + path.sep + ".." + path.sep + "书", prefix)).rejects.toThrow(/教学路径/);
  });
  it("已有非目录祖先不能作为保存目录，状态读取不吞权限错误", async () => {
    const { root } = await fixture();
    const alias = path.join(root, "小说资料", "写作导览");
    await fs.writeText(alias, "非目录");
    await expect(assertTrustedTeachingPath(fs, root, path.join(alias, "a.md"))).rejects.toThrow(/教学路径/);
    await expect(assertTrustedTeachingPath({ ...fs, stat: async () => { throw new Error("permission denied"); } }, root, path.join(root, "writerd_oplog", "teachwrite", "a.json"))).rejects.toThrow("permission denied");
  });
  it("Windows 盘符与 UNC 路径按分段边界校验，拒绝 ADS 与尾部别名", async () => {
    const noFiles = { ...fs, stat: async () => null };
    for (const root of ["C:\\Books\\书", "\\\\server\\share\\书"]) {
      await expect(assertTrustedTeachingPath(noFiles, root, root + "\\小说资料\\写作导览\\a.md")).resolves.toBeUndefined();
      await expect(assertTrustedTeachingPath(noFiles, root, root + "\\writerd_oplog\\teachwrite\\第1章-归档.json")).resolves.toBeUndefined();
      for (const suffix of ["a.md:stream", "..", "a.md.", "a.md ", "NUL.md"])
        await expect(assertTrustedTeachingPath(noFiles, root, root + "\\小说资料\\写作导览\\" + suffix)).rejects.toThrow(/教学路径/);
    }
  });
});
