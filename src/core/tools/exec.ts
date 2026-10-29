/**
 * 工具实现。
 *
 * 结果 JSON 的字段名与形态**保持既有格式**（实测样本：127 个会话里的 1,729 条工具调用结果），
 * 例如：
 *   file_read(read)   {"path":"小说资料/世界观.md","content":"…"}
 *   file_read(list)   {"path":"章节内容","files":[{"name":"第1章.md","path":"章节内容\\第1章.md","type":"file","size":7652}]}
 *   file_write(write) {"success":true,"operation":"write","path":"…","bytes_written":40610}
 *   file_write(repl.) {"success":true,"operation":"replace","path":"…","replace_all":false}
 *   file_manage(search){"success":true,"search_text":"…","results":[{"file":"小说资料\\人物库.md","matches":[{"line":49,"content":"…"}]}],"files_found":N}
 *   file_manage(del)  {"success":true,"operation":"delete","path":"…","type":"file"}
 *   question          {"output":"User has answered your questions: \"…\"=\"…\". You can now continue with the user's answers in mind.","answers":["…"]}
 *   skill_lookup      {"skill_name":"novel-writer","content":"---\nname: …"}
 *   error             {"error":"operation is required"}
 *
 * 分隔符口径（跨平台）：字段名与形态不变，但**分隔符随平台**——
 *   - `file_read(read)` / `file_write` / `file_manage(delete|rename|copy)` 的 path
 *     一律 '/'（slashPath 归一，两平台一致，这是既有格式）；
 *   - `file_read(list)` 的条目 path 与 `file_manage(search)` 的 file 是**项目根相对路径**，
 *     用本机分隔符（Windows `\` = 既有样本逐字不变；macOS `/`）。
 *     模型会把该字符串原样回传成 path 参数，pathGuard 的 unifySep 负责把两种
 *     分隔符都吃下来，所以老样本在 macOS 上照样能读。
 */

import type { FsBridge } from "../fsbridge";
import { aiMutationError, isLockedGuidePath, LOCKED_GUIDE_TEXT } from "../ai/writerPolicy";
import { dirname, join } from "../dirs";
import { createProject } from "../store/project";
import { dominantEol, joinLines, splitLines } from "../store/markdown";
import { contentHash, recordSnapshot, type PreviousType, type SnapshotOperation } from "../store/snapshot";
import { validateDocWrite, isValidatedDocPath } from "../store/docschema";
import { modeGate, type AiMode } from "../ai/mode";
import {
  NEEDS_CONFIRMATION_PREFIX,
  guardPath,
  reportPath,
  type GuardRoots,
  type ResolvedPath,
} from "./pathGuard";

/** read 分页：单次最多返回的行数（与 spec.ts 的 limit 描述一致） */
export const MAX_READ_LINES = 2000;
/** read 分页：未传 limit 时的默认行数 */
export const DEFAULT_READ_LINES = 2000;
/** list 分页：单次最多返回的条目数（与 spec.ts 的 limit 描述一致） */
export const MAX_LIST_ENTRIES = 500;
/** list 分页：未传 limit 时的默认条目数 */
export const DEFAULT_LIST_ENTRIES = 200;

/** question 工具的单个选项（label 必填，description 供界面补充说明） */
export interface QuestionOption {
  label: string;
  description?: string;
}
/** question 工具的单个问题（multi_select=true 时允许多选） */
export interface QuestionItem {
  question: string;
  options: QuestionOption[];
  multi_select?: boolean;
}

/** skill_lookup 的命中结果（skill_name 用技能的 name 字段回报） */
export interface SkillHit {
  skill_name: string;
  content: string;
}

/** 一次工具执行所需的全部环境（由 agent 循环装配；界面回调按工具可选注入） */
export interface ToolContext {
  fs: FsBridge;
  roots: GuardRoots;
  booksRoot: string;
  snapshotsDir: string;
  sessionId: string;
  /** 当前工具调用 id（写进快照的 callId，保持既有格式） */
  currentCallId?: string;
  /** 写入前留快照（默认 true） */
  snapshot?: boolean;
  /** 真实 AI 会话每次资料变更都要求作者确认；纯文件操作回归可独立注入。 */
  confirmWrites?: boolean;
  /** question 工具的界面回调 */
  askQuestions?: (questions: QuestionItem[]) => Promise<string[][]>;
  /**
   * 根外路径的用户确认通道（B-1「根外必须用户确认」的接线）：
   * 返回 true 时把目标（或其父目录）并入 roots.allowedDirs，会话内持续生效；
   * 未装配该回调时维持旧行为 —— 根外一律拒绝。
   */
  confirmExternal?: (absPath: string) => Promise<boolean>;
  /** skill_lookup 的技能读取 */
  lookupSkill?: (nameOrId: string) => Promise<SkillHit | null>;
  /**
   * AI 三态模式（只读/写作/开发；缺省 dev = 现状全量）。执行层门槛是双闸的第二道
   * （第一道是发给模型的工具清单过滤），模型幻觉调用也会被这里按路径拦下。
   * 见 core/ai/mode.ts（策略唯一真源）。
   */
  mode?: AiMode;
}

