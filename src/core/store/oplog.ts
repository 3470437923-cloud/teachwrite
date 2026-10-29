/**
 * 用户操作日志（writerd_oplog）与文本 diff。
 *
 * 落盘：<作品根>\writerd_oplog\log.jsonl —— 每行一条 JSON（append-only）。
 * 系统级目录：左栏不显示（isSystemEntryName 排除），AI 在授权根内可直读。
 *
 * 用途：
 *  1. 回流审查的原料（结束编辑后 AI 按 diff + 日志做一致性核对与学习）；
 *  2. 个人改稿学习的事实依据（AI 交付版 vs 用户最终版）；
 *  3. 用户行为可追溯（每一个操作都被记录）。
 */

import type { FsBridge } from "../fsbridge";
import { PROJECT_DIRS, join, projectOplogDir } from "../dirs";
import { isoMicros } from "../ids";

export type OpAction =
  | "open"
  | "edit_start"
  | "edit_end"
  | "save"
  | "adopt"
  | "discard"
  | "question"
  | "coldread"
  | "reflow"
  | "rule_confirm"
  | "create_project"
  | "switch_project"
  // D-056：左栏「小说资料」树内文件管理（新增/重命名/删除），用户手动操作
  | "doc_create"
  | "doc_rename"
  | "doc_delete";

export interface OplogDetail {
  /** 编辑会话内的变更统计（edit_end 时携带） */
  changedChars?: number;
  addedLines?: number;
  removedLines?: number;
  digitsChanged?: boolean;
  /** 是否触发了完整回流（false = 轻量回流仅记录） */
  reflowTriggered?: boolean;
  /** 附注（如"关窗自动保存，回流顺延"） */
  note?: string;
  /** 回流任务 id（pending/完成两行各记一次，补跑扫描按它配对） */
  reflowId?: string;
  /** true = 入队待跑；完成时同 id 再记一行不带 pending 的 */
  reflowPending?: boolean;
  /** 回流通道（facts / style） */
  reflowTrack?: string;
  /** 回流任务文本（pending 行携带，重启用它重建任务） */
  prompt?: string;
  /** 回流会话标题（pending 行携带） */
  title?: string;
  /** 冷读通道（D-045：plot / style） */
  coldChannel?: string;
  /** 冷读附带的前文数 */
  coldPriors?: number;
  /** 冷读解析出的问题条数（不含内容，内容不落盘） */
  coldIssues?: number;
  /** doc_rename 的新相对路径（'/' 分隔） */
  renameTo?: string;
}

export interface OplogEntry {
  ts: string;
  action: OpAction;
  /** 相对作品根路径（'/' 分隔）；无对象时为 '' */
  relPath: string;
  /** 触发时所在会话（可空） */
  sessionId: string;
  detail: OplogDetail;
}

/** 操作日志文件路径：<作品根>\writerd_oplog\log.jsonl（目录名为磁盘契约，不随产品改名） */
export function oplogFile(projectRoot: string): string {
  return join(projectOplogDir(projectRoot), "log.jsonl");
}

/**
 * 追加一条操作日志（目录不存在时自动建；失败不阻断用户操作）。
 * JSONL 契约：每条一行 JSON、以 '\n'（LF）结尾——追加即写入，不回读不重排，
 * 读取侧按 /\r?\n/ 拆行，两种行尾都兼容。relPath 统一 '/' 分隔落盘。
 */
export async function appendOplog(
  fs: FsBridge,
  projectRoot: string,
  action: OpAction,
  relPath: string,
  sessionId = "",
  detail: OplogDetail = {},
  now: Date = new Date(),
): Promise<void> {
  const entry: OplogEntry = {
    ts: isoMicros(now),
    action,
    relPath: relPath.replace(/\\/g, "/"),
    sessionId,
    detail,
  };
  try {
    await fs.mkdir(projectOplogDir(projectRoot));
    await fs.appendText(oplogFile(projectRoot), JSON.stringify(entry) + "\n");
  } catch {
    // 日志失败不阻断写作
  }
}

/**
 * 读取最近 limit 条日志（文件缺失/读取失败 → 空数组；损坏行跳过）。
 * 文件本身按追加序即时间序，取尾部 limit 条即「最近」，返回仍按时间升序。
 */
export async function readOplog(
  fs: FsBridge,
  projectRoot: string,
  limit = 200,
): Promise<OplogEntry[]> {
  const file = oplogFile(projectRoot);
  if (!(await fs.exists(file))) return [];
  let text: string;
  try {
    text = await fs.readText(file);
  } catch {
    return [];
  }
  const out: OplogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as OplogEntry;
      if (typeof o.action === "string") out.push(o);
    } catch {
      // 跳过损坏行
    }
  }
  return out.slice(Math.max(0, out.length - limit));
}

