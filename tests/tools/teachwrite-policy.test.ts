import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createNodeFs } from "../support/nodeFs";
import { executeTool, type ToolContext } from "../../src/core/tools/exec";
import { BODY_WRITE_FORBIDDEN } from "../../src/core/ai/writerPolicy";

const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "teachwrite-policy-"));
  temporary.push(base);
  const root = path.join(base, "books", "book");
  await fs.mkdir(path.join(root, "章节内容"), { recursive: true });
  await fs.mkdir(path.join(root, "小说资料"), { recursive: true });
  await fs.writeFile(path.join(root, "章节内容", "第1章.md"), "作者原稿");
  const ctx: ToolContext = { fs: createNodeFs(), booksRoot: path.join(base, "books"), snapshotsDir: path.join(base, "snapshots"), sessionId: "test", roots: { projectRoot: root, booksRoot: path.join(base, "books"), skillsDir: path.join(base, "skills") } };
  ctx.confirmWrites = true;
  return { root, ctx };
}

describe("TeachWrite AI正文权限", () => {
  for (const args of [
    { operation: "write", path: "章节内容/第1章.md", content: "AI正文" },
    { operation: "append", path: "章节内容/第1章.md", content: "AI正文" },
    { operation: "write", path: "待确认/第2章.md", content: "AI正文" },
    { operation: "write", path: "小说资料/../章节内容/第1章.md", content: "AI正文" },
  ]) it("禁止正文写入：" + args.operation + " " + args.path, async () => {
    const { root, ctx } = await fixture();
    const result = JSON.parse(await executeTool(ctx, "file_write", args));
    expect(result.error).toContain("TeachWrite");
    expect(await fs.readFile(path.join(root, "章节内容", "第1章.md"), "utf8")).toBe("作者原稿");
  });
  for (const args of [
    { operation: "delete", path: "章节内容" },
    { operation: "delete", path: "." },
    { operation: "rename", path: "章节内容/第1章.md", new_path: "小说资料/替身.md" },
    { operation: "copy", path: "小说资料", new_path: "章节内容" },
  ]) it("禁止间接变更正文：" + args.operation + " " + args.path, async () => {
    const { root, ctx } = await fixture();
    const result = JSON.parse(await executeTool(ctx, "file_manage", args));
    expect(result.error).toContain("TeachWrite");
    expect(await fs.readFile(path.join(root, "章节内容", "第1章.md"), "utf8")).toBe("作者原稿");
  });
  it("正文仍然可以读取", async () => {
    const { ctx } = await fixture();
    expect(JSON.parse(await executeTool(ctx, "file_read", {operation:"read",path:"章节内容/第1章.md"})).content).toBe("作者原稿");
  });
});


const mutations: [string, string, Record<string, unknown>][] = [
  ["write", "file_write", { operation: "write", path: "小说资料/资料.md", content: "新资料" }],
  ["append", "file_write", { operation: "append", path: "小说资料/资料.md", content: "补充" }],
  ["replace", "file_write", { operation: "replace", path: "小说资料/资料.md", old_text: "原资料", new_text: "新资料" }],
  ["insert", "file_write", { operation: "insert", path: "小说资料/资料.md", position: "start", new_text: "补充" }],
  ["delete_lines", "file_write", { operation: "delete_lines", path: "小说资料/资料.md", start_line: 1, end_line: 1 }],
  ["delete", "file_manage", { operation: "delete", path: "小说资料/资料.md" }],
  ["copy", "file_manage", { operation: "copy", path: "小说资料/资料.md", new_path: "小说资料/目标.md" }],
  ["rename", "file_manage", { operation: "rename", path: "小说资料/资料.md", new_path: "小说资料/目标.md" }],
];
async function materialsFixture() {
  const result = await fixture();
  await fs.writeFile(path.join(result.root, "小说资料", "资料.md"), "原资料\n第二行\n");
  await fs.writeFile(path.join(result.root, "小说资料", "目标.md"), "目标原资料");
  return result;
}