type Args = Record<string, unknown>;

/** 统一的错误结果形态：{"error":"…"}（既有格式，回归锁） */
function err(message: string): string {
  return JSON.stringify({ error: message });
}
function linkError(path: string): string {
  return `拒绝访问链接或 junction：${path}`;
}

/**
 * N-42：工具失败判定 —— 只认 err() 的**结构**：整串是一个 JSON 对象、
 * 仅含 "error" 一个键、值为字符串。
 *
 * 旧判定是 UI 侧子串嗅探 `includes('"error"')`：今天的成功结果碰巧都不会
 * 命中（字符串值里的引号全部被 JSON 转义成 \"），但它依赖两个巧合——
 * 「成功形态永远没有 error 键」和「内容永远被转义」。任何成功形态一旦
 * 长出 error 字段（比如 search 改为逐文件报告跳过原因），整个成功结果
 * 就会被误标成失败。结构判定把失败语义钉死在契约本身，UI 不再各自嗅探。
 */
export function isToolErrorResult(result: string | null | undefined): boolean {
  if (typeof result !== "string" || !result.startsWith('{"error":')) return false;
  try {
    const j: unknown = JSON.parse(result);
    return (
      typeof j === "object" &&
      j !== null &&
      !Array.isArray(j) &&
      Object.keys(j).length === 1 &&
      typeof (j as { error?: unknown }).error === "string"
    );
  } catch {
    return false;
  }
}

