/**
 * 闲时 / 忙时判定（纯逻辑，零网络）。
 *
 * 官方规则（`docs/DECISIONS.md` 附录 A §9）：峰值时段 = **UTC 周一至周五
 * 01:00–04:00 与 06:00–10:00**，其余时段（含周末与中国法定节假日全天）为谷价；
 * 谷价 = 峰价一半。
 *
 * 裁决：D-021 —— **只按 UTC 窗口判定，不内置中国法定节假日表**（零维护），
 * 面板文案需注明节假日未计入。
 *
 * 注意：本模块只回答「现在算不算闲时 / 还有多久切换」，**不涉及任何金额**（D-020）。
 */

/** 峰值窗口（UTC 小时，左闭右开） */
export const PEAK_WINDOWS: readonly (readonly [number, number])[] = [
  [1, 4],
  [6, 10],
];

/** 窗口边界小时（用于计算下一次切换） */
const BOUNDARY_HOURS: readonly number[] = [1, 4, 6, 10];

/** 该时刻是否处于峰值时段（UTC 周一至周五的窗口内） */
export function isPeakAt(t: Date): boolean {
  const dow = t.getUTCDay(); // 0 = 周日、6 = 周六
  if (dow === 0 || dow === 6) return false;
  const h = t.getUTCHours();
  return PEAK_WINDOWS.some(([s, e]) => h >= s && h < e);
}

/**
 * 下一次「闲忙状态切换」的时刻与切换后的状态。
 * 边界落在 UTC 整点 1/4/6/10；周末的边界不构成状态变化，一律跳过。
 * 兜底：正常输入下 8 天内必有切换；万一没有，返回 8 天后的 01:00 并保持当前状态。
 */
export function nextSwitch(from: Date): { at: Date; toPeak: boolean } {
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    for (const h of BOUNDARY_HOURS) {
      const cand = new Date(
        Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + dayOffset, h, 0, 0, 0),
      );
      if (cand.getTime() <= from.getTime()) continue;
      const before = isPeakAt(new Date(cand.getTime() - 60_000));
      const after = isPeakAt(cand);
      if (before === after) continue;
      return { at: cand, toPeak: after };
    }
  }
  const fallback = new Date(from.getTime() + 8 * 24 * 60 * 60 * 1000);
  return { at: fallback, toPeak: isPeakAt(from) };
}

export interface PeakStatus {
  /** 现在是否峰值（忙时） */
  isPeak: boolean;
  /** 距下一次切换的毫秒数（面板做倒计时） */
  msToSwitch: number;
  /** 切换后是否峰值 */
  nextIsPeak: boolean;
  /** 本地时区下的忙时段文案（按传入偏移换算，跨零点会注明） */
  localWindows: string;
  /** 节假日口径提醒（D-021：不内置节假日表） */
  holidayNote: string;
}

/** 把 UTC 偏移折算成本地窗口文案；支持半小时时区（如 +05:30） */
export function localWindowText(offsetMinutes: number): string {
  const fmt = (mins: number): string => {
    const m = ((mins % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const parts = PEAK_WINDOWS.map(([s, e]) => {
    const ls = s * 60 + offsetMinutes;
    const le = e * 60 + offsetMinutes;
    const wraps = ((ls % 1440) + 1440) % 1440 >= ((le % 1440) + 1440) % 1440;
    return `${fmt(ls)}–${fmt(le)}${wraps ? "（跨零点）" : ""}`;
  });
  return `周一至周五 ${parts.join("、")}`;
}

/**
 * 面板用的闲时状态快照。
 * `offsetMinutes` 默认取运行环境时区；显式传参让单测与时区无关。
 */
export function peakStatus(now: Date, offsetMinutes: number = -now.getTimezoneOffset()): PeakStatus {
  const sw = nextSwitch(now);
  return {
    isPeak: isPeakAt(now),
    msToSwitch: sw.at.getTime() - now.getTime(),
    nextIsPeak: sw.toPeak,
    localWindows: localWindowText(offsetMinutes),
    holidayNote: "中国法定节假日未计入（官方以 UTC 周一至周五为准）",
  };
}

/** 毫秒 → 「3h12m」/「42m」/「刚刚」倒计时文案 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "刚刚";
  const totalMinutes = Math.floor(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h <= 0) return `${Math.max(1, m)}m`;
  return `${h}h${String(m).padStart(2, "0")}m`;
}