import type { FsBridge } from "../fsbridge";
import { join, PROJECT_DIRS } from "../dirs";
import { newItemId } from "../ids";
import { assertTrustedTeachingPath } from "./path";

export interface ReviewIssue {
  id: string;
  category: string;
  quote: string;
  problem: string;
  basis: string;
  impact: string;
  direction: string;
  status: "pending" | "accepted" | "ignored";
  snapshotHash: string;
  /** 1 起算；整体问题不带行号。 */
  startLine?: number;
}

export interface ReviewBatch {
  id: string;
  /** 调用方提供的章节标识，通常为相对作品根的路径；只作为元数据，不参与拼路径。 */
  chapter: string;
  channel: "plot" | "style";
  createdAt: string;
  snapshotHash: string;
  issues: ReviewIssue[];
}

// 同步接口无法使用异步 Web Crypto；按 SHA-256 标准对 UTF-8 正文计算，不能以长度冒充快照。
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** 精确正文快照 SHA-256（小写十六进制）；换行和空白变化也使旧定位失效。 */
export function computeReviewHash(source: string): string {
  const bytes = new TextEncoder().encode(source);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = w[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + w[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = hh + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((value, i) => { h[i] = (h[i] + value) >>> 0; });
  }
  return h.map(value => value.toString(16).padStart(8, "0")).join("");
}

const fields = ["category", "quote", "problem", "basis", "impact", "direction"] as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("审读条目必须为对象");
  return value as Record<string, unknown>;
}
function exactKeys(o: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(o).some(key => !allowed.includes(key))) throw new Error("审读 schema 包含未允许的字段");
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function validateContent(o: Record<string, unknown>): void {
  for (const field of fields) {
    if (typeof o[field] !== "string" || (field !== "quote" && !text(o[field]))) throw new Error("审读字段无效：" + field);
  }
  if (o.startLine !== undefined && (!Number.isSafeInteger(o.startLine) || (o.startLine as number) < 1)) throw new Error("startLine 必须为正整数");
  if (o.quote === "" && o.startLine !== undefined) throw new Error("整体问题不允许 startLine");
}
function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}
function quotePosition(source: string, quote: string, startLine?: number) {
  const matches: number[] = [];
  for (let offset = source.indexOf(quote); offset >= 0; offset = source.indexOf(quote, offset + 1)) {
    if (startLine === undefined || lineAt(source, offset) === startLine) matches.push(offset);
  }
  if (matches.length !== 1) throw new Error(matches.length ? "引文位置存在歧义，请提供唯一 startLine" : "引文不存在或 startLine 与原文不符");
  const start = matches[0], end = start + quote.length;
  return { start, end, startLine: lineAt(source, start), endLine: lineAt(source, end - 1) };
}

/** 严格 JSON 数组：六个必需字段 + 可选 startLine；任一条失败即拒绝整批，不做宽松截取。 */
export function parseReviewResponse(response: string, source: string): ReviewIssue[] {
  const raw: unknown = JSON.parse(response);
  if (!Array.isArray(raw)) throw new Error("审读响应必须为 JSON 数组");
  const snapshotHash = computeReviewHash(source);
  return raw.map(value => {
    const o = object(value);
    exactKeys(o, [...fields, "startLine"]);
    validateContent(o);
    const content = Object.fromEntries(fields.map(field => [field, o[field]])) as Pick<ReviewIssue, typeof fields[number]>;
    const position = content.quote === "" ? null : quotePosition(source, content.quote, o.startLine as number | undefined);
    return { ...content, id: newItemId(), status: "pending", snapshotHash, ...(position ? { startLine: position.startLine } : {}) };
  });
}

/** UTF-16 offset，start 含/end 不含；行号 1 起算。正文变化、整体问题或失效引文均返回 null。 */
export function locateReviewQuote(source: string, issue: ReviewIssue): { start: number; end: number; startLine: number; endLine: number } | null {
  if (!issue.quote || computeReviewHash(source) !== issue.snapshotHash) return null;
  try { return quotePosition(source, issue.quote, issue.startLine); } catch { return null; }
}