/** 统一的成功结果形态：字段序即 JSON 序（既有格式对字段名与形态都有实证） */
function ok(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

/** 取字符串参数：缺失或类型不符返回 undefined（不做隐式转换） */
function str(a: Args, k: string): string | undefined {
  const v = a[k];
  return typeof v === "string" ? v : undefined;
}
/** 取整数参数：接受 number 与整数字符串，截断小数；其余返回 undefined */
function int(a: Args, k: string): number | undefined {
  const v = a[k];
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return undefined;
}
/** 取布尔参数：缺失或类型不符回落默认值 */
function bool(a: Args, k: string, def: boolean): boolean {
  const v = a[k];
  return typeof v === "boolean" ? v : def;
}

/** 结果里回报的路径一律用 '/'（既有 file_read/file_write 结果即如此） */
function slashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 内容的 UTF-8 字节数（bytes_written 字段用，不是 UTF-16 码元数） */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * guardPath + 根外用户确认（B-1 的接线点）。
 * 命中「需确认」且装配了 confirmExternal 时询问用户：
 *  - 批准 → 授权目录（目标本身是目录授权其本身，否则授权父目录）并入
 *    roots.allowedDirs（按引用生效，同一会话后续调用不再重复询问）；
 *  - 拒绝 → 回报「用户未授权」文案（与 NEEDS_CONFIRMATION_PREFIX 区分：
 *    前缀文案保留给「确认通道未装配」的场景，回归锁不动）。
 */
async function guardWithConfirm(
  ctx: ToolContext,
  pathArg: string,
): Promise<{ ok: true; resolved: ResolvedPath } | { ok: false; message: string }> {
  const g = guardPath(pathArg, ctx.roots);
  if (g.ok) return { ok: true, resolved: g.resolved };
  const message = g.message ?? "";
  if (!message.startsWith(NEEDS_CONFIRMATION_PREFIX) || !ctx.confirmExternal) {
    return { ok: false, message };
  }
  const granted = await ctx.confirmExternal(g.resolved.abs);
  if (!granted) return { ok: false, message: `用户未授权访问该路径: ${g.resolved.abs}` };
  let dir = g.resolved.abs;
  try {
    const st = await ctx.fs.stat(g.resolved.abs);
    if (!st || !st.isDir) dir = dirname(g.resolved.abs);
  } catch {
    dir = dirname(g.resolved.abs);
  }
  (ctx.roots.allowedDirs ??= []).push(dir);
  const g2 = guardPath(pathArg, ctx.roots);
  if (!g2.ok) return { ok: false, message: g2.message ?? "" };
  return { ok: true, resolved: g2.resolved };
}

async function confirmMutation(ctx: ToolContext, description: string): Promise<boolean> {
  if (!ctx.confirmWrites) return true;
  if (!ctx.askQuestions) return false;
  const answers = await ctx.askQuestions([{ question: "确认资料变更：" + description, options: [{ label: "确认修改" }, { label: "取消" }] }]);
  return answers[0]?.includes("确认修改") === true;
}

/**
 * EOL 容错匹配（与 store/markdown.ts findWithEolTolerance 同口径）：
 * file_read 分页结果统一以 '\n' 连接，模型拿读到的内容构造多行 old_text 时，
 * 与 CRLF 落盘的原文对不上 —— 先按原文找，找不到再把待查文本的 EOL 归一化再找。
 * 返回实际命中的针文本；找不到返回 null。
 */
function findNeedleWithEolTolerance(src: string, needle: string, eol: string): string | null {
  if (needle === "") return null;
  if (src.includes(needle)) return needle;
  const normalized = needle.replace(/\r\n|\r|\n/g, eol);
  if (normalized !== needle && src.includes(normalized)) return normalized;
  const asLf = needle.replace(/\r\n|\r/g, "\n");
  if (asLf !== needle && src.includes(asLf)) return asLf;
  return null;
}

/**
 * 落一条快照（保持既有格式：一条记录同时带写前内容与写后哈希）。
 * previousType 缺省按 exists 推导为 file/none；**目录操作须显式传 "directory"**
 * （契约 PreviousType 含该枚举；目录的 previousContent 恒为 null）。
 */
async function recordWrite(
  ctx: ToolContext,
  operation: SnapshotOperation,
  relPath: string,
  previous: string | null,
  exists: boolean,
  postContent: string | null,
  renameNewPath: string | null = null,
  previousType: PreviousType = exists ? "file" : "none",
): Promise<void> {
  if (ctx.snapshot === false) return;
  await recordSnapshot(ctx.fs, ctx.snapshotsDir, {
    sessionId: ctx.sessionId,
    callId: ctx.currentCallId ?? "",
    operation,
    relativePath: slashPath(relPath),
    previousContent: previous,
    previousExists: exists,
    previousType,
    renameNewPath,
    postContentHash: postContent === null ? null : await contentHash(postContent),
  });
}

// ────────────────────────────── file_read ──────────────────────────────

/**
 * file_read：read（按 1-based 行号分页取内容）/ list（按条目下标分页列直接子项）。
 * 结果形态保持既有格式：read → {path, content}；list → {path, files:[{name,path,type,size}]}。
 */
async function fileRead(ctx: ToolContext, a: Args): Promise<string> {
  const operation = str(a, "operation");
  if (!operation) return err("operation is required");
  const pathArg = str(a, "path");
  if (pathArg === undefined) return err("path is required");
  if (operation !== "read" && operation !== "list") return err("Unknown operation: " + operation);

  const g = await guardWithConfirm(ctx, pathArg);
  if (!g.ok) return err(g.message);
  const { abs } = g.resolved;
  const reported = reportPath(g.resolved);
  if (isLockedGuidePath(ctx.roots.projectRoot, abs)) return err(LOCKED_GUIDE_TEXT);

  // 路径不存在时统一报 "Directory not found"（既有逐字文案，read 文件缺失也用它，回归锁）
  const st = await ctx.fs.stat(abs);
  if (st === null) return err(`Directory not found: ${reported}`);
  if (st.isLink) return err(linkError(reported));

  if (operation === "list") {
    if (!st.isDir) return err(`Not a directory: ${reported}`);
    const offset = Math.max(0, int(a, "offset") ?? 0);
    const limitRaw = int(a, "limit") ?? DEFAULT_LIST_ENTRIES;
    const limit = Math.min(Math.max(1, limitRaw), MAX_LIST_ENTRIES);
    const entries = await ctx.fs.list(abs);
    const page = entries.slice(offset, offset + limit);
    // 条目 path：项目内 → 相对项目根（'\' 分隔，保持既有格式样本）；项目外 → 绝对路径
    const relBase = g.resolved.rel;
    return ok({
      path: reported,
      files: page.map((e) => ({
        name: e.name,
        path: relBase === null ? e.path : join(relBase, e.name),
        type: e.isDir ? "directory" : "file",
        size: e.isDir ? null : e.size,
      })),
    });
  }

  if (st.isDir) return err(`Is a directory: ${reported}`);
  const content = await ctx.fs.readText(abs);
  const offset = Math.max(1, int(a, "offset") ?? 1);
  const limitRaw = int(a, "limit") ?? DEFAULT_READ_LINES;
  const limit = Math.min(Math.max(1, limitRaw), MAX_READ_LINES);

  // 兼容 CRLF/CR/LF 三种换行；分页结果统一以 '\n' 连接（既有行为）
  const allLines = content.split(/\r\n|\r|\n/);
  const slice = allLines.slice(offset - 1, offset - 1 + limit).join("\n");
  return ok({ path: reported, content: slice });
}

// ────────────────────────────── file_write ──────────────────────────────

/**
 * file_write：write（覆盖/新建）/ append（追加）/ replace（查找替换）/
 * insert（按 position 插入）/ delete_lines（按 1-based 闭区间删行）。
 * 全部操作先读旧内容 → 计算新内容 → **先落快照** → 写盘（快照带写前内容与写后哈希）。
 * 顺序与 delete/rename 统一：快照是回滚的唯一依据，不能晚于盘上改动。
 */
async function fileWrite(ctx: ToolContext, a: Args): Promise<string> {
  const operation = str(a, "operation");
  if (!operation) return err("operation is required");
  const pathArg = str(a, "path");
  if (pathArg === undefined) return err("path is required");

  const ops = ["write", "append", "replace", "insert", "delete_lines"];
  if (!ops.includes(operation)) return err("Unknown operation: " + operation);

  // content 判 null 也判 undefined：否则 JSON null 会通过校验，String(null) 把字面量 "null" 写进文件
  if (operation === "write" && (a.content === undefined || a.content === null)) return err("content is required for write operation");
  if (operation === "append" && (a.content === undefined || a.content === null)) return err("content is required for append operation");
  if (operation === "replace" && !str(a, "old_text")) return err("old_text is required for replace operation");
  if (operation === "insert" && a.new_text === undefined) return err("new_text is required for insert operation");
  if (operation === "delete_lines" && (int(a, "start_line") === undefined || int(a, "end_line") === undefined)) {
    return err("start_line and end_line are required for delete_lines operation");
  }
  if (operation === "insert") {
    const pos = str(a, "position") ?? "end";
    // position 非法时沿用既有的 "Unknown operation" 文案（保持既有格式，不改措辞）
    if (!["start", "end", "after_line"].includes(pos)) return err("Unknown operation: " + pos);
    if (pos === "after_line" && int(a, "after_line") === undefined) return err("Invalid after_line number");
  }

  const g = await guardWithConfirm(ctx, pathArg);
  if (!g.ok) return err(g.message);
  const { abs } = g.resolved;
  const reported = slashPath(reportPath(g.resolved));

  const policyHit = await aiMutationError(ctx.fs, ctx.roots.projectRoot, abs);
  if (policyHit) return err(policyHit);

  // 模式门槛（双闸之二）：file_write 全是写操作，先过模式再动手
  const modeHit = modeGate(ctx.mode ?? "dev", "write", g.resolved.rel);
  if (modeHit) return err(modeHit);

  if (!(await confirmMutation(ctx, `${operation} ${reported}`))) return err("作者未确认资料变更。");
  // 写前先取旧内容与存在性：既是 append/replace/insert/delete_lines 的输入，也是快照的"写前"半段
  const st = await ctx.fs.stat(abs);
  if (st?.isLink) return err(linkError(reported));
  const exists = st !== null;
  const previous = exists ? await ctx.fs.readText(abs) : null;

  let next: string;
  let extra: Record<string, unknown> = {};

  switch (operation) {
    case "write": {
      // 覆盖/新建：bytes_written 是 UTF-8 字节数（既有格式字段）
      next = String(a.content);
      extra = { bytes_written: utf8Bytes(next) };
      break;
    }
    case "append": {
      // 追加：目标不存在等价于新建；结果不带 bytes_written（既有格式即如此）
      next = (previous ?? "") + String(a.content);
      break;
    }
    case "replace": {
      const oldText = str(a, "old_text") ?? "";
      const newTextRaw = a.new_text === undefined ? "" : String(a.new_text);
      const replaceAll = bool(a, "replace_all", false);
      const src = previous ?? "";
      const eol = src.includes("\r\n") ? "\r\n" : "\n";
      // EOL 容错：模型按 file_read 的 '\n' 归一化内容构造多行 old_text 时也能命中 CRLF 原文
      const needle = findNeedleWithEolTolerance(src, oldText, eol);
      if (needle === null) return err(`Text not found: ${oldText}`);
      // 替换文本统一为文件主导 EOL，避免在 CRLF 文件里掺入 LF 行（单行文本不含 EOL，不受影响）
      const newText = newTextRaw.replace(/\r\n|\r|\n/g, eol);
      // new_text 一律按字面量处理：String.replace 的字符串替换会展开 $&/$'/$` 等模式，
      // 用 split/join 与函数式替换规避（正文里出现 "$&" 不该被替换成匹配文本）
      next = replaceAll ? src.split(needle).join(newText) : src.replace(needle, () => newText);
      extra = { replace_all: replaceAll };
      break;
    }
    case "insert": {
      const pos = str(a, "position") ?? "end";
      const text = String(a.new_text ?? a.content ?? "");
      const src = previous ?? "";
      extra = { position: pos };
      if (src === "" || text === "") {
        // 空文件等价于写入；空插入等价于不动（既有语义：不产生多余空行）
        next = src === "" ? text : src;
        break;
      }
      // 行级编辑按「行数组 + 原样 EOL」工作（与 markdown.ts 同一硬约束）：
      // 除插入点外其余字节逐字节不变，混合 EOL 文件不会被静默归一
      const doc = splitLines(src);
      const eol = dominantEol(doc);
      const ins = splitLines(text.replace(/\r\n|\r|\n/g, eol));
      if (pos === "start") {
        // 插入块不以 EOL 结尾时补一个，防止与原有首行粘连成同一行
        if (ins.eols[ins.eols.length - 1] === "") ins.eols[ins.eols.length - 1] = eol;
        doc.lines.splice(0, 0, ...ins.lines);
        doc.eols.splice(0, 0, ...ins.eols);
      } else if (pos === "end") {
        // 原文件末行无 EOL 时先补，保证插入内容另起一行
        if (doc.eols[doc.eols.length - 1] === "") doc.eols[doc.eols.length - 1] = eol;
        doc.lines.push(...ins.lines);
        doc.eols.push(...ins.eols);
      } else {
        // after_line 为 1-based：after=0 表示插到首行前，after=行数 表示插到末尾
        const after = int(a, "after_line")!;
        if (after < 0 || after > doc.lines.length) return err("Invalid after_line number");
        if (after === doc.lines.length && doc.eols[after - 1] === "") doc.eols[after - 1] = eol;
        if (after < doc.lines.length && ins.eols[ins.eols.length - 1] === "") ins.eols[ins.eols.length - 1] = eol;
        doc.lines.splice(after, 0, ...ins.lines);
        doc.eols.splice(after, 0, ...ins.eols);
      }
      next = joinLines(doc);
      break;
    }
    case "delete_lines": {
      const start = int(a, "start_line")!;
      const end = int(a, "end_line")!;
      const src = previous ?? "";
      // 行级删除同样保留每行原始 EOL：未触碰的行逐字节不变
      const doc = splitLines(src);
      const total = doc.lines.length;
      if (start < 1 || end < start || start > total) return err("Invalid line range");
      // 闭区间 [start, end]，end 越界时截到文件尾
      const upto = Math.min(end, total);
      const removed = doc.lines.slice(start - 1, upto);
      doc.lines.splice(start - 1, upto - (start - 1));
      doc.eols.splice(start - 1, upto - (start - 1));
      next = joinLines(doc);
      extra = { deleted_lines: removed.length };
      break;
    }
    default:
      return err("Unknown operation: " + operation);
  }

  // 落点校验（D-043 / B6）：写 小说资料/ 下的受管文件先过格式 schema。
  // 结构违规硬拒（报错里带正确格式，AI 重写即可）；存量违规不背锅（见 docschema 注释）。
  // isValidatedDocPath 把关范围：只查 小说资料/ 下的受管文件，审核/ 与正文/候选不查。
  let writeWarnings: string[] = [];
  if (g.resolved.rel !== null && isValidatedDocPath(g.resolved.rel)) {
    const baseName = g.resolved.rel.split(/[\\/]/).pop() ?? "";
    const verdict = validateDocWrite(baseName, next, previous);
    if (!verdict.ok) return err(verdict.message ?? "格式不合规");
    writeWarnings = verdict.warnings;
  }

  // 顺序纪律（KL-TL-07）：**先落快照再动盘**。
  // 新内容已在内存里，写后哈希不依赖磁盘，所以快照不必等落盘 ——
  // 反过来（先写盘后落快照）在两步之间崩掉就会"改了却没有回滚依据"。
  await recordWrite(ctx, operation as SnapshotOperation, reportPath(g.resolved), previous, exists, next);
  await ctx.fs.writeText(abs, next);
  return ok({ success: true, operation, path: reported, ...extra, ...(writeWarnings.length > 0 ? { warnings: writeWarnings } : {}) });
}

// ────────────────────────────── file_manage ──────────────────────────────

/**
 * file_manage：search（全项目/指定目录内搜 md/txt 文本）/ delete / rename / copy。
 * delete / rename / copy 一律**先落快照再动盘**（快照是回滚的唯一依据）。
 * copy 与 rename 的风险都在**目标**：目标已存在时会被直接覆盖（rename 覆盖文件、
 * copy 覆盖一切），所以目标那一侧也要各记一条写前快照（KL-TL-02）。
 */
async function fileManage(ctx: ToolContext, a: Args): Promise<string> {
  const operation = str(a, "operation");
  if (!operation) return err("operation is required");
  const pathArg = str(a, "path");
  if (pathArg === undefined) return err("path is required");

  const g = await guardWithConfirm(ctx, pathArg);
  if (!g.ok) return err(g.message);
  const { abs } = g.resolved;

  switch (operation) {
    case "search": {
      const needle = str(a, "search_text");
      if (!needle) return err("search_text is required for search operation");
      const dirArg = str(a, "directory");
      // directory 同样必须过授权判定：否则可以拿它绕过 path 的分级授权，
      // 逐文件读出根外目录里的 md/txt 内容
      const gDir = dirArg ? await guardWithConfirm(ctx, dirArg) : null;
      if (gDir && !gDir.ok) return err(gDir.message);
      const start = gDir ? gDir.resolved : g.resolved;
      if (isLockedGuidePath(ctx.roots.projectRoot, start.abs)) return err(LOCKED_GUIDE_TEXT);
      // 结果 file 字段的相对基准：项目内 → 相对项目根（'\' 分隔，与实测样本一致）；
      // 项目外 → 绝对路径。不能用 reportPath：它把项目根回报成 "."，会拼出 ".\xxx" 前缀。
      const startRel = start.rel ?? start.abs;
      const results: { file: string; matches: { line: number; content: string }[] }[] = [];
      let filesFound = 0;

      // 递归扫 md/txt：跳过 '.' 开头的系统目录；每文件最多报 50 条命中（防止大文件刷爆结果）。
      // 单个文件/目录不可读（非 UTF-8、权限、占用）只跳过不整单失败；
      // 深度上限防 junction/符号链接成环（对照 buildContentTree 的 maxDepth 防护）。
      const MAX_SEARCH_DEPTH = 16;
      let filesSkipped = 0;
      const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
        if (depth > MAX_SEARCH_DEPTH) return;
        let entries;
        try {
          entries = await ctx.fs.list(dir);
        } catch {
          return; // 目录不可读：跳过该子树，不让整次搜索失败
        }
        for (const e of entries) {
          const childRel = rel === "" ? e.name : join(rel, e.name);
          if (e.isLink || isLockedGuidePath(ctx.roots.projectRoot, e.path)) continue;
          if (e.isDir) {
            if (e.name.startsWith(".")) continue;
            await walk(e.path, childRel, depth + 1);
            continue;
          }
          if (!/\.(md|txt)$/i.test(e.name)) continue;
          let text: string;
          try {
            text = await ctx.fs.readText(e.path);
          } catch {
            filesSkipped++; // 单文件读不出（如 GBK 旧稿）不影响其余文件的搜索结果
            continue;
          }
          const lines = text.split(/\r\n|\r|\n/);
          const matches: { line: number; content: string }[] = [];
          lines.forEach((l, i) => {
            if (l.includes(needle)) matches.push({ line: i + 1, content: l });
          });
          if (matches.length > 0) {
            filesFound++;
            results.push({ file: childRel, matches: matches.slice(0, 50) });
          }
        }
      };
      await walk(start.abs, startRel, 0);
      return ok({ success: true, search_text: needle, results, files_found: filesFound, files_skipped: filesSkipped });
    }
    case "delete": {
      const policyHit = await aiMutationError(ctx.fs, ctx.roots.projectRoot, abs);
      if (policyHit) return err(policyHit);
      const modeHit = modeGate(ctx.mode ?? "dev", "write", g.resolved.rel);
      if (modeHit) return err(modeHit);
      const st = await ctx.fs.stat(abs);
      if (st === null) return err(`Directory not found: ${slashPath(reportPath(g.resolved))}`);
      if (!(await confirmMutation(ctx, `delete ${reportPath(g.resolved)}`))) return err("作者未确认资料变更。");
      const previous = st.isDir ? null : await ctx.fs.readText(abs);
      // 先落快照再删；目录要记 previousType:"directory"（目录的 previousContent 恒为 null，
      // 回滚时靠类型区分"重建目录"与"回写文件"两种语义）
      await recordWrite(ctx, "delete", reportPath(g.resolved), previous, true, null, null, st.isDir ? "directory" : "file");
      await ctx.fs.remove(abs, st.isDir);
      return ok({
        success: true,
        operation: "delete",
        path: slashPath(reportPath(g.resolved)),
        type: st.isDir ? "directory" : "file",
      });
    }
    case "rename":
    case "copy": {
      const newPathArg = str(a, "new_path");
      if (!newPathArg) return err(`new_path is required for ${operation} operation`);
      const g2 = await guardWithConfirm(ctx, newPathArg);
      if (!g2.ok) return err(g2.message);
      const policyHit = await aiMutationError(ctx.fs, ctx.roots.projectRoot, abs)
        ?? await aiMutationError(ctx.fs, ctx.roots.projectRoot, g2.resolved.abs);
      if (policyHit) return err(policyHit);
      // 源与目标都必须在受准许的资料范围内。
      const modeHit = modeGate(ctx.mode ?? "dev", "write", g.resolved.rel) ?? modeGate(ctx.mode ?? "dev", "write", g2.resolved.rel);
      if (modeHit) return err(modeHit);
      const srcSt = await ctx.fs.stat(abs);
      if (srcSt === null) return err(`Directory not found: ${slashPath(reportPath(g.resolved))}`);
      if (!(await confirmMutation(ctx, `${operation} ${reportPath(g.resolved)} → ${newPathArg}`))) return err("作者未确认资料变更。");
      const srcText = srcSt.isDir ? null : await ctx.fs.readText(abs);
      const dstSt = await ctx.fs.stat(g2.resolved.abs);

      // 目标已存在 → 它的旧内容会被覆盖掉，先给目标记一条写前快照（KL-TL-02）。
      // 不存在也记一条（previousExists:false）—— 这是"回滚时该把目标删掉"的唯一依据。
      if (dstSt !== null) {
        await recordWrite(
          ctx,
          "copy",
          reportPath(g2.resolved),
          dstSt.isDir ? null : await ctx.fs.readText(g2.resolved.abs),
          true,
          srcText,
          null,
          dstSt.isDir ? "directory" : "file",
        );
      } else {
        await recordWrite(ctx, "copy", reportPath(g2.resolved), null, false, srcText, null, "none");
      }

      if (operation === "rename") {
        // rename 快照：relativePath 记源路径、renameNewPath 记新路径；内容不变故写后哈希用原内容
        await recordWrite(
          ctx,
          "rename",
          reportPath(g.resolved),
          srcText,
          true,
          srcText,
          slashPath(reportPath(g2.resolved)),
          srcSt.isDir ? "directory" : "file",
        );
        await ctx.fs.rename(abs, g2.resolved.abs);
      } else {
        await ctx.fs.copy(abs, g2.resolved.abs);
      }
      return ok({
        success: true,
        operation,
        path: slashPath(reportPath(g.resolved)),
        new_path: slashPath(reportPath(g2.resolved)),
      });
    }
    default:
      return err("Unknown operation: " + operation);
  }
}

