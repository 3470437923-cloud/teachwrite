/**
 * 用量面板的**展示口径**（纯函数，零网络、零 DOM）。
 *
 * 为什么单列一个模块：面板上有 4 块数据（今日 token、本次会话、闲忙时、余额），
 * 每一块的"数字怎么念"都有裁决依据，散在组件里就会各写一套：
 *  - D-019：面板显示「今日汇总 + 本次会话累计」，token 粒度 = 输入/输出/缓存命中/未命中；
 *  - D-020：**不做人民币用量估算** → 这里没有任何价格换算，只有 token 与官方余额；
 *  - D-021：闲忙时只按 UTC 窗口判定，节假日不计入（文案里必须说明）。
 */

import { formatCountdown, type PeakStatus } from "./peak";
import { cacheHitRate, type BalanceSnapshot, type UsageTotals } from "./stats";
import type { BalanceInfo } from "../ai/balance";

/** 千分位整数（token 计数一律整数；不引 Intl，避免运行环境 locale 差异） */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 缓存命中率文案：没有缓存数据时说清"没有数据"，不显示 0%（那是误导） */
export function hitRateText(t: UsageTotals): string {
  const r = cacheHitRate(t);
  if (r === null) return "无缓存数据";
  return `${(r * 100).toFixed(1)}%`;
}

export interface UsageRow {
  label: string;
  value: string;
}

/** 今日汇总的四行（输入 / 输出 / 缓存命中 / 未命中） */
export function todayRows(t: UsageTotals): UsageRow[] {
  return [
    { label: "输入", value: formatTokens(t.inputTokens) },
    { label: "输出", value: formatTokens(t.outputTokens) },
    { label: "缓存命中", value: formatTokens(t.cacheHitTokens) },
    { label: "缓存未命中", value: formatTokens(t.cacheMissTokens) },
  ];
}

/** 本次会话累计的三行（输入 / 输出 / 合计）——比今日少两行，面板更紧凑 */
export function sessionRows(t: UsageTotals): UsageRow[] {
  return [
    { label: "输入", value: formatTokens(t.inputTokens) },
    { label: "输出", value: formatTokens(t.outputTokens) },
    { label: "合计", value: formatTokens(t.inputTokens + t.outputTokens) },
  ];
}

export interface PeakText {
  /** 「忙时」/「闲时」 */
  state: string;
  /** 「距下次切换 3h12m」 */
  countdown: string;
  /** 本地窗口文案 */
  windows: string;
  /** 节假日口径提醒 */
  note: string;
}

export function peakText(s: PeakStatus): PeakText {
  return {
    state: s.isPeak ? "忙时" : "闲时",
    countdown: `${s.nextIsPeak ? "转忙时" : "转闲时"} · ${formatCountdown(s.msToSwitch)}`,
    windows: s.localWindows,
    note: s.holidayNote,
  };
}

export interface BalanceText {
  /** 主行（金额或原因） */
  main: string;
  /** 副行（赠送/充值拆分、可用状态） */
  sub: string;
}

/**
 * 余额文案。
 * `info === null` 且 `reason` 有值 → 显示原因（未查询 / 非官方平台 / 查询失败）。
 * 金额一律**原样展示官方字符串**（不 parseFloat 再格式化：那是自己造数）。
 */
export function balanceText(info: BalanceInfo | null, reason: string): BalanceText {
  if (!info) return { main: reason, sub: "" };
  if (info.balances.length === 0) {
    return { main: "官方未返回余额明细", sub: info.isAvailable ? "账户可用" : "账户不可用" };
  }
  const first = info.balances[0];
  const extra = info.balances.length > 1 ? `（另有 ${info.balances.length - 1} 个币种）` : "";
  return {
    main: `${first.currency} ${first.totalBalance}${extra}`,
    sub: `赠送 ${first.grantedBalance} · 充值 ${first.toppedUpBalance} · ${
      info.isAvailable ? "账户可用" : "余额不足"
    }`,
  };
}

/** 余额刷新节流窗口：60 秒内重复打开面板不再打上游（D-019 的"打开时刷新"） */
export const BALANCE_THROTTLE_MS = 60_000;

/**
 * 余额响应 → 落盘快照（`usage_stats.json.lastBalance`）。
 * 只取第一个币种（官方目前只返 CNY/USD 之一），金额保持**官方原字符串**。
 * 没有币种明细时返回 null（不写一个空快照，免得下次打开面板显示一串 0）。
 */
export function balanceSnapshot(info: BalanceInfo, at: string): BalanceSnapshot | null {
  const first = info.balances[0];
  if (!first) return null;
  return {
    at,
    isAvailable: info.isAvailable,
    currency: first.currency,
    total: first.totalBalance,
    granted: first.grantedBalance,
    toppedUp: first.toppedUpBalance,
  };
}

/** 余额快照 → 面板文案（离线时先展示上次快照，注明时间；不把它当成"实时"） */
export function snapshotText(s: BalanceSnapshot | null): BalanceText {
  if (!s) return { main: "尚未查询过余额", sub: "" };
  const when = s.at.replace("T", " ").slice(0, 16);
  return {
    main: `${s.currency} ${s.total}`,
    sub: `赠送 ${s.granted} · 充值 ${s.toppedUp} · 快照于 ${when}`,
  };
}

/** 该不该真的去查余额（节流判定，纯函数便于单测） */
export function shouldRefreshBalance(lastFetchedAt: number, now: number): boolean {
  if (lastFetchedAt <= 0) return true;
  return now - lastFetchedAt >= BALANCE_THROTTLE_MS;
}

/** 闲置阈值：45 秒没有输入即视为闲置。
 *  注意：D-039 起鲸鱼固定静止、不再游动，「闲置停游」随之移除 —— 本常量与 isIdle
 *  目前**没有生产消费方**，仅由 tests/usage/view.test.ts 的回归锁守着（纯函数，
 *  保留无害；将来若复活闲置类动效可直接复用，不必重写）。 */
export const IDLE_AFTER_MS = 45_000;

/** 是否已闲置（纯函数：面板/鲸鱼的"停下游动"都靠它） */
export function isIdle(lastActivityAt: number, now: number, threshold: number = IDLE_AFTER_MS): boolean {
  if (lastActivityAt <= 0) return false;
  return now - lastActivityAt >= threshold;
}