function reviewDir(root: string): string {
  return join(root, PROJECT_DIRS.docs, PROJECT_DIRS.review, "审读");
}
function validId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id);
}
function validHash(hash: unknown): hash is string {
  return typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);
}
function validateBatch(value: unknown): ReviewBatch {
  const o = object(value);
  exactKeys(o, ["id", "chapter", "channel", "createdAt", "snapshotHash", "issues"]);
  if (!validId(o.id) || !text(o.chapter) || !text(o.createdAt) || !Number.isFinite(Date.parse(o.createdAt)) || !validHash(o.snapshotHash) || (o.channel !== "plot" && o.channel !== "style") || !Array.isArray(o.issues)) throw new Error("审读批次元数据无效");
  const ids = new Set<string>();
  for (const value of o.issues) {
    const issue = object(value);
    exactKeys(issue, [...fields, "id", "status", "snapshotHash", "startLine"]);
    validateContent(issue);
    if (!validId(issue.id) || ids.has(issue.id) || issue.snapshotHash !== o.snapshotHash || !["pending", "accepted", "ignored"].includes(issue.status as string) || (issue.quote !== "" && issue.startLine === undefined)) throw new Error("审读问题状态或快照无效");
    ids.add(issue.id);
  }
  return o as unknown as ReviewBatch;
}
function immutableContent(batch: ReviewBatch): string {
  return JSON.stringify([batch.id, batch.chapter, batch.channel, batch.createdAt, batch.snapshotHash,
    batch.issues.map(issue => [issue.id, ...fields.map(field => issue[field]), issue.snapshotHash, issue.startLine])]);
}

// 同桥同文件串行保存，避免双击生成或连续状态更新绕过旧批次保护。
const saves = new WeakMap<FsBridge, Map<string, Promise<void>>>();

/** 每批独立保存且永不清理旧批次；同 ID 只允许作者更新问题状态。 */
export async function saveReviewBatch(fs: FsBridge, root: string, batch: ReviewBatch): Promise<void> {
  validateBatch(batch);
  const serialized = JSON.stringify(batch, null, 2);
  const captured = validateBatch(JSON.parse(serialized));
  const path = join(reviewDir(root), captured.id + ".json");
  let pending = saves.get(fs);
  if (!pending) { pending = new Map(); saves.set(fs, pending); }
  const work = (pending.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await assertTrustedTeachingPath(fs, root, path);
    if (await fs.exists(path)) {
      await assertTrustedTeachingPath(fs, root, path);
      const previous = validateBatch(JSON.parse(await fs.readText(path)));
      if (immutableContent(previous) !== immutableContent(captured)) throw new Error("旧审读批次内容不可覆盖，只能更新作者状态");
    }
    await assertTrustedTeachingPath(fs, root, path);
    await fs.writeText(path, serialized);
  });
  pending.set(path, work);
  try { await work; } finally { if (pending.get(path) === work) pending.delete(path); }
}

/** 新批次在前；损坏的已保存批次显式报错，不能静默伪装成没有历史。 */
export async function loadReviewBatches(fs: FsBridge, root: string, chapter: string): Promise<ReviewBatch[]> {
  const directory = reviewDir(root);
  await assertTrustedTeachingPath(fs, root, directory);
  const batches: ReviewBatch[] = [];
  for (const entry of await fs.list(directory)) {
    if (!entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -5);
    if (!validId(id)) continue;
    const path = join(directory, entry.name);
    await assertTrustedTeachingPath(fs, root, path);
    if (entry.isLink) throw new Error("教学路径不可信：审读批次是链接");
    if (entry.isDir) continue;
    const batch = validateBatch(JSON.parse(await fs.readText(path)));
    if (batch.id !== id) throw new Error("审读批次 ID 与文件名不符");
    if (batch.chapter === chapter) batches.push(batch);
  }
  return batches.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}