// ────────────────────────────── create_project / question / skill_lookup ──────────────────────────────

/**
 * create_project：在作品根下新建作品（14 件套模板 + 基础目录，见 store/project）。
 * 业务失败（重名/非法书名）以 {"error":"…"} 回报，不抛出。
 */
async function createProjectTool(ctx: ToolContext, a: Args): Promise<string> {
  // 建仓是开发动作：只读/写作模式硬拒（模式门槛双闸之二）
  const modeHit = modeGate(ctx.mode ?? "dev", "create", null);
  if (modeHit) return err(modeHit);
  const name = str(a, "name");
  if (!name) return err("name is required");
  try {
    const ref = await createProject(ctx.fs, ctx.booksRoot, name);
    return ok({ success: true, name: ref.name, path: ref.root });
  } catch (e) {
    return err(String(e instanceof Error ? e.message : e));
  }
}

/**
 * question 参数的逐项归一（B12 批次8）。
 *
 * `spec.ts` 把 `options` 声明为 required，但工具参数是模型生成的自由文本，漏 `options`、
 * 给 `null`、给标量都会来。旧实现只做"是数组且非空"的集合级校验就 `raw as QuestionItem[]`
 * 裸透传，于是漏 options 的那一题会让界面在渲染期 `q.options.map` 抛 TypeError ——
 * 全树没有 ErrorBoundary，直接白屏；更糟的是弹窗的「提交」按钮要求**每题都选中**
 * （MainWorkbench 的 `disabled={… length === 0}`），这类题会让弹窗永久卡住无法提交。
 *
 * 归一规则：非对象项丢弃；`question` 非字符串按空串；`options` 非数组按空数组；
 * option 只保留 label 为非空字符串的项（description 只接受字符串）；
 * **没有可选项的题整体丢弃**（宁可少问一题，也不给用户一个点不动的问题）。
 * 全部题目都被丢弃时由调用方回报参数错误，不静默弹一个空窗。
 */