describe("真实会话 confirmWrites 资料变更确认", () => {
  for (const answer of ["无确认通道", "取消", "空回答"] as const) {
    it.each(mutations)(answer + "：%s 不写盘也不留快照", async (_operation, tool, args) => {
      const { root, ctx } = await materialsFixture();
      let asks = 0;
      if (answer !== "无确认通道") ctx.askQuestions = async () => { asks++; return answer === "取消" ? [["取消"]] : []; };
      const result = JSON.parse(await executeTool(ctx, tool, args));
      expect(result.error).toBe("作者未确认资料变更。");
      expect(asks).toBe(answer === "无确认通道" ? 0 : 1);
      expect(await fs.readFile(path.join(root, "小说资料", "资料.md"), "utf8")).toBe("原资料\n第二行\n");
      expect(await fs.readFile(path.join(root, "小说资料", "目标.md"), "utf8")).toBe("目标原资料");
      expect(await ctx.fs.exists(path.join(ctx.snapshotsDir, "test.json"))).toBe(false);
    });
  }
  it.each(mutations)("确认修改后 %s 才执行并保留写前快照", async (operation, tool, args) => {
    const { root, ctx } = await materialsFixture();
    let asks = 0;
    ctx.askQuestions = async questions => {
      asks++;
      expect(questions[0].question).toContain("确认资料变更");
      expect(questions[0].options.map(option => option.label)).toEqual(["确认修改", "取消"]);
      expect(await fs.readFile(path.join(root, "小说资料", "资料.md"), "utf8")).toBe("原资料\n第二行\n");
      expect(await fs.readFile(path.join(root, "小说资料", "目标.md"), "utf8")).toBe("目标原资料");
      expect(await ctx.fs.exists(path.join(ctx.snapshotsDir, "test.json"))).toBe(false);
      return [["确认修改"]];
    };
    const result = JSON.parse(await executeTool(ctx, tool, args));
    expect(result.success).toBe(true);
    expect(asks).toBe(1);
    const snapshot = JSON.parse(await ctx.fs.readText(path.join(ctx.snapshotsDir, "test.json")));
    expect(snapshot.snapshots.length).toBeGreaterThan(0);
    expect(snapshot.snapshots.some((entry: { previousContent: string }) => entry.previousContent === "原资料\n第二行\n")).toBe(operation !== "copy");
    if (operation === "delete" || operation === "rename") expect(await ctx.fs.exists(path.join(root, "小说资料", "资料.md"))).toBe(false);
    else if (operation !== "copy") expect(await ctx.fs.readText(path.join(root, "小说资料", "资料.md"))).not.toBe("原资料\n第二行\n");
    if (operation === "copy" || operation === "rename") expect(await ctx.fs.readText(path.join(root, "小说资料", "目标.md"))).toBe("原资料\n第二行\n");
  });
  it("同一会话每次变更都重新确认，先确认不授权后续取消", async () => {
    const { root, ctx } = await materialsFixture();
    let asks = 0;
    ctx.askQuestions = async () => [[++asks === 1 ? "确认修改" : "取消"]];
    const first = JSON.parse(await executeTool(ctx, "file_write", { operation: "append", path: "小说资料/资料.md", content: "第一次" }));
    expect(first.success).toBe(true);
    const snapshotBefore = await ctx.fs.readText(path.join(ctx.snapshotsDir, "test.json"));
    const second = JSON.parse(await executeTool(ctx, "file_write", { operation: "append", path: "小说资料/资料.md", content: "第二次" }));
    expect(second.error).toBe("作者未确认资料变更。");
    expect(asks).toBe(2);
    expect(await fs.readFile(path.join(root, "小说资料", "资料.md"), "utf8")).toBe("原资料\n第二行\n第一次");
    expect(await ctx.fs.readText(path.join(ctx.snapshotsDir, "test.json"))).toBe(snapshotBefore);
  });
});

