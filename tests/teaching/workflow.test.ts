import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFs } from "../support/nodeFs";
import { archiveGateReason, archiveMatches, canConfirmArchive, nextChapter, sameTeachingContext, selectGuideTarget, teachingContext, loadArchive, saveArchive } from "../../src/core/teaching/workflow";

const chapter = (no: number, content: string) => ({ name: "第" + no + "章.md", path: "/book/章节内容/第" + no + "章.md", content });
const archive = { chapter: 1, content: "作者正文", archivedAt: "2026-10-14T00:00:00.000Z" };

describe("导览目标选择", () => {
  it("首章可以开始；已有章按章号而非文件数确定下一章", () => {
    expect(nextChapter([])).toBe(1);
    expect(nextChapter(["第2章.md", "第10章 归来.md", "前言.md"])).toBe(11);
  });
  it("优先当前空白正文，不能跳过空白章要求它归档", () => {
    expect(selectGuideTarget([chapter(1, "")], chapter(1, "").path, [])).toBe(1);
    expect(selectGuideTarget([chapter(1, "正文"), chapter(2, "  \n")], chapter(2, "").path, [])).toBe(2);
  });
  it("使用内存正文选择，尚未保存的写作不能被误认为空白", () => {
    expect(selectGuideTarget([chapter(1, "正在手写")], chapter(1, "").path, [])).toBe(2);
  });
  it("优先已有导览但正文尚空或尚未创建的章节", () => {
    expect(selectGuideTarget([chapter(1, "正文")], null, [2])).toBe(2);
    expect(selectGuideTarget([chapter(1, "正文"), chapter(2, "")], null, [2])).toBe(2);
    expect(selectGuideTarget([chapter(1, "正文"), chapter(2, "正文")], null, [1, 2])).toBe(3);
  });
  it("没有活动章节时复用已有空白稿，不制造更高章号", () => {
    expect(selectGuideTarget([chapter(1, ""), chapter(2, "")], null, [])).toBe(1);
  });
});

describe("归档正文快照门", () => {
  it("归档必须对应当前正文，不因勾选或回流发出而自动完成", () => {
    expect(archiveMatches(null, "作者正文")).toBe(false);
    expect(archiveMatches(archive, "作者正文")).toBe(true);
    expect(archiveMatches(archive, "改过正文")).toBe(false);
    expect(archiveMatches(archive, "作者正文\n")).toBe(false);
  });
  it("同长度不同正文不能通过hash门", () => {
    expect(archiveMatches(archive, "别人正文")).toBe(false);
  });
  it("非活动正文标签未保存时也阻止解锁", () => {
    expect(archiveGateReason(archive, "作者正文", ["作者正文", "作者新正文"])).toContain("未保存");
    expect(archiveGateReason(archive, "作者正文", ["作者正文"])).toBeNull();
    expect(archiveGateReason(null, "作者正文", [])).toContain("归档");
    expect(archiveGateReason(archive, "已经改动", [])).toContain("归档");
  });
  it("最终确认后仍检查停止、失败、快照与当前上下文", () => {
    const input = { aborted: false, failed: false, contextMatches: true, source: "作者正文", disk: "作者正文", open: ["作者正文"] };
    expect(canConfirmArchive(input)).toBe(true);
    for (const patch of [{ aborted: true }, { failed: true }, { contextMatches: false }, { disk: "正文已改" }, { open: ["未保存改动"] }])
      expect(canConfirmArchive({ ...input, ...patch })).toBe(false);
  });
});

describe("教学资料读取边界", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "teachwrite-workflow-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("归档凭据文件为正文链接时，读取与写入都明确拒绝", async () => {
    const body = join(root, "章节内容", "第1章.md"); const destination = join(root, "writerd_oplog", "teachwrite");
    await mkdir(join(root, "章节内容")); await mkdir(destination, { recursive: true });
    await writeFile(body, "作者正文"); await symlink(body, join(destination, "第1章-归档.json"));
    await expect(loadArchive(createNodeFs(), root, 1)).rejects.toThrow("链接");
    await expect(saveArchive(createNodeFs(), root, archive)).rejects.toThrow("链接");
    expect(await readFile(body, "utf8")).toBe("作者正文");
  });
  it("路径校验后最终确认失效时不写归档凭据", async () => {
    await expect(saveArchive(createNodeFs(), root, archive, () => false)).rejects.toThrow("确认");
    expect(await createNodeFs().exists(join(root, "writerd_oplog", "teachwrite", "第1章-归档.json"))).toBe(false);
  });
  it("小说资料根为链接时明确拒绝，不把链接目标送给AI", async () => {
    const destination = join(root, "章节内容"); await mkdir(destination);
    await writeFile(join(destination, "第1章.md"), "作者正文");
    await symlink(destination, join(root, "小说资料"), process.platform === "win32" ? "junction" : "dir");
    await expect(teachingContext(createNodeFs(), root)).rejects.toThrow("链接");
  });
});

describe("教学异步上下文", () => {
  it("同名章节跨作品或离开后返回也不能接收旧任务UI结果", () => {
    const token = { root: "/a", rel: "章节内容/第1章.md", epoch: 1 };
    expect(sameTeachingContext(token, { ...token })).toBe(true);
    expect(sameTeachingContext(token, { ...token, root: "/b" })).toBe(false);
    expect(sameTeachingContext(token, { ...token, rel: "章节内容/第2章.md" })).toBe(false);
    expect(sameTeachingContext(token, { ...token, epoch: 3 })).toBe(false);
  });
});