export function normalizeQuestions(raw: unknown[]): QuestionItem[] {
  const out: QuestionItem[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const optionsRaw = Array.isArray(o.options) ? o.options : [];
    const options: QuestionOption[] = [];
    for (const opt of optionsRaw) {
      if (typeof opt !== "object" || opt === null || Array.isArray(opt)) continue;
      const oo = opt as Record<string, unknown>;
      if (typeof oo.label !== "string" || oo.label.trim() === "") continue;
      options.push(
        typeof oo.description === "string"
          ? { label: oo.label, description: oo.description }
          : { label: oo.label },
      );
    }
    if (options.length === 0) continue; // 点不动的问题不进弹窗
    out.push({
      question: typeof o.question === "string" ? o.question : "",
      options,
      multi_select: o.multi_select === true,
    });
  }
  return out;
}

/**
 * question：把问题交给界面回调等待用户作答，结果保持既有格式
 * {output:"User has answered your questions: …", answers:[…]}。
 * 多选答案以「、」连接；某题空答（未选/跳过）时该题的 "=…" 为空串，answers 里不出现。
 */
async function questionTool(ctx: ToolContext, a: Args): Promise<string> {
  const raw = a.questions;
  if (!Array.isArray(raw) || raw.length === 0) return err("questions is required and must not be empty");
  const questions = normalizeQuestions(raw);
  if (questions.length === 0) {
    return err("every question needs a non-empty options array (label required)");
  }
  if (!ctx.askQuestions) {
    return err("当前没有可用的提问通道（界面未就绪），请直接继续创作");
  }
  const answers = await ctx.askQuestions(questions);
  // answers 与 questions 按序对应；回调少答/漏答的题按空数组兜底，不让下标越界
  const flat = answers.flat();
  const pairs = questions
    .map((q, i) => `"${q.question}"="${(answers[i] ?? []).join("、")}"`)
    .join(", ");
  return ok({
    output: `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`,
    answers: flat,
  });
}

