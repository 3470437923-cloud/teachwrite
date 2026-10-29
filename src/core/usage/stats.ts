/**
 * token 统计的数据模型（纯逻辑；磁盘形态 = `usage_stats.json`，见 README 契约表）。
 *
 * 裁决依据：D-019（面板显示「今日汇总 + 本次会话累计」）、D-020（**不做人民币用量估算**，
 * 本文件只存 token 与余额快照）、D-023（新增 additive 契约文件，可随时删除）。
 *
 * 语义要点：上游的 usage 是**请求级快照**（Anthropic 的 `message_delta.output_tokens` 还是累计值），
 * 所以「一次运行内的用量」由 `agent` 汇总成一份 totals 传进来，本模块只负责按日分桶累加。
 */

/** 一份用量合计（与 `agent` 的运行合计同形，避免两处各定义一个零值） */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** 上游磁盘缓存命中的输入 token（DeepSeek 独有字段，其他上游恒为 0） */
  cacheHitTokens: number;
  /** 未命中的输入 token（同上） */
  cacheMissTokens: number;
}

export const ZERO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
};

/** 某一日的汇总（requests = 该日运行次数，含工具循环的多轮请求只记 1 次） */
export interface UsageDay extends UsageTotals {
  requests: number;
}

/** 最近一次余额快照（余额是官方权威数据；本文件只缓存展示，不做任何金额推算） */
export interface BalanceSnapshot {
  at: string;
  isAvailable: boolean;
  currency: string;
  total: string;
  granted: string;
  toppedUp: string;
}

/** 最近一次错误（诊断用：面板异常态与排障） */
export interface UsageNote {
  at: string;
  message: string;
}

export interface UsageStatsFile {
  version: number;
  /** 按**本地日期**分桶，键 `YYYY-MM-DD` */
  days: Record<string, UsageDay>;
  lastBalance: BalanceSnapshot | null;
  lastError: UsageNote | null;
}

export const USAGE_STATS_VERSION = 1;

/** 保留天数：只留最近 90 天（文件不无限增长；超出即丢，统计非关键数据） */
export const USAGE_DAY_KEEP = 90;

/** 空统计 */
export function emptyUsageStats(): UsageStatsFile {
  return { version: USAGE_STATS_VERSION, days: {}, lastBalance: null, lastError: null };
}

/** 非负整数容错：非法值返回 null（调用方回落 0） */
function asNonNegInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

/**
 * 本地日期键 `YYYY-MM-DD`。
 * `offsetMinutes` = 本地相对 UTC 的偏移（东八区为 480）；默认取运行环境时区，
 * 显式传参是为了让单测不依赖跑测机器的时区。
 */
export function dayKey(when: Date, offsetMinutes: number = -when.getTimezoneOffset()): string {
  const shifted = new Date(when.getTime() + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 用量相加（纯函数） */
export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    cacheMissTokens: a.cacheMissTokens + b.cacheMissTokens,
  };
}

/**
 * 缓存命中率（0–1）；**没有任何缓存数据时返回 null**。
 * 返回 null 而不是 0，是为了让面板显示「无缓存数据」而不是误导性的 0%。
 */
export function cacheHitRate(t: UsageTotals): number | null {
  const sum = t.cacheHitTokens + t.cacheMissTokens;
  if (sum === 0) return null;
  return t.cacheHitTokens / sum;
}

/** 记一次运行（返回新对象，不改入参） */
export function recordRun(
  file: UsageStatsFile,
  when: Date,
  delta: UsageTotals,
  offsetMinutes: number = -when.getTimezoneOffset(),
): UsageStatsFile {
  const key = dayKey(when, offsetMinutes);
  const prev = file.days[key] ?? { ...ZERO_USAGE, requests: 0 };
  const next: UsageDay = { ...addTotals(prev, delta), requests: prev.requests + 1 };
  return { ...file, days: { ...file.days, [key]: next } };
}

/** 取某日汇总（无记录时返回全零，不返回 undefined，调用方无需兜底） */
export function todayTotals(
  file: UsageStatsFile,
  when: Date,
  offsetMinutes: number = -when.getTimezoneOffset(),
): UsageDay {
  return file.days[dayKey(when, offsetMinutes)] ?? { ...ZERO_USAGE, requests: 0 };
}

/** 只保留最近 keep 天（键为 `YYYY-MM-DD`，字符串排序即时间排序） */
export function pruneDays(file: UsageStatsFile, keep: number = USAGE_DAY_KEEP): UsageStatsFile {
  const keys = Object.keys(file.days).sort();
  if (keys.length <= keep) return file;
  const days = { ...file.days };
  for (const k of keys.slice(0, keys.length - keep)) delete days[k];
  return { ...file, days };
}

export function withBalance(file: UsageStatsFile, lastBalance: BalanceSnapshot): UsageStatsFile {
  return { ...file, lastBalance };
}

export function withError(file: UsageStatsFile, lastError: UsageNote): UsageStatsFile {
  return { ...file, lastError };
}

/**
 * 解析磁盘文件。容错口径与 `parsePrefs` 一致：BOM / 坏 JSON / 类型不符一律回落，
 * **绝不抛**——统计文件损坏不能影响对话主流程。
 */
export function parseUsageStats(text: string): UsageStatsFile {
  const out = emptyUsageStats();
  const cleaned = text.replace(/^\uFEFF/, "");
  if (!cleaned.trim()) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;

  const days = o.days;
  if (days && typeof days === "object" && !Array.isArray(days)) {
    for (const [k, v] of Object.entries(days as Record<string, unknown>)) {
      // 键形态不对直接丢弃（避免脏键把「今日」查询搅乱）
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const d = v as Record<string, unknown>;
      out.days[k] = {
        inputTokens: asNonNegInt(d.inputTokens) ?? 0,
        outputTokens: asNonNegInt(d.outputTokens) ?? 0,
        cacheHitTokens: asNonNegInt(d.cacheHitTokens) ?? 0,
        cacheMissTokens: asNonNegInt(d.cacheMissTokens) ?? 0,
        requests: asNonNegInt(d.requests) ?? 0,
      };
    }
  }

  const lb = o.lastBalance;
  if (lb && typeof lb === "object" && !Array.isArray(lb)) {
    const b = lb as Record<string, unknown>;
    out.lastBalance = {
      at: typeof b.at === "string" ? b.at : "",
      isAvailable: b.isAvailable === true,
      currency: typeof b.currency === "string" ? b.currency : "",
      total: typeof b.total === "string" ? b.total : "",
      granted: typeof b.granted === "string" ? b.granted : "",
      toppedUp: typeof b.toppedUp === "string" ? b.toppedUp : "",
    };
  }

  const le = o.lastError;
  if (le && typeof le === "object" && !Array.isArray(le)) {
    const e = le as Record<string, unknown>;
    out.lastError = {
      at: typeof e.at === "string" ? e.at : "",
      message: typeof e.message === "string" ? e.message : "",
    };
  }

  return out;
}

/** 序列化为单行 JSON（与 prefs 保持一致：不留换行，便于人工查看与 diff） */
export function serializeUsageStats(file: UsageStatsFile): string {
  return JSON.stringify(file);
}