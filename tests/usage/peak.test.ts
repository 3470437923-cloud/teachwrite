/**
 * 闲时 / 忙时判定：官方 UTC 窗口（周一至周五 01:00–04:00、06:00–10:00）。
 * 参考星期：2026-01-01 是周四 → 01-02 周五、01-03 周六、01-04 周日、01-05 周一。
 */
import { describe, expect, it } from "vitest";
import {
  PEAK_WINDOWS,
  formatCountdown,
  isPeakAt,
  localWindowText,
  nextSwitch,
  peakStatus,
} from "../../src/core/usage/peak";

/** UTC 时刻构造（月为 0 基） */
function utc(day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 0, day, hour, minute, 0, 0));
}

describe("峰值窗口判定", () => {
  it("窗口定义与官方文档一致（左闭右开）", () => {
    expect(PEAK_WINDOWS).toEqual([
      [1, 4],
      [6, 10],
    ]);
  });

  it("工作日窗口内为峰值，窗口边界外不是", () => {
    expect(isPeakAt(utc(5, 2))).toBe(true); // 周一 02:00
    expect(isPeakAt(utc(5, 6))).toBe(true); // 周一 06:00
    expect(isPeakAt(utc(5, 0, 30))).toBe(false);
    expect(isPeakAt(utc(5, 4))).toBe(false); // 04:00 已出窗口
    expect(isPeakAt(utc(5, 10))).toBe(false);
    expect(isPeakAt(utc(5, 12))).toBe(false);
    expect(isPeakAt(utc(2, 2))).toBe(true); // 周五 02:00
  });

  it("周末整天都不是峰值（含窗口时段）", () => {
    expect(isPeakAt(utc(3, 2))).toBe(false); // 周六
    expect(isPeakAt(utc(3, 8))).toBe(false);
    expect(isPeakAt(utc(4, 2))).toBe(false); // 周日
    expect(isPeakAt(utc(4, 8))).toBe(false);
  });
});

describe("下一次切换", () => {
  it("峰中转闲：01:00 起峰，下一次切换是 04:00", () => {
    const sw = nextSwitch(utc(5, 2));
    expect(sw.at.toISOString()).toBe(utc(5, 4).toISOString());
    expect(sw.toPeak).toBe(false);
  });

  it("闲中转峰：从周五 11:00 跳到下周一 01:00（跳过周末的所有边界）", () => {
    const sw = nextSwitch(utc(2, 11));
    expect(sw.at.toISOString()).toBe(utc(5, 1).toISOString());
    expect(sw.toPeak).toBe(true);
  });

  it("周末中段同样指向周一 01:00", () => {
    const sw = nextSwitch(utc(4, 12));
    expect(sw.at.toISOString()).toBe(utc(5, 1).toISOString());
    expect(sw.toPeak).toBe(true);
  });

  it("恰好在边界时刻时不再返回该边界本身", () => {
    const sw = nextSwitch(utc(5, 1));
    expect(sw.at.toISOString()).toBe(utc(5, 4).toISOString());
  });
});

describe("面板状态", () => {
  it("东八区窗口文案 = 周一至周五 09:00–12:00、14:00–18:00", () => {
    expect(localWindowText(480)).toBe("周一至周五 09:00–12:00、14:00–18:00");
  });

  it("UTC 窗口文案逐字对应官方规则", () => {
    expect(localWindowText(0)).toBe("周一至周五 01:00–04:00、06:00–10:00");
  });

  it("跨零点的时区会标注（UTC-8 的第二窗口落在 22:00–02:00）", () => {
    const text = localWindowText(-480);
    expect(text).toContain("22:00–02:00（跨零点）");
  });

  it("peakStatus 带上倒计时、换算文案与节假日口径提醒（D-021）", () => {
    const st = peakStatus(utc(5, 2), 480);
    expect(st.isPeak).toBe(true);
    expect(st.nextIsPeak).toBe(false);
    expect(st.msToSwitch).toBe(2 * 60 * 60 * 1000);
    expect(st.localWindows).toBe("周一至周五 09:00–12:00、14:00–18:00");
    expect(st.holidayNote).toContain("节假日");
  });

  it("formatCountdown 文案", () => {
    expect(formatCountdown(0)).toBe("刚刚");
    expect(formatCountdown(-5)).toBe("刚刚");
    expect(formatCountdown(25 * 60_000)).toBe("25m");
    expect(formatCountdown((3 * 60 + 12) * 60_000)).toBe("3h12m");
  });
});