/**
 * skill_lookup：按技能名或 id 加载 SKILL.md 正文（含目录说明）。
 * 未命中 / 提问通道未装配时回报既有格式的 "Skill not found: …"。
 */
async function skillLookupTool(ctx: ToolContext, a: Args): Promise<string> {
  const name = str(a, "skill_name");
  if (!name) return err("skill_name is required");
  if (!ctx.lookupSkill) return err(`Skill not found: ${name}`);
  const hit = await ctx.lookupSkill(name);
  if (!hit) return err(`Skill not found: ${name}. Check the Available Skills list for valid skill names.`);
  return ok({ skill_name: hit.skill_name, content: hit.content });
}

// ────────────────────────────── 分发 ──────────────────────────────

/** 带当前调用 id 的工具上下文（agent 循环每个 tool call 覆盖 currentCallId 后传入） */
export interface ToolContextWithCall extends ToolContext {
  currentCallId?: string;
}

/**
 * 执行一个工具调用，返回**结果 JSON 字符串**（写入会话的 toolCalls[].result）。
 * 本函数自身不抛业务异常：参数坏、路径越权、目标缺失都回报 {"error":"…"}；
 * I/O 层意外异常由调用方（agent 循环）兜底转成同形态错误 JSON。
 */
export async function executeTool(
  ctx: ToolContextWithCall,
  name: string,
  argsJson: string | Record<string, unknown>,
): Promise<string> {
  let args: Args;
  if (typeof argsJson === "string") {
    try {
      args = JSON.parse(argsJson) as Args;
    } catch {
      return err("工具参数不是合法 JSON");
    }
  } else {
    args = argsJson;
  }
  // 模型可能给出 null / 标量参数体：按空参数集走正常的"缺参"错误分支，而不是抛 TypeError
  if (args === null || typeof args !== "object") args = {};

  switch (name) {
    case "file_read":
      return fileRead(ctx, args);
    case "file_write":
      return fileWrite(ctx, args);
    case "file_manage":
      return fileManage(ctx, args);
    case "create_project":
      return createProjectTool(ctx, args);
    case "question":
      return questionTool(ctx, args);
    case "skill_lookup":
      return skillLookupTool(ctx, args);
    default:
      return err("Unsupported operation: " + name);
  }
}