describe("链接祖先与作者状态保留目录", () => {
  it.each(["source", "destination"] as const)("目录 copy 的 %s 深层子树内嵌链接也拒绝", async linkSide => {
    const { root, ctx } = await fixture();
    const source = path.join(root, "小说资料", "源目录");
    const destination = path.join(root, "小说资料", "目标目录");
    const linkedTree = linkSide === "source" ? source : destination;
    const ordinaryTree = linkSide === "source" ? destination : source;
    await fs.mkdir(path.join(linkedTree, "深层"), { recursive: true });
    await fs.mkdir(path.join(ordinaryTree, "深层", "别名"), { recursive: true });
    await fs.writeFile(path.join(ordinaryTree, "深层", "别名", "第1章.md"), "目录资料不能覆盖正文");
    await fs.symlink(path.join(root, "章节内容"), path.join(linkedTree, "深层", "别名"), process.platform === "win32" ? "junction" : "dir");
    let asks = 0;
    ctx.askQuestions = async () => { asks++; return [["确认修改"]]; };
    const result = JSON.parse(await executeTool(ctx, "file_manage", { operation: "copy", path: "小说资料/源目录", new_path: "小说资料/目标目录" }));
    expect(result.error).toBe(BODY_WRITE_FORBIDDEN);
    expect(asks).toBe(0);
    expect(await fs.readFile(path.join(root, "章节内容", "第1章.md"), "utf8")).toBe("作者原稿");
    expect(await fs.readFile(path.join(ordinaryTree, "深层", "别名", "第1章.md"), "utf8")).toBe("目录资料不能覆盖正文");
    expect(await ctx.fs.exists(path.join(ctx.snapshotsDir, "test.json"))).toBe(false);
  });
  it.each(["delete", "rename"])("不能通过 %s 审核祖先目录移除作者审读状态", async operation => {
    const { root, ctx } = await fixture();
    const target = path.join(root, "小说资料", "审核", "审读", "batch.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "作者处理状态");
    let asks = 0;
    ctx.askQuestions = async () => { asks++; return [["确认修改"]]; };
    const result = JSON.parse(await executeTool(ctx, "file_manage", { operation, path: "小说资料/审核", new_path: "小说资料/改名审核" }));
    expect(result.error).toBe(BODY_WRITE_FORBIDDEN);
    expect(asks).toBe(0);
    expect(await fs.readFile(target, "utf8")).toBe("作者处理状态");
    expect(await ctx.fs.exists(path.join(root, "小说资料", "改名审核"))).toBe(false);
    expect(await ctx.fs.exists(path.join(ctx.snapshotsDir, "test.json"))).toBe(false);
  });
  it("真实目录链接祖先指向正文也不能写入", async () => {
    const { root, ctx } = await fixture();
    const alias = path.join(root, "小说资料", "别名");
    await fs.symlink(path.join(root, "章节内容"), alias, process.platform === "win32" ? "junction" : "dir");
    let asks = 0;
    ctx.askQuestions = async () => { asks++; return [["确认修改"]]; };
    const result = JSON.parse(await executeTool(ctx, "file_write", { operation: "write", path: "小说资料/别名/第1章.md", content: "AI不得替写" }));
    expect(result.error).toMatch(/TeachWrite|链接/);
    expect(asks).toBe(0);
    expect(await fs.readFile(path.join(root, "章节内容", "第1章.md"), "utf8")).toBe("作者原稿");
    expect(await ctx.fs.exists(path.join(ctx.snapshotsDir, "test.json"))).toBe(false);
  });
  it.each(["小说资料/写作导览/第1章-导览.md", "小说资料/审核/审读/batch.json"])("AI 不能覆盖作者状态：%s", async reserved => {
    const { root, ctx } = await materialsFixture();
    const target = path.join(root, reserved);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "作者状态记录");
    let asks = 0;
    ctx.askQuestions = async () => { asks++; return [["确认修改"]]; };
    const actions: [string, Record<string, unknown>][] = [
      ["file_write", { operation: "write", path: reserved, content: "伪造状态" }],
      ["file_write", { operation: "append", path: reserved, content: "伪造状态" }],
      ["file_manage", { operation: "delete", path: reserved }],
      ["file_manage", { operation: "copy", path: "小说资料/资料.md", new_path: reserved }],
      ["file_manage", { operation: "rename", path: reserved, new_path: "小说资料/移出状态.md" }],
      ["file_manage", { operation: "delete", path: reserved.slice(0, reserved.lastIndexOf("/")) }],
    ];
    for (const [tool, args] of actions) {
      const result = JSON.parse(await executeTool(ctx, tool, args));
      expect(result.error).toBe(BODY_WRITE_FORBIDDEN);
      expect(await fs.readFile(target, "utf8")).toBe("作者状态记录");
    }
    expect(asks).toBe(0);
    expect(await ctx.fs.exists(path.join(ctx.snapshotsDir, "test.json"))).toBe(false);
  });
});
