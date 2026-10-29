/**
 * 工具层：结果 JSON 的字段与形态保持既有格式（1,729 条实测调用结果实证）。
 * 同时锁路径分级授权（含 search 的 directory 参数、盘符根、'..' 穿越）、
 * 写前快照（含目录 delete 的 previousType）与文本编辑的字面量语义（$ 模式不展开）。
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeFs } from "../support/nodeFs";
import { executeTool, normalizeQuestions, type ToolContext } from "../../src/core/tools/exec";
import { NEEDS_CONFIRMATION_PREFIX } from "../../src/core/tools/pathGuard";
import { BODY_WRITE_FORBIDDEN } from "../../src/core/ai/writerPolicy";
import { parseSnapshots } from "../../src/core/store/snapshot";
// 工具结果里"项目根相对路径"字段（list 的条目 path / search 的 file）用**本机分隔符**：
// Windows '\'（既有实测样本逐字不变）、macOS '/'。期望值用被测代码自己的 join 构造，
// 两平台验证同一条语义。注意与 `path.join`（node:path，真实磁盘 I/O）区分开。
import { join as joinRel, PATH_SEP } from "../../src/core/dirs";

let root: string;
let booksRoot: string;
let skillsDir: string;
let snapshotsDir: string;
const fs = createNodeFs();

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    fs,
    booksRoot,
    snapshotsDir,
    sessionId: "sess-1",
    currentCallId: "call_1",
    roots: { projectRoot: root, skillsDir, booksRoot },
    ...over,
  };
}

beforeAll(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "deepcompose-tools-"));
  booksRoot = path.join(base, "AI写小说");
  root = path.join(booksRoot, "测试书籍");
  skillsDir = path.join(base, "skills");
  snapshotsDir = path.join(base, "snapshots");
  await fsp.mkdir(path.join(root, "小说资料"), { recursive: true });
  await fsp.mkdir(path.join(root, "章节内容"), { recursive: true });
  await fsp.mkdir(skillsDir, { recursive: true });
  await fsp.mkdir(snapshotsDir, { recursive: true });
  await fsp.writeFile(path.join(root, "小说资料", "世界观.md"), "# 世界观\r\n\r\n设定一\r\n", "utf8");
  await fsp.writeFile(path.join(root, "章节内容", "第1章.md"), "第一行\n第二行\n第三行\n", "utf8");
  await fsp.writeFile(path.join(root, "章节内容", "第2章.md"), "另一章\n", "utf8");
  await fsp.writeFile(path.join(root, "小说资料", "格式测试1.md"), "第一行\n第二行\n第三行\n", "utf8");
});

afterAll(async () => {
  await fsp.rm(path.dirname(root), { recursive: true, force: true });
});

describe("file_read", () => {
  it("operation 缺失 → 逐字错误", async () => {
    expect(await executeTool(ctx(), "file_read", {})).toBe('{"error":"operation is required"}');
  });
  it("path 缺失 → 逐字错误", async () => {
    expect(await executeTool(ctx(), "file_read", { operation: "read" })).toBe('{"error":"path is required"}');
  });

  it("read → {path, content}，路径用 '/'", async () => {
    const r = JSON.parse(await executeTool(ctx(), "file_read", { operation: "read", path: "小说资料/世界观.md" }));
    expect(r.path).toBe("小说资料/世界观.md");
    expect(r.content).toContain("# 世界观");
  });

  it("read 支持 offset/limit 分页（1-based 行号）", async () => {
    const r = JSON.parse(
      await executeTool(ctx(), "file_read", { operation: "read", path: "章节内容/第1章.md", offset: 2, limit: 1 }),
    );
    expect(r.content).toBe("第二行");
  });

  it("list → {path, files:[{name,path,type,size}]}，条目 path 用本机分隔符且相对项目根", async () => {
    const r = JSON.parse(await executeTool(ctx(), "file_read", { operation: "list", path: "章节内容" }));
    expect(r.path).toBe("章节内容");
    expect(r.files).toHaveLength(2);
    const f = r.files.find((x: { name: string }) => x.name === "第1章.md");
    expect(f.type).toBe("file");
    expect(f.path).toBe(joinRel("章节内容", "第1章.md"));
    expect(typeof f.size).toBe("number");
  });

  it("list 目录 → type=directory, size=null", async () => {
    const r = JSON.parse(await executeTool(ctx(), "file_read", { operation: "list", path: "." }));
    const dir = r.files.find((x: { name: string }) => x.name === "章节内容");
    expect(dir.type).toBe("directory");
    expect(dir.size).toBeNull();
  });

  it("list 排序与 Rust fs_list 同口径：目录在前，再按名称大小写不敏感", async () => {
    // 造两个乱序文件验证排序（nodeFs 替身与 Rust fs_list 同一排序规则）；测完清理
    await fsp.writeFile(path.join(root, "zzz.md"), "z\n", "utf8");
    await fsp.writeFile(path.join(root, "AAA.md"), "a\n", "utf8");
    const r = JSON.parse(await executeTool(ctx(), "file_read", { operation: "list", path: "." }));
    const names: string[] = r.files.map((x: { name: string }) => x.name);
    // 目录段在前（码点序：小说资料 < 章节内容），文件段在后（小写比较：aaa < zzz）
    expect(names).toEqual(["小说资料", "章节内容", "AAA.md", "zzz.md"]);
    await fsp.rm(path.join(root, "zzz.md"));
    await fsp.rm(path.join(root, "AAA.md"));
  });

  it("不存在的路径 → 逐字 Directory not found", async () => {
    const r = JSON.parse(await executeTool(ctx(), "file_read", { operation: "read", path: "小说资料/不存在.md" }));
    expect(r.error).toBe("Directory not found: 小说资料/不存在.md");
  });
});

describe("file_write", () => {
  it("校验文案逐字（含操作差异）", async () => {
    const c = ctx();
    expect(await executeTool(c, "file_write", {})).toBe('{"error":"operation is required"}');
    expect(await executeTool(c, "file_write", { operation: "write" })).toBe('{"error":"path is required"}');
    expect(await executeTool(c, "file_write", { operation: "write", path: "a.md" })).toBe(
      '{"error":"content is required for write operation"}',
    );
    expect(await executeTool(c, "file_write", { operation: "append", path: "a.md" })).toBe(
      '{"error":"content is required for append operation"}',
    );
    expect(await executeTool(c, "file_write", { operation: "replace", path: "a.md" })).toBe(
      '{"error":"old_text is required for replace operation"}',
    );
    expect(await executeTool(c, "file_write", { operation: "insert", path: "a.md" })).toBe(
      '{"error":"new_text is required for insert operation"}',
    );
    expect(await executeTool(c, "file_write", { operation: "delete_lines", path: "a.md" })).toBe(
      '{"error":"start_line and end_line are required for delete_lines operation"}',
    );
    expect(await executeTool(c, "file_write", { operation: "wat", path: "a.md" })).toBe(
      '{"error":"Unknown operation: wat"}',
    );
  });

  it("write → {success,operation,path,bytes_written}", async () => {
    const r = JSON.parse(
      await executeTool(ctx(), "file_write", { operation: "write", path: "小说资料/格式测试3.md", content: "正文" }),
    );
    expect(r).toEqual({
      success: true,
      operation: "write",
      path: "小说资料/格式测试3.md",
      bytes_written: 6,
    });
    expect(await fsp.readFile(path.join(root, "小说资料", "格式测试3.md"), "utf8")).toBe("正文");
  });

  it("append → 只给 success/operation/path", async () => {
    // 路径用 小说资料/世界观.md（用户自建文档不受落点校验；章节摘要.md 是旧结构名，
    // 新建会被「以后只能是硬格式」拦截，不再适合做中性的 append 形状用例）
    const r = JSON.parse(
      await executeTool(ctx(), "file_write", { operation: "append", path: "小说资料/世界观.md", content: "## 第1章 摘要\n" }),
    );
    expect(r).toEqual({ success: true, operation: "append", path: "小说资料/世界观.md" });
  });

  it("replace → 带 replace_all 字段；默认只替换首个", async () => {
    await fsp.writeFile(path.join(root, "小说资料", "格式测试4.md"), "甲甲甲\n", "utf8");
    const r1 = JSON.parse(
      await executeTool(ctx(), "file_write", { operation: "replace", path: "小说资料/格式测试4.md", old_text: "甲", new_text: "乙" }),
    );
    expect(r1).toEqual({ success: true, operation: "replace", path: "小说资料/格式测试4.md", replace_all: false });
    expect(await fsp.readFile(path.join(root, "小说资料", "格式测试4.md"), "utf8")).toBe("乙甲甲\n");

    const r2 = JSON.parse(
      await executeTool(ctx(), "file_write", {
        operation: "replace",
        path: "小说资料/格式测试4.md",
        old_text: "甲",
        new_text: "乙",
        replace_all: true,
      }),
    );
    expect(r2.replace_all).toBe(true);
    expect(await fsp.readFile(path.join(root, "小说资料", "格式测试4.md"), "utf8")).toBe("乙乙乙\n");
  });

  it("delete_lines → 带 deleted_lines，保留原 CRLF", async () => {
    await fsp.writeFile(path.join(root, "小说资料", "格式测试5.md"), "一\r\n二\r\n三\r\n", "utf8");
    const r = JSON.parse(
      await executeTool(ctx(), "file_write", {
        operation: "delete_lines",
        path: "小说资料/格式测试5.md",
        start_line: 2,
        end_line: 2,
      }),
    );
    expect(r.deleted_lines).toBe(1);
    expect(await fsp.readFile(path.join(root, "小说资料", "格式测试5.md"), "utf8")).toBe("一\r\n三\r\n");
  });

  it("每次写入都落一条快照（实测样本：写前内容 + 写后哈希）", async () => {
    const s = parseSnapshots(await fsp.readFile(path.join(snapshotsDir, "sess-1.json"), "utf8"), "sess-1");
    expect(s.snapshots.length).toBeGreaterThan(0);
    const last = s.snapshots[s.snapshots.length - 1];
    expect(last.sessionId).toBe("sess-1");
    expect(last.callId).toBe("call_1");
    expect(last.operation).toBe("delete_lines");
    expect(last.relativePath).toBe("小说资料/格式测试5.md");
    expect(last.previousContent).toBe("一\r\n二\r\n三\r\n");
    expect(last.postContentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replace：new_text 里的 $ 模式按字面量写入（回归锁：曾被 String.replace 展开成匹配文本）", async () => {
    await fsp.writeFile(path.join(root, "小说资料", "价格表.md"), "原价A元\n", "utf8");
    const r = JSON.parse(
      await executeTool(ctx(), "file_write", {
        operation: "replace",
        path: "小说资料/价格表.md",
        old_text: "A",
        new_text: "100$&",
      }),
    );
    expect(r.success).toBe(true);
    // $& 在 String.replace 语义里是"匹配文本"；修复后必须原样写字面量 "100$&" 而不是 "100A"
    expect(await fsp.readFile(path.join(root, "小说资料", "价格表.md"), "utf8")).toBe("原价100$&元\n");
  });

  it("write/append：content 为 JSON null → 按缺参报错，不写出字面量 \"null\"", async () => {
    expect(
      await executeTool(ctx(), "file_write", { operation: "write", path: "小说资料/坏null.md", content: null }),
    ).toBe('{"error":"content is required for write operation"}');
    expect(await fs.exists(path.join(root, "小说资料", "坏null.md"))).toBe(false);
    expect(
      await executeTool(ctx(), "file_write", { operation: "append", path: "小说资料/坏null.md", content: null }),
    ).toBe('{"error":"content is required for append operation"}');
    expect(await fs.exists(path.join(root, "小说资料", "坏null.md"))).toBe(false);
  });

  it("replace：多行 old_text 用 LF 也能命中 CRLF 原文（回归锁：读回路归一化导致必炸）", async () => {
    // file_read 分页结果统一以 '\n' 连接，模型拿它构造多行 old_text 时与 CRLF 原文对不上
    await fsp.writeFile(path.join(root, "小说资料", "格式测试6.md"), "第一段\r\n第二段\r\n第三段\r\n", "utf8");
    const r = JSON.parse(
      await executeTool(ctx(), "file_write", {
        operation: "replace",
        path: "小说资料/格式测试6.md",
        old_text: "第一段\n第二段",
        new_text: "改一\n改二",
      }),
    );
    expect(r.success).toBe(true);
    // 替换文本统一为文件主导 EOL：不得在 CRLF 文件里掺入 LF 行
    expect(await fsp.readFile(path.join(root, "小说资料", "格式测试6.md"), "utf8")).toBe("改一\r\n改二\r\n第三段\r\n");
  });

  it("delete_lines：CRLF/LF 混用文件未触碰的行逐字节不变（回归锁：曾被单一 EOL 重拼归一）", async () => {
    await fsp.writeFile(path.join(root, "小说资料", "格式测试7.md"), "一\r\n二\n三\r\n四\n", "utf8");
    await executeTool(ctx(), "file_write", {
      operation: "delete_lines",
      path: "小说资料/格式测试7.md",
      start_line: 2,
      end_line: 2,
    });
    // 删第二行（LF 行），其余行的原始 EOL（含混合）必须逐字节保留
    expect(await fsp.readFile(path.join(root, "小说资料", "格式测试7.md"), "utf8")).toBe("一\r\n三\r\n四\n");
  });

  it("insert：start 不再造出 \\n\\r\\n 交界（回归锁：曾凭空多出空行）", async () => {
    await fsp.writeFile(path.join(root, "小说资料", "格式测试8.md"), "原首行\r\n次行\r\n", "utf8");
    await executeTool(ctx(), "file_write", {
      operation: "insert",
      path: "小说资料/格式测试8.md",
      position: "start",
      new_text: "新首行\n",
    });
    // 插入文本归一化为文件主导 EOL（CRLF），交界处不得出现 \n\r\n
    expect(await fsp.readFile(path.join(root, "小说资料", "格式测试8.md"), "utf8")).toBe("新首行\r\n原首行\r\n次行\r\n");
  });

  it("search：单个不可读文件不拖垮整次搜索，并计入 files_skipped", async () => {
    // 造一个"只对特定文件读失败"的桥（占用/权限类 IO 错误的替身）
    const failing = {
      ...fs,
      async readText(p: string): Promise<string> {
        if (p.endsWith("坏文件.md")) throw new Error("文件被占用");
        return fs.readText(p);
      },
    };
    await fsp.writeFile(path.join(root, "小说资料", "坏文件.md"), "世界观\r\n", "utf8");
    const r = JSON.parse(
      await executeTool(ctx({ fs: failing }), "file_manage", { operation: "search", path: ".", search_text: "世界观" }),
    );
    expect(r.success).toBe(true);
    expect(r.files_found).toBeGreaterThan(0); // 其余文件的命中不受影响
    expect(r.files_skipped).toBe(1);
    await fsp.rm(path.join(root, "小说资料", "坏文件.md"));
  });

  it("search：GBK 旧稿可被读出并命中（N-11：readText 的 GBK 回退）", async () => {
    // "世界观" 的 GBK 编码
    await fsp.writeFile(
      path.join(root, "小说资料", "旧稿.md"),
      Buffer.from([0xca, 0xc0, 0xbd, 0xe7, 0xb9, 0xdb, 0x0a]),
    );
    const r = JSON.parse(
      await executeTool(ctx(), "file_manage", { operation: "search", path: ".", search_text: "世界观" }),
    );
    expect(r.success).toBe(true);
    const hit = r.results.find((x: { file: string }) => x.file.endsWith("旧稿.md"));
    expect(hit).toBeDefined();
    expect(hit.matches[0].content).toContain("世界观");
    await fsp.rm(path.join(root, "小说资料", "旧稿.md"));
  });
});

describe("file_manage", () => {
  it("search → {success,search_text,results[{file,matches[{line,content}]}],files_found}", async () => {
    const r = JSON.parse(
      await executeTool(ctx(), "file_manage", { operation: "search", path: ".", search_text: "世界观" }),
    );
    expect(r.success).toBe(true);
    expect(r.search_text).toBe("世界观");
    expect(r.files_found).toBeGreaterThan(0);
    const hit = r.results.find((x: { file: string }) => x.file.endsWith("世界观.md"));
    expect(hit).toBeDefined();
    expect(hit.matches[0].line).toBe(1);
    expect(hit.matches[0].content).toContain("# 世界观");
  });

  it("search 缺 search_text → 逐字错误", async () => {
    expect(await executeTool(ctx(), "file_manage", { operation: "search", path: "." })).toBe(
      '{"error":"search_text is required for search operation"}',
    );
  });

  it("search：file 字段相对项目根（根目录搜索不带 './' 前缀，本机分隔符与实测样本一致）", async () => {
    const r = JSON.parse(
      await executeTool(ctx(), "file_manage", { operation: "search", path: ".", search_text: "世界观" }),
    );
    const hit = r.results.find((x: { file: string }) => x.file.endsWith("世界观.md"));
    expect(hit.file).toBe(joinRel("小说资料", "世界观.md"));
  });

  it("search：directory 同样过分级授权（根外 → 逐字需确认错误，回归锁：曾绕过 guardPath）", async () => {
    const outside = path.join(os.tmpdir(), "deepcompose-search-secret");
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(outside, "s.md"), "世界观\n", "utf8");
    const r = JSON.parse(
      await executeTool(ctx(), "file_manage", {
        operation: "search",
        path: ".",
        search_text: "世界观",
        directory: outside,
      }),
    );
    expect(String(r.error).startsWith(NEEDS_CONFIRMATION_PREFIX)).toBe(true);
    await fsp.rm(outside, { recursive: true, force: true });
  });

  it("search：directory 指向项目内子目录 → 命中路径以该目录为基准", async () => {
    const r = JSON.parse(
      await executeTool(ctx(), "file_manage", {
        operation: "search",
        path: ".",
        search_text: "世界观",
        directory: "小说资料",
      }),
    );
    expect(r.success).toBe(true);
    expect(r.results[0].file).toBe(joinRel("小说资料", "世界观.md"));
  });

  it("delete 目录 → type=directory，快照 previousType=directory（目录内容恒 null）", async () => {
    await fsp.mkdir(path.join(root, "小说资料", "临时目录"), { recursive: true });
    await fsp.writeFile(path.join(root, "小说资料", "临时目录", "x.md"), "x\n", "utf8");
    const r = JSON.parse(await executeTool(ctx(), "file_manage", { operation: "delete", path: "小说资料/临时目录" }));
    expect(r).toEqual({ success: true, operation: "delete", path: "小说资料/临时目录", type: "directory" });
    expect(await fs.exists(path.join(root, "小说资料", "临时目录"))).toBe(false);
    // 回归锁：目录删除的快照必须记 "directory"（曾被记成 "file"，回滚语义会错）
    const s = parseSnapshots(await fsp.readFile(path.join(snapshotsDir, "sess-1.json"), "utf8"), "sess-1");
    const last = s.snapshots[s.snapshots.length - 1];
    expect(last.operation).toBe("delete");
    expect(last.previousType).toBe("directory");
    expect(last.previousContent).toBeNull();
  });

  it("delete → {success,operation,path,type}", async () => {
    await fsp.writeFile(path.join(root, "小说资料", "格式测试9.md"), "待删\n", "utf8");
    const r = JSON.parse(await executeTool(ctx(), "file_manage", { operation: "delete", path: "小说资料/格式测试9.md" }));
    expect(r).toEqual({ success: true, operation: "delete", path: "小说资料/格式测试9.md", type: "file" });
    expect(await fs.exists(path.join(root, "小说资料", "格式测试9.md"))).toBe(false);
  });

  it("copy/rename 缺 new_path → 逐字错误", async () => {
    expect(await executeTool(ctx(), "file_manage", { operation: "copy", path: "小说资料/格式测试1.md" })).toBe(
      '{"error":"new_path is required for copy operation"}',
    );
    expect(await executeTool(ctx(), "file_manage", { operation: "rename", path: "小说资料/格式测试1.md" })).toBe(
      '{"error":"new_path is required for rename operation"}',
    );
  });

  it("copy 之后原文件与副本都在", async () => {
    const r = JSON.parse(
      await executeTool(ctx(), "file_manage", {
        operation: "copy",
        path: "小说资料/格式测试1.md",
        new_path: "小说资料/格式测试1副本.md",
      }),
    );
    expect(r.success).toBe(true);
    expect(r.new_path).toBe("小说资料/格式测试1副本.md");
    expect(await fs.exists(path.join(root, "小说资料", "格式测试1副本.md"))).toBe(true);
  });

  it("copy 覆盖已有目标 → 先给**目标**记写前快照（KL-TL-02）", async () => {
    await fsp.writeFile(path.join(root, "小说资料", "被覆盖.md"), "旧的正文\n", "utf8");
    await executeTool(ctx({ currentCallId: "call_cov" }), "file_manage", {
      operation: "copy",
      path: "小说资料/格式测试1.md",
      new_path: "小说资料/被覆盖.md",
    });
    const s = parseSnapshots(await fsp.readFile(path.join(snapshotsDir, "sess-1.json"), "utf8"), "sess-1");
    // 目标那一条必须记的是**目标的旧内容**，且 previousType=file
    const entry = [...s.snapshots].reverse().find((e) => e.relativePath === "小说资料/被覆盖.md");
    expect(entry).toBeDefined();
    expect(entry!.operation).toBe("copy");
    expect(entry!.previousContent).toBe("旧的正文\n");
    expect(entry!.previousExists).toBe(true);
    expect(entry!.previousType).toBe("file");
    // 盘上确实已经被覆盖（快照是回滚的唯一依据）
    expect(await fsp.readFile(path.join(root, "小说资料", "被覆盖.md"), "utf8")).toBe("第一行\n第二行\n第三行\n");
  });

  it("copy 到全新路径 → 目标侧记一条 previousExists:false（回滚才知道该删掉它）", async () => {
    await executeTool(ctx({ currentCallId: "call_new" }), "file_manage", {
      operation: "copy",
      path: "小说资料/格式测试1.md",
      new_path: "小说资料/全新副本.md",
    });
    const s = parseSnapshots(await fsp.readFile(path.join(snapshotsDir, "sess-1.json"), "utf8"), "sess-1");
    const entry = [...s.snapshots].reverse().find((e) => e.relativePath === "小说资料/全新副本.md");
    expect(entry).toBeDefined();
    expect(entry!.previousExists).toBe(false);
    expect(entry!.previousType).toBe("none");
    expect(entry!.previousContent).toBeNull();
  });

  it("rename 覆盖已有目标 → 目标与源各一条快照（源带 renameNewPath）", async () => {
    await fsp.writeFile(path.join(root, "小说资料", "旧名.md"), "旧名内容\n", "utf8");
    await fsp.writeFile(path.join(root, "小说资料", "占位.md"), "将被改名覆盖\n", "utf8");
    await executeTool(ctx({ currentCallId: "call_rn" }), "file_manage", {
      operation: "rename",
      path: "小说资料/旧名.md",
      new_path: "小说资料/占位.md",
    });
    const s = parseSnapshots(await fsp.readFile(path.join(snapshotsDir, "sess-1.json"), "utf8"), "sess-1");
    const target = [...s.snapshots].reverse().find((e) => e.relativePath === "小说资料/占位.md");
    const source = [...s.snapshots].reverse().find((e) => e.relativePath === "小说资料/旧名.md");
    expect(target?.previousContent).toBe("将被改名覆盖\n");
    expect(target?.operation).toBe("copy"); // 目标是被"写入"的那一侧
    expect(source?.operation).toBe("rename");
    expect(source?.renameNewPath).toBe("小说资料/占位.md");
    expect(source?.previousContent).toBe("旧名内容\n");
  });

  it("copy 源不存在 → 逐字报错，不落快照", async () => {
    const r = JSON.parse(
      await executeTool(ctx(), "file_manage", {
        operation: "copy",
        path: "小说资料/根本没有.md",
        new_path: "小说资料/也不会存在.md",
      }),
    );
    expect(r.error).toContain("Directory not found");
    expect(await fs.exists(path.join(root, "小说资料", "也不会存在.md"))).toBe(false);
  });

  it("写盘失败时快照仍在（顺序锁：先落快照后动盘，KL-TL-07）", async () => {
    // 造一个"写盘必定失败"的桥：顺序反了的话，这里既没有新内容也没有快照
    const failing = {
      ...fs,
      async writeText(p: string, c: string): Promise<void> {
        if (p.endsWith("写盘会失败.md")) throw new Error("磁盘满了");
        return fs.writeText(p, c);
      },
    };
    await fsp.writeFile(path.join(root, "小说资料", "写盘会失败.md"), "原文\n", "utf8");
    await expect(
      executeTool(ctx({ fs: failing, currentCallId: "call_fail" }), "file_write", {
        operation: "write",
        path: "小说资料/写盘会失败.md",
        content: "新文\n",
      }),
    ).rejects.toThrow(/磁盘满了/);
    const s = parseSnapshots(await fsp.readFile(path.join(snapshotsDir, "sess-1.json"), "utf8"), "sess-1");
    const entry = [...s.snapshots].reverse().find((e) => e.callId === "call_fail");
    expect(entry).toBeDefined();
    expect(entry!.previousContent).toBe("原文\n");
    // 盘上内容没变（写失败了），但回滚依据已经在了
    expect(await fsp.readFile(path.join(root, "小说资料", "写盘会失败.md"), "utf8")).toBe("原文\n");
  });
});

describe("路径分级授权", () => {
  it("项目内直读", async () => {
    const r = JSON.parse(await executeTool(ctx(), "file_read", { operation: "list", path: "." }));
    expect(r.error).toBeUndefined();
  });

  it("技能目录直读", async () => {
    await fsp.mkdir(path.join(skillsDir, "demo"), { recursive: true });
    await fsp.writeFile(path.join(skillsDir, "demo", "SKILL.md"), "---\nname: demo\n---\n", "utf8");
    const r = JSON.parse(
      await executeTool(ctx(), "file_read", { operation: "read", path: path.join(skillsDir, "demo", "SKILL.md") }),
    );
    expect(r.content).toContain("name: demo");
  });

  it("授权根之外 → 拒绝，并给出逐字提示", async () => {
    const outside = path.join(os.tmpdir(), "deepcompose-outside-secret.txt");
    await fsp.writeFile(outside, "secret", "utf8");
    const r = JSON.parse(await executeTool(ctx(), "file_read", { operation: "read", path: outside }));
    expect(r.error.startsWith(NEEDS_CONFIRMATION_PREFIX)).toBe(true);
    // 文案里的路径按**本机分隔符**回报（pathGuard.unifySep 契约）；断言仍然是"整条路径逐字出现"。
    // 这里同样按 PATH_SEP 归一后再比：Windows 上 outside 本就是 '\'，macOS 上 os.tmpdir() 给的是 '/'。
    expect(r.error).toContain(outside.replace(/[\\/]/g, PATH_SEP));
  });

  it("会话内授权的额外目录可读", async () => {
    const dir = path.join(os.tmpdir(), "deepcompose-allowed");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "ok.md"), "ok", "utf8");
    const r = JSON.parse(
      await executeTool(
        ctx({ roots: { projectRoot: root, skillsDir, booksRoot, allowedDirs: [dir] } }),
        "file_read",
        { operation: "read", path: path.join(dir, "ok.md") },
      ),
    );
    expect(r.content).toBe("ok");
  });

  it("授权根内的链接目标也拒绝直读，避免穿透到根外", async () => {
    const linkPath = path.join(root, "章节内容", "外部链接.md");
    const linked = {
      ...fs,
      async stat(p: string) {
        if (p === linkPath) return { isDir: false, isLink: true, size: 6, mtimeMs: 1 };
        return fs.stat(p);
      },
      async readText(p: string) {
        if (p === linkPath) return "secret";
        return fs.readText(p);
      },
    };
    const r = JSON.parse(await executeTool(ctx({ fs: linked }), "file_read", { operation: "read", path: "章节内容\\外部链接.md" }));
    expect(r.error).toContain("链接");
  });
  it("盘符根（C:\\）→ 一律需确认（范围过大，即使形似授权根祖先也不放行）", async () => {
    const r = JSON.parse(await executeTool(ctx(), "file_read", { operation: "list", path: "C:\\" }));
    expect(String(r.error).startsWith(NEEDS_CONFIRMATION_PREFIX)).toBe(true);
  });


  it("'..' 穿越到授权根外 → 需确认（归一化判定拦截）", async () => {
    const r = JSON.parse(
      await executeTool(ctx(), "file_read", { operation: "read", path: "..\\..\\..\\..\\..\\Windows\\win.ini" }),
    );
    expect(String(r.error).startsWith(NEEDS_CONFIRMATION_PREFIX)).toBe(true);
  });
});

describe("question / skill_lookup / create_project", () => {
  it("questions 为空 → 逐字错误", async () => {
    expect(await executeTool(ctx(), "question", {})).toBe(
      '{"error":"questions is required and must not be empty"}',
    );
  });

  it("question 结果格式保持既有格式（output + answers）", async () => {
    const r = JSON.parse(
      await executeTool(ctx({ askQuestions: async () => [["继续"]] }), "question", {
        questions: [{ question: "是否继续？", options: [{ label: "继续" }, { label: "停止" }] }],
      }),
    );
    expect(r.answers).toEqual(["继续"]);
    expect(r.output).toContain('User has answered your questions: "是否继续？"="继续"');
    expect(r.output).toContain("You can now continue with the user's answers in mind.");
  });

  it("question：多选以「、」连接；某题空答 → pair 为空串且不进 answers", async () => {
    const r = JSON.parse(
      await executeTool(ctx({ askQuestions: async () => [["甲", "乙"], []] }), "question", {
        questions: [
          { question: "选风格？", options: [{ label: "甲" }, { label: "乙" }], multi_select: true },
          { question: "要跳过吗？", options: [{ label: "跳过" }, { label: "不跳" }] },
        ],
      }),
    );
    expect(r.answers).toEqual(["甲", "乙"]); // 空答的题不贡献 flat 条目
    expect(r.output).toContain('"选风格？"="甲、乙"');
    expect(r.output).toContain('"要跳过吗？"=""');
  });

  it("参数体是 null/坏 JSON → 按缺参或坏参错误回报，不抛异常", async () => {
    // 模型可能给出 "null" 这类合法 JSON 但非对象的参数体
    expect(await executeTool(ctx(), "file_read", "null")).toBe('{"error":"operation is required"}');
    expect(await executeTool(ctx(), "file_read", "{坏")).toBe('{"error":"工具参数不是合法 JSON"}');
  });

  it("B12-8：漏 options / 坏形态的题被丢弃，界面不再 q.options.map 白屏或卡死", async () => {
    // 只有一题且它没有可选项 → 不弹空窗，回报参数错误让模型重问
    expect(
      await executeTool(ctx({ askQuestions: async () => [[]] }), "question", {
        questions: [{ question: "选一个方向" }],
      }),
    ).toBe('{"error":"every question needs a non-empty options array (label required)"}');

    // 一好一坏：坏题丢弃、好题照问；坏题不会让「每题都要选」的提交条件永远凑不满
    const r = JSON.parse(
      await executeTool(ctx({ askQuestions: async () => [["继续"]] }), "question", {
        questions: [
          { question: "坏题", options: null },
          { question: "还继续吗？", options: [{ label: "继续" }, { label: "停止" }] },
        ],
      }),
    );
    expect(r.answers).toEqual(["继续"]);
    expect(r.output).toContain('"还继续吗？"="继续"');
    expect(r.output).not.toContain("坏题");
  });

  it("B12-8：normalizeQuestions 逐项归一（非对象项、坏 option、description 类型）", () => {
    const qs = normalizeQuestions([
      null,
      "标量",
      { question: 42, options: [{ label: "甲" }, { label: "" }, null, { label: 7 }, { label: "乙", description: "说明" }, { label: "丙", description: 9 }] },
      { question: "多选题", options: [{ label: "A" }], multi_select: true },
    ]);
    expect(qs).toHaveLength(2);
    expect(qs[0]).toEqual({
      question: "",
      options: [{ label: "甲" }, { label: "乙", description: "说明" }, { label: "丙" }],
      multi_select: false,
    });
    expect(qs[1]).toEqual({ question: "多选题", options: [{ label: "A" }], multi_select: true });
  });

  it("skill_lookup 缺 skill_name → 逐字错误；命中 → {skill_name,content} 且带目录说明", async () => {
    expect(await executeTool(ctx(), "skill_lookup", {})).toBe('{"error":"skill_name is required"}');
    const r = JSON.parse(
      await executeTool(
        ctx({
          lookupSkill: async (n) => ({ skill_name: n, content: "---\nname: demo\n---\n正文" }),
        }),
        "skill_lookup",
        { skill_name: "demo" },
      ),
    );
    expect(r.skill_name).toBe("demo");
    expect(r.content).toContain("正文");
  });

  it("create_project 缺 name → 逐字错误；成功则建出 3.0 全套（核心设定 + 待确认目录）", async () => {
    expect(await executeTool(ctx(), "create_project", {})).toBe('{"error":"name is required"}');
    const r = JSON.parse(await executeTool(ctx(), "create_project", { name: "新书" }));
    expect(r.success).toBe(true);
    expect(await fs.exists(path.join(booksRoot, "新书", "小说资料", "02-核心设定.md"))).toBe(true);
    expect(await fs.exists(path.join(booksRoot, "新书", "小说资料", "00-项目状态.md"))).toBe(true);
    expect(await fs.exists(path.join(booksRoot, "新书", "待确认"))).toBe(true);
  });
});

describe("AI 三态模式（执行层门槛，双闸之二）", () => {
  it.each(["readonly", "writing", "dev"] as const)("%s 模式始终拒绝正文与候选稿写入", async mode => {
    const c = ctx({ mode });
    for (const target of ["章节内容/第1章.md", "待确认/候选.md"]) {
      const result = JSON.parse(await executeTool(c, "file_write", { operation: "write", path: target, content: "不得落盘" }));
      expect(result.error).toBe(BODY_WRITE_FORBIDDEN);
    }
    expect(await fs.readText(path.join(root, "章节内容", "第1章.md"))).toBe("第一行\n第二行\n第三行\n");
    expect(await fs.exists(path.join(root, "待确认", "候选.md"))).toBe(false);
  });
  it("只读模式：file_write / file_manage 写操作 / create_project 全拦；读与 search 放行", async () => {
    const c = ctx({ mode: "readonly" });
    const w = JSON.parse(await executeTool(c, "file_write", { operation: "write", path: "小说资料/格式测试1.md", content: "x" }));
    expect(String(w.error)).toContain("只读模式");
    const d = JSON.parse(await executeTool(c, "file_manage", { operation: "delete", path: "小说资料/格式测试1.md" }));
    expect(String(d.error)).toContain("只读模式");
    const p = JSON.parse(await executeTool(c, "create_project", { name: "只读建书" }));
    expect(String(p.error)).toContain("资料维护模式");
    const r = JSON.parse(await executeTool(c, "file_read", { operation: "read", path: "章节内容/第1章.md" }));
    expect(r.content).toContain("第一行");
    const s = JSON.parse(await executeTool(c, "file_manage", { operation: "search", path: ".", search_text: "第一行" }));
    expect(s.success).toBe(true);
  });

  it("指导模式：TeachWrite 始终拒绝正文，资料仍受模式限制，技能根与建仓拦截", async () => {
    const c = ctx({ mode: "writing" });
    const w = JSON.parse(await executeTool(c, "file_write", { operation: "append", path: "章节内容/第1章.md", content: "新行\n" }));
    expect(w.error).toBe(BODY_WRITE_FORBIDDEN);
    expect(await fs.readText(path.join(root, "章节内容", "第1章.md"))).toBe("第一行\n第二行\n第三行\n");
    const doc = JSON.parse(await executeTool(c, "file_write", { operation: "write", path: "小说资料/世界观.md", content: "x" }));
    expect(String(doc.error)).toContain("指导模式");
    const skill = JSON.parse(await executeTool(c, "file_write", { operation: "write", path: path.join(skillsDir, "x", "SKILL.md"), content: "x" }));
    expect(skill.error).toBe(BODY_WRITE_FORBIDDEN);
    const p = JSON.parse(await executeTool(c, "create_project", { name: "写作建书" }));
    expect(String(p.error)).toContain("资料维护模式");
  });

  it("rename 两侧都过门：不能将作者正文移动到资料目录", async () => {
    const c = ctx({ mode: "writing" });
    const r = JSON.parse(await executeTool(c, "file_manage", { operation: "rename", path: "章节内容/第2章.md", new_path: "小说资料/第2章.md" }));
    expect(r.error).toBe(BODY_WRITE_FORBIDDEN);
    expect(await fs.readText(path.join(root, "章节内容", "第2章.md"))).toBe("另一章\n");
    expect(await fs.exists(path.join(root, "小说资料", "第2章.md"))).toBe(false);
  });

  it("缺省开发模式允许维护小说资料", async () => {
    const r = JSON.parse(await executeTool(ctx(), "file_write", { operation: "append", path: "小说资料/世界观.md", content: "追加\n" }));
    expect(r.success).toBe(true);
  });
});
