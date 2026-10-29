/**
 * 规则台账（D-043 / B5）：小说资料/个人改稿/规则台账.md 的解析与序列化。
 *
 * 候选规则的计数板：每条 = `## GL-编号` + 固定字段；命中章节数 ≥2 的候选
 * 由回流经 question 提请用户确认后晋升进 06-写作风格.md。
 *
 * 纪律（与追踪表一致）：
 *  - 编号只增不复用；否决标「已否决」留档不删除；
 *  - 只读不判：坏行跳过，绝不抛异常；
 *  - 写回保持既有顺序与原字段。
 */

/** 台账条目（字段名即磁盘契约，逐字） */
export interface LedgerEntry {
  /** GL-001 形态的 id */
  id: string;
  /** 规则：一句话（删什么/改什么/禁什么） */
  rule: string;
  /** 类别：词汇 / 句法 / 标点 / 称谓 / 视角 / 节奏 / 其他 */
  category: string;
  /** 证据（章节 + 对照，分号分隔的原样文本） */
  evidence: string;
  /** 命中章节数 */
  hits: number;
  /** 候选 / 已晋升 / 已否决 */
  status: string;
  /** 最近更新日期（YYYY-MM-DD） */
  updated: string;
}

const ENTRY_RE = /^##\s*(GL-\d+)\s*$/;
const FIELD_RE = /^-\s*([^：:]+?)\s*[：:]\s*(.*)$/;

/** 解析台账全文；任何形态都安全返回（坏条目跳过） */
export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  let cur: LedgerEntry | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const e = ENTRY_RE.exec(line);
    if (e) {
      if (cur) out.push(cur);
      cur = { id: e[1], rule: "", category: "", evidence: "", hits: 0, status: "候选", updated: "" };
      continue;
    }
    if (!cur) continue;
    const f = FIELD_RE.exec(line);
    if (!f) continue;
    const key = f[1].trim();
    const value = f[2].trim();
    if (key === "规则") cur.rule = value;
    else if (key === "类别") cur.category = value;
    else if (key === "证据") cur.evidence = value;
    else if (key === "命中章节数") {
      const n = Number(value);
      cur.hits = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : cur.hits;
    } else if (key === "状态") cur.status = value;
    else if (key === "最近更新") cur.updated = value;
  }
  if (cur) out.push(cur);
  return out;
}

/** 序列化为完整文件（含文件头；条目按给定顺序） */
export function serializeLedger(entries: LedgerEntry[]): string {
  const head =
    "# 规则台账\n" +
    "候选规则的计数板：同类改稿判断再次出现只补证据、命中章节数加一，不重复建条；" +
    "命中章节数达到 2 的候选由回流逐条请用户确认后晋升进 06-写作风格.md，否决标「已否决」留档。\n";
  const body = entries
    .map(
      (e) =>
        `## ${e.id}\n` +
        `- 规则：${e.rule}\n` +
        `- 类别：${e.category}\n` +
        `- 证据：${e.evidence}\n` +
        `- 命中章节数：${e.hits}\n` +
        `- 状态：${e.status}\n` +
        `- 最近更新：${e.updated}\n`,
    )
    .join("\n");
  return head + (body ? "\n" + body : "");
}

/** 下一个可用编号（现有最大编号 +1；空台账从 GL-001 起） */
export function nextLedgerId(entries: LedgerEntry[]): string {
  let max = 0;
  for (const e of entries) {
    const m = /^GL-(\d+)$/.exec(e.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `GL-${String(max + 1).padStart(3, "0")}`;
}

/** 可提请用户确认的候选（命中章节数 ≥2 且尚未处理） */
export function promotableEntries(entries: LedgerEntry[], threshold = 2): LedgerEntry[] {
  return entries.filter((e) => e.status === "候选" && e.hits >= threshold);
}
