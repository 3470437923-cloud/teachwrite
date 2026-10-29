/**
 * 写前快照（按会话记录，保持既有格式）。
 *
 * 实测样本（Documents\writerd_snapshots\0114dbe9-….json）：
 * {"sessionId":"…","snapshots":[{"snapshotId":"<uuid>","sessionId":"…",
 *   "callId":"call_00_…","timestamp":"2026-07-05T04:55:23.302527","operation":"write",
 *   "relativePath":"章节内容/第37章.md","previousContent":null,"previousExists":false,
 *   "previousType":"none","renameNewPath":null,"createdPaths":null,
 *   "postContentHash":"<sha256 hex>","directoryEntries":null}]}
 *
 * 纪律（写前快照）：任何回写先留快照；模型侧通用 write/edit 也要走这里。
 */

import type { FsBridge } from "../fsbridge";
import { join } from "../dirs";
import { isoMicros } from "../ids";

export type SnapshotOperation =
  | "write"
  | "append"
  | "replace"
  | "insert"
  | "delete_lines"
  | "copy"
  | "rename"
  | "delete";

export type PreviousType = "none" | "file" | "directory";

export interface SnapshotEntry {
  snapshotId: string;
  sessionId: string;
  callId: string;
  timestamp: string;
  operation: SnapshotOperation;
  /** 相对作品根的路径，'/' 分隔 */
  relativePath: string;
  previousContent: string | null;
  previousExists: boolean;
  previousType: PreviousType;
  renameNewPath: string | null;
  createdPaths: string[] | null;
  /** 写后内容 sha256（小写 hex）；目录操作时为 null */
  postContentHash: string | null;
  directoryEntries: unknown[] | null;
}

export interface SessionSnapshots {
  sessionId: string;
  snapshots: SnapshotEntry[];
}

/** 空快照容器（每会话一个，snapshots 按记录顺序追加） */
export function emptySnapshots(sessionId: string): SessionSnapshots {
  return { sessionId, snapshots: [] };
}

/**
 * 解析会话快照文件：空/损坏 JSON → 空容器（不抛错、不阻断写作）。
 * 文件内 sessionId 优先于入参（文件是事实源）；snapshots 非数组时按空处理。
 * 已知边界：数组内条目不逐条校验字段，畸形条目原样保留（回滚时由调用方判空）。
 */
export function parseSnapshots(text: string, sessionId: string): SessionSnapshots {
  if (!text || !text.trim()) return emptySnapshots(sessionId);
  try {
    const raw: unknown = JSON.parse(text);
    if (raw && typeof raw === "object") {
      const o = raw as Partial<SessionSnapshots>;
      return {
        sessionId: typeof o.sessionId === "string" ? o.sessionId : sessionId,
        snapshots: Array.isArray(o.snapshots) ? (o.snapshots as SnapshotEntry[]) : [],
      };
    }
  } catch {
    // 损坏文件视为空，不阻断写作
  }
  return emptySnapshots(sessionId);
}

/** 序列化为单行 JSON（实测样本即单行——磁盘契约） */
export function serializeSnapshots(s: SessionSnapshots): string {
  return JSON.stringify(s);
}

/** 快照文件路径：<snapshotsDir>\<sessionId>.json（sessionId 为 uuid，天然唯一，一会话一文件） */
export function snapshotFile(snapshotsDir: string, sessionId: string): string {
  return join(snapshotsDir, `${sessionId}.json`);
}

/** 写后内容哈希（sha256 小写 hex） */
export async function contentHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 生成快照条目 uuid：优先 crypto.randomUUID，缺失环境（老 webview）退化为 Math.random 版 v4 形态 */
function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** recordSnapshot 的输入；previousType/renameNewPath 等缺省时按下方规则推导 */
export interface RecordInput {
  sessionId: string;
  callId: string;
  operation: SnapshotOperation;
  relativePath: string;
  /** 写前原文；目标原本不存在时为 null（配合 previousExists=false） */
  previousContent: string | null;
  previousExists: boolean;
  previousType?: PreviousType;
  renameNewPath?: string | null;
  createdPaths?: string[] | null;
  postContentHash?: string | null;
  directoryEntries?: unknown[] | null;
}

/**
 * 快照写入的串行化队列（进程内）。
 * recordSnapshot 是「读文件 → 追加条目 → 整体写回」三步，并发调用会互相覆盖、
 * 丢快照（快照是回滚的唯一依据，丢了就真回不去了）。用一个 promise 链把全部
 * 写入排成一队，按调用顺序生效；队列永不拒绝（前序失败不阻断后续任务），
 * 异常仍抛给各自调用方。
 * 跨进程并发（双开应用）不在本层解决范围 —— 与 session 索引同一条边界（KL-ST-08）。
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 追加一条快照并落盘（读旧文件 → 追加条目 → 整体写回；经串行化队列）。
 * 目录创建依赖 fs.writeText 的契约（生产 Rust 侧与测试 nodeFs 都会自动建父目录）。
 * previousType 缺省时按 previousExists 推导（true→"file"，false→"none"）。
 */
export async function recordSnapshot(
  fs: FsBridge,
  snapshotsDir: string,
  input: RecordInput,
  now: Date = new Date(),
): Promise<SessionSnapshots> {
  return serialized(async () => {
    const file = snapshotFile(snapshotsDir, input.sessionId);
    const existing = (await fs.exists(file)) ? parseSnapshots(await fs.readText(file), input.sessionId) : emptySnapshots(input.sessionId);

    const entry: SnapshotEntry = {
      snapshotId: uuid(),
      sessionId: input.sessionId,
      callId: input.callId,
      timestamp: isoMicros(now),
      operation: input.operation,
      relativePath: input.relativePath,
      previousContent: input.previousContent,
      previousExists: input.previousExists,
      previousType: input.previousType ?? (input.previousExists ? "file" : "none"),
      renameNewPath: input.renameNewPath ?? null,
      createdPaths: input.createdPaths ?? null,
      postContentHash: input.postContentHash ?? null,
      directoryEntries: input.directoryEntries ?? null,
    };

    const next: SessionSnapshots = {
      sessionId: input.sessionId,
      snapshots: [...existing.snapshots, entry],
    };
    await fs.writeText(file, serializeSnapshots(next));
    return next;
  });
}

/** 读取某会话的全部快照（文件缺失 → 空容器；损坏 → parseSnapshots 兜底为空） */
export async function loadSnapshots(
  fs: FsBridge,
  snapshotsDir: string,
  sessionId: string,
): Promise<SessionSnapshots> {
  const file = snapshotFile(snapshotsDir, sessionId);
  if (!(await fs.exists(file))) return emptySnapshots(sessionId);
  return parseSnapshots(await fs.readText(file), sessionId);
}

/**
 * 最近一条针对某路径的快照（回滚用）：倒序查找，命中即返回。
 * relativePath 需与记录时一致（'/' 分隔的相对作品根路径）。
 */
export function lastForPath(s: SessionSnapshots, relativePath: string): SnapshotEntry | null {
  for (let i = s.snapshots.length - 1; i >= 0; i--) {
    if (s.snapshots[i].relativePath === relativePath) return s.snapshots[i];
  }
  return null;
}
