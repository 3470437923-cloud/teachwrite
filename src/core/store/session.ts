/**
 * 会话存储（保持既有格式）。
 *
 * 目录：<Documents>\writerd_sessions\
 *   <uuid>.json  {"id","title","projectPath","createdAt","updatedAt","messages":[…]}
 *   index.json   {"version":1,"sessions":{"<uuid>":{"title","projectPath","createdAt",
 *                 "updatedAt","userMessageCount","size","mtimeMs"}}}
 * 消息形态（实测样本）：{"id","role","text","thinking","toolCalls","toolResults","createdAt"}
 * 空会话标题：`New Chat - 2026-05-21T16:58`；有首条用户消息后取前 30 字 + `...`
 */

import type { FsBridge } from "../fsbridge";
import { join } from "../dirs";
import { isoMicros } from "../ids";
import type { ChatMessage } from "../ai/protocol";

/** 会话文件形态：<uuid>.json 的解析结果（messages 按对话顺序） */
export interface SessionFile {
  id: string;
  title: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

/** 索引条目：会话列表渲染所需的元信息（不载消息体，列表页免读大文件） */
export interface SessionIndexEntry {
  title: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  /** 用户消息条数（列表页展示用） */
  userMessageCount: number;
  /** 会话文件字节数 */
  size: number;
  /** 会话文件落盘后的 mtime（毫秒）；按日分组与排序的时间来源 */
  mtimeMs: number;
}

/** 会话索引 index.json（磁盘契约：version=1，sessions 为 id → 条目 的映射） */
export interface SessionIndex {
  version: number;
  sessions: Record<string, SessionIndexEntry>;
}

export const SESSION_INDEX_VERSION = 1;
/** 标题截断长度（既有契约：首条用户消息前 30 字 + "..."） */
export const TITLE_MAX = 30;

/** 空索引（version=1，无会话） */
export function emptyIndex(): SessionIndex {
  return { version: SESSION_INDEX_VERSION, sessions: {} };
}

/** 会话文件路径：<sessionsDir>\<id>.json */
export function sessionFile(sessionsDir: string, id: string): string {
  return join(sessionsDir, `${id}.json`);
}

/** 索引文件路径：<sessionsDir>\index.json（目录名为磁盘契约 writerd_sessions，不随产品改名） */
export function indexFile(sessionsDir: string): string {
  return join(sessionsDir, "index.json");
}

/** 生成会话 id（uuid v4）：优先 crypto.randomUUID，缺失环境退化为 Math.random 版 */
export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** `New Chat - 2026-05-21T16:58`（空会话标题形态） */
export function defaultTitle(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `New Chat - ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 首条用户消息 → 标题：压缩连续空白后取前 30 字，超长补 "..."。
 * 已知边界：按 UTF-16 码元截断，第 30 位恰为代理对（emoji 等）中间时会截出半个字符——
 * 展示层会渲染为替换符，不影响存储安全，保持既有契约不改（见审计报告）。
 */
export function titleFromText(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t === "") return "";
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) + "..." : t;
}

/** 新建空会话：uuid 作 id，标题取 `New Chat - <本地时间>` 形态，时间戳为微秒 ISO */
export function newSession(projectPath: string, now: Date = new Date()): SessionFile {
  const stamp = isoMicros(now);
  return {
    id: uuid(),
    title: defaultTitle(now),
    projectPath,
    createdAt: stamp,
    updatedAt: stamp,
    messages: [],
  };
}

/**
 * 解析会话文件：缺 id 或缺 messages 数组、JSON 损坏 → null（调用方按「会话不存在」处理）。
 * 字段级容错：title/projectPath 缺失取空串，createdAt/updatedAt 缺失取当前时间。
 * 已知边界：messages 数组内条目不逐条校验形态，畸形消息原样透传给渲染层。
 */
export function parseSession(text: string): SessionFile | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Partial<SessionFile>;
    if (typeof o.id !== "string" || !Array.isArray(o.messages)) return null;
    return {
      id: o.id,
      title: typeof o.title === "string" ? o.title : "",
      projectPath: typeof o.projectPath === "string" ? o.projectPath : "",
      createdAt: typeof o.createdAt === "string" ? o.createdAt : isoMicros(),
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : isoMicros(),
      messages: o.messages as ChatMessage[],
    };
  } catch {
    return null;
  }
}

/** 索引条目字段级容错（与 parseSession 同口径）：类型不符的字段回落默认值，
 *  非对象条目整条丢弃 —— 索引被外部写坏（projectPath 是数字/null 等）时，
 *  不能让 samePath 的字符串假设在删除流程里抛 TypeError。 */
function normalizeIndexEntry(v: unknown): SessionIndexEntry | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const e = v as Record<string, unknown>;
  const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    title: typeof e.title === "string" ? e.title : "",
    projectPath: typeof e.projectPath === "string" ? e.projectPath : "",
    createdAt: typeof e.createdAt === "string" ? e.createdAt : "",
    updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : "",
    userMessageCount: Math.max(0, Math.floor(num(e.userMessageCount))),
    size: Math.max(0, num(e.size)),
    mtimeMs: Math.max(0, num(e.mtimeMs)),
  };
}

/** 解析索引：损坏/非对象 → 空索引；条目逐条字段级容错（列表页永不因索引损坏而崩） */
export function parseIndex(text: string): SessionIndex {
  try {
    const raw: unknown = JSON.parse(text);
    if (raw && typeof raw === "object") {
      const o = raw as Partial<SessionIndex>;
      const sessions: Record<string, SessionIndexEntry> = {};
      const src = o.sessions;
      if (src && typeof src === "object" && !Array.isArray(src)) {
        for (const [id, e] of Object.entries(src as Record<string, unknown>)) {
          const entry = normalizeIndexEntry(e);
          if (entry) sessions[id] = entry;
        }
      }
      return {
        version: typeof o.version === "number" ? o.version : SESSION_INDEX_VERSION,
        sessions,
      };
    }
  } catch {
    // 损坏即视为空索引
  }
  return emptyIndex();
}

/** 读索引（文件缺失 → 空索引） */
export async function loadIndex(fs: FsBridge, sessionsDir: string): Promise<SessionIndex> {
  const f = indexFile(sessionsDir);
  if (!(await fs.exists(f))) return emptyIndex();
  return parseIndex(await fs.readText(f));
}

/** 写索引（整体覆盖；调用方必须先 loadIndex 再改再存，或走本模块的串行化入口） */
export async function saveIndex(fs: FsBridge, sessionsDir: string, index: SessionIndex): Promise<void> {
  await fs.writeText(indexFile(sessionsDir), JSON.stringify(index));
}

/**
 * 索引写入串行化队列（进程内）。
 * saveSession / deleteSession 都是「读 index → 改 → 写回」三步，并发调用
 * （如主会话自动保存与回流/冷读会话落盘同时发生）会互相覆盖、丢失条目。
 * 用 promise 链把全部索引写入排成一队，按调用顺序生效；
 * 队列永不拒绝（前序失败不阻断后续任务），异常仍抛给各自调用方。
 * 跨进程并发（双开应用）不在本层解决范围——见审计报告。
 */
let indexQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = indexQueue.then(task);
  indexQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 保存会话文件并同步索引条目（经串行化队列，进程内并发安全）。
 * 索引条目的 size 取序列化后字节数、mtimeMs 取落盘后 stat（stat 失败退化为当前时间）；
 * 按日分组等 UI 逻辑依赖的即这里的 mtimeMs 与 createdAt/updatedAt。
 */
export async function saveSession(fs: FsBridge, sessionsDir: string, s: SessionFile): Promise<SessionIndex> {
  return serialized(async () => {
    const body = JSON.stringify(s);
    await fs.writeText(sessionFile(sessionsDir, s.id), body);
    const index = await loadIndex(fs, sessionsDir);
    // 索引写失败时的孤儿防护：**新**会话已在盘上但索引无条目 → 列表永远看不到它，
    // 回滚掉刚写的文件（已有会话不滚 —— 那会连历史版本一起毁掉）。
    const isNew = !(s.id in index.sessions);
    const st = await fs.stat(sessionFile(sessionsDir, s.id));
    index.sessions[s.id] = {
      title: s.title,
      projectPath: s.projectPath,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      userMessageCount: s.messages.filter((m) => m.role === "user").length,
      size: new TextEncoder().encode(body).length,
      mtimeMs: st?.mtimeMs ?? Date.now(),
    };
    try {
      await saveIndex(fs, sessionsDir, index);
    } catch (e) {
      if (isNew) {
        try {
          await fs.remove(sessionFile(sessionsDir, s.id), false);
        } catch {
          // 回滚失败不再掩盖原始的索引写错误
        }
      }
      throw e;
    }
    return index;
  });
}

/** 读取单个会话（文件缺失或损坏 → null） */
export async function loadSession(fs: FsBridge, sessionsDir: string, id: string): Promise<SessionFile | null> {
  const f = sessionFile(sessionsDir, id);
  if (!(await fs.exists(f))) return null;
  return parseSession(await fs.readText(f));
}

/**
 * 删除会话：删文件 + 清索引条目（经串行化队列）。
 * fs.remove 对缺失文件是 no-op（生产/测试两侧契约一致），重复删除幂等。
 */
export async function deleteSession(fs: FsBridge, sessionsDir: string, id: string): Promise<void> {
  return serialized(async () => {
    await fs.remove(sessionFile(sessionsDir, id), false);
    const index = await loadIndex(fs, sessionsDir);
    delete index.sessions[id];
    await saveIndex(fs, sessionsDir, index);
  });
}

/** 会话列表条目 = 索引条目 + id */
export interface SessionListEntry extends SessionIndexEntry {
  id: string;
}

/**
 * 路径比较口径（Windows：大小写不敏感、分隔符统一）——只用于**比较**，不用于拼路径。
 */
function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

/**
 * 删除某作品的**全部**会话（文件 + 索引条目），返回删除条数与 id 列表。
 *
 * 用于「移入回收站」：会话与作品绑死，作品搬走后会话列表里留下的是一堆孤儿
 * （点开只会报作品不存在）。原版行为就是把它们一起删掉并提示
 * 「已移至回收站，并删除 N 个会话」—— 本函数就是那句话里的 N。
 *
 * 注意：**不可还原**。作品能从回收站还原，这些会话不能（确认弹窗里要写明）。
 */
export async function deleteSessionsForProject(
  fs: FsBridge,
  sessionsDir: string,
  projectPath: string,
): Promise<{ count: number; ids: string[] }> {
  return serialized(async () => {
    const index = await loadIndex(fs, sessionsDir);
    const ids = Object.entries(index.sessions)
      .filter(([, e]) => samePath(e.projectPath, projectPath))
      .map(([id]) => id);
    if (ids.length === 0) return { count: 0, ids: [] };
    for (const id of ids) {
      // fs.remove 对缺失文件是 no-op（两侧契约一致），索引条目照样清掉
      await fs.remove(sessionFile(sessionsDir, id), false);
      delete index.sessions[id];
    }
    await saveIndex(fs, sessionsDir, index);
    // 一并交回 id 列表：调用方要拿它去清 AI 侧的会话级内存缓存（KL-AI-11），
    // 只回一个数字会让上层无从下手，于是又得重读一遍索引。
    return { count: ids.length, ids };
  });
}

/**
 * 会话列表（按 updatedAt 字符串倒序，保持既有行为）。
 * updatedAt 为定长微秒 ISO 串，字典序即时间序；相等时返回 0，
 * 由 sort 的稳定性保持索引原有顺序（旧实现的二值比较器在并列时违反比较器契约）。
 * projectPath 传入时只保留该作品的会话；null/undefined 不过滤。
 */
export function listSessions(index: SessionIndex, projectPath?: string | null): SessionListEntry[] {
  const out: SessionListEntry[] = Object.entries(index.sessions).map(([id, e]) => ({ id, ...e }));
  // 过滤口径与 deleteSessionsForProject 一致（samePath：大小写不敏感、分隔符统一）——
  // 严格相等会在路径风格不一致时过滤不出会话，而删除又能匹配上，留下孤儿会话（B-3）
  const filtered = projectPath ? out.filter((e) => samePath(e.projectPath, projectPath)) : out;
  return filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