// ────────────────────────────── 回流队列持久化（D-043） ──────────────────────────────

/** 一条待补跑的回流任务（从 oplog 重建） */
export interface PendingReflow {
  reflowId: string;
  title: string;
  prompt: string;
  /** 通道（facts/style）；旧日志没有该字段时按 facts */
  track: "facts" | "style";
}

/**
 * 扫描操作日志里「入队了但没跑完」的回流任务：
 * reflowPending:true 的行是入队，同 reflowId 的后续非 pending 行是完成；
 * 只有 pending 没有完成的 = 关窗/崩溃丢掉的任务（队列原来只在内存里）。
 * 按出现顺序返回，供打开作品时补跑。
 */
export function pendingRefrows(entries: OplogEntry[]): PendingReflow[] {
  const outstanding = new Map<string, PendingReflow>();
  for (const e of entries) {
    if (e.action !== "reflow") continue;
    const d = e.detail;
    if (!d.reflowId) continue;
    if (d.reflowPending) {
      if (typeof d.prompt === "string" && d.prompt !== "") {
        outstanding.set(d.reflowId, {
          reflowId: d.reflowId,
          title: typeof d.title === "string" && d.title !== "" ? d.title : "回流任务",
          prompt: d.prompt,
          track: d.reflowTrack === "style" ? "style" : "facts",
        });
      }
    } else {
      outstanding.delete(d.reflowId);
    }
  }
  return [...outstanding.values()];
}

// ────────────────────────────── 文本 diff ──────────────────────────────

export interface DiffResult {
  /** 新增行（after 有 before 无，按出现顺序） */
  added: string[];
  /** 删除行（before 有 after 无） */
  removed: string[];
  /** 变更的非空白字符数（added+removed 行的非空白字符总量） */
  changedChars: number;
  /** 数字串集合是否变化（金额/数量/时间等事实信号） */
  digitsChanged: boolean;
}

/** 统计行集合的非空白字符总数（空白差异不计入"改动量"） */
function countNonWs(lines: string[]): number {
  let n = 0;
  for (const l of lines) n += l.replace(/\s/g, "").length;
  return n;
}

/** 提取文本中的数字串（含小数），排序后作为多重集合比较 */
export function digitTokens(text: string): string[] {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).slice().sort();
}

/**
 * 行级 diff（前后缀裁剪法）：先去掉公共前缀/后缀，中间即为变更块。
 * 不做完整 LCS——回流只需要"改了哪些行、量有多大"，够用且 O(n)。
 * 语义边界（有意为之）：
 *  - 按 /\r?\n/ 拆行，纯 EOL 变化（CRLF↔LF）不视为内容差异；
 *  - changedChars 是「变更行」的非空白字符总量（增+删两侧相加），不是最小编辑距离；
 *  - digitsChanged 对**全文**的数字串多重集合比较，与变更块位置无关——
 *    数字换了位置但集合不变时不算变化（保守：仍会因行变更进入 diff）。
 */
export function diffLines(before: string, after: string): DiffResult {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  const da = digitTokens(before).join(",");
  const db = digitTokens(after).join(",");
  return {
    added,
    removed,
    changedChars: countNonWs(added) + countNonWs(removed),
    digitsChanged: da !== db,
  };
}

/** 轻量回流阈值：变更非空白字符数不超过该值且数字未变 → 只记日志，不惊动 AI */
export const LIGHT_EDIT_CHARS = 24;

/**
 * 是否轻量编辑：变更非空白字符数 ≤ 阈值（默认 24）**且**数字串集合未变。
 * 满足 → 只记 oplog，不触发完整回流；任一不满足 → 事实可能变了，必须回流审查。
 */
export function isLightEdit(diff: DiffResult, threshold = LIGHT_EDIT_CHARS): boolean {
  return diff.changedChars <= threshold && !diff.digitsChanged;
}

/** diff 摘要文本（喂给回流 AI；单行截断，总量封顶） */
export function diffSummaryText(diff: DiffResult, maxLines = 40, maxLineChars = 120): string {
  const cut = (s: string) => (s.length > maxLineChars ? s.slice(0, maxLineChars) + "…" : s);
  const out: string[] = [];
  for (const l of diff.removed.slice(0, maxLines)) out.push("- " + cut(l));
  if (diff.removed.length > maxLines) out.push(`- …（其余 ${diff.removed.length - maxLines} 行删除省略）`);
  for (const l of diff.added.slice(0, maxLines)) out.push("+ " + cut(l));
  if (diff.added.length > maxLines) out.push(`+ …（其余 ${diff.added.length - maxLines} 行新增省略）`);
  return out.join("\n");
}

export { PROJECT_DIRS };
