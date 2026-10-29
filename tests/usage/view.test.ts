/**
 * 用量面板的展示口径（纯函数）。
 *
 * 这些断言的共同点是"不造数"：token 只做千分位、金额一律原样展示官方字符串、
 * 没有缓存数据时不显示 0% 而显示「无缓存数据」（D-020 / KL-AI-02 的口径）。
 */
import { describe, expect, it } from "vitest";
import {
  BALANCE_THROTTLE_MS,
  IDLE_AFTER_MS,
  balanceSnapshot,
  balanceText,
  formatTokens,
  hitRateText,
  isIdle,
  peakText,
  sessionRows,
  shouldRefreshBalance,
  snapshotText,
  todayRows,
} from "../../src/core/usage/view";
import { ZERO_USAGE, type UsageTotals } from "../../src/core/usage/stats";
import { peakStatus } from "../../src/core/usage/peak";
import type { BalanceInfo } from "../../src/core/ai/balance";

const T: UsageTotals = {
  inputTokens: 128_400,
  outputTokens: 43_260,
  cacheHitTokens: 102_400,
  cacheMissTokens: 26_000,
};

describe("token 展示", () => {
  it("千分位，且负数/非数一律夹到 0（不显示 -1,200 这种）", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1,000");
    expect(formatTokens(128_400)).toBe("128,400");
    expect(formatTokens(1_234_567_890)).toBe("1,234,567,890");
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(12.7)).toBe("12");
  });

  it("今日四行固定顺序：输入 / 输出 / 缓存命中 / 未命中", () => {
    expect(todayRows(T).map((r) => r.label)).toEqual(["输入", "输出", "缓存命中", "缓存未命中"]);
    expect(todayRows(T).map((r) => r.value)).toEqual(["128,400", "43,260", "102,400", "26,000"]);
  });

  it("会话三行：输入 / 输出 / 合计（合计是加出来的，不是又取了一次上游）", () => {
    const rows = sessionRows(T);
    expect(rows.map((r) => r.label)).toEqual(["输入", "输出", "合计"]);
    expect(rows[2].value).toBe(formatTokens(T.inputTokens + T.outputTokens));
  });

  it("缓存命中率：有缓存数据才算，全零时是「无缓存数据」而不是 0%", () => {
    // 102400 / (102400 + 26000) = 79.75% → 79.8%
    expect(hitRateText(T)).toBe("79.8%");
    expect(hitRateText(ZERO_USAGE)).toBe("无缓存数据");
    // 只有未命中（首次请求）时命中率是 0.0%，这是**有数据**的 0
    expect(hitRateText({ ...ZERO_USAGE, inputTokens: 100, cacheMissTokens: 100 })).toBe("0.0%");
  });
});

describe("闲忙时文案", () => {
  it("峰时/闲时 + 下次切换 + 本地窗口 + 节假日口径提醒", () => {
    // 2026-01-05 周一 02:00 UTC → 峰值窗口内
    const peak = peakText(peakStatus(new Date(Date.UTC(2026, 0, 5, 2, 0, 0)), 480));
    expect(peak.state).toBe("忙时");
    expect(peak.countdown).toContain("转闲时");
    expect(peak.windows).toContain("09:00–12:00");
    expect(peak.note).toContain("节假日未计入");

    const idle = peakText(peakStatus(new Date(Date.UTC(2026, 0, 5, 12, 0, 0)), 480));
    expect(idle.state).toBe("闲时");
    expect(idle.countdown).toContain("转忙时");
  });
});

describe("余额文案（金额不换算、不四舍五入）", () => {
  const INFO: BalanceInfo = {
    isAvailable: true,
    balances: [
      { currency: "CNY", totalBalance: "42.18", grantedBalance: "0.00", toppedUpBalance: "42.18" },
    ],
  };

  it("正常响应：主行是币种+总额，副行是赠送/充值拆分与可用状态", () => {
    const t = balanceText(INFO, "");
    expect(t.main).toBe("CNY 42.18");
    expect(t.sub).toBe("赠送 0.00 · 充值 42.18 · 账户可用");
  });

  it("多币种只展示第一个并注明还有几个（不做汇率换算）", () => {
    const two: BalanceInfo = {
      isAvailable: true,
      balances: [...INFO.balances, { currency: "USD", totalBalance: "1.00", grantedBalance: "0", toppedUpBalance: "1.00" }],
    };
    expect(balanceText(two, "").main).toBe("CNY 42.18（另有 1 个币种）");
  });

  it("余额不足时副行说「余额不足」，但金额照旧原样展示", () => {
    expect(balanceText({ ...INFO, isAvailable: false }, "").sub).toContain("余额不足");
    expect(balanceText({ isAvailable: true, balances: [] }, "").main).toBe("官方未返回余额明细");
  });

  it("没有响应时展示调用方给的原因（未配置 / 非官方平台 / 失败）", () => {
    expect(balanceText(null, "该平台未提供余额接口").main).toBe("该平台未提供余额接口");
    expect(balanceText(null, "余额查询失败：连接超时").sub).toBe("");
  });

  it("落盘快照：只取第一个币种，且没有明细时返回 null（不写一个空快照）", () => {
    const snap = balanceSnapshot(INFO, "2026-01-05T02:00:00.000Z");
    expect(snap).toEqual({
      at: "2026-01-05T02:00:00.000Z",
      isAvailable: true,
      currency: "CNY",
      total: "42.18",
      granted: "0.00",
      toppedUp: "42.18",
    });
    expect(balanceSnapshot({ isAvailable: true, balances: [] }, "t")).toBeNull();
  });

  it("快照文案注明时间：缓存值不许被读成实时值", () => {
    const t = snapshotText(balanceSnapshot(INFO, "2026-01-05T02:00:00.000Z"));
    expect(t.main).toBe("CNY 42.18");
    expect(t.sub).toContain("2026-01-05 02:00");
    expect(snapshotText(null).main).toBe("尚未查询过余额");
  });
});

describe("刷新节流与闲置判定", () => {
  it("60 秒内重复打开面板不再打上游，手动刷新走 force 分支", () => {
    expect(shouldRefreshBalance(0, 1_000_000)).toBe(true);
    const at = 1_000_000;
    expect(shouldRefreshBalance(at, at + BALANCE_THROTTLE_MS - 1)).toBe(false);
    expect(shouldRefreshBalance(at, at + BALANCE_THROTTLE_MS)).toBe(true);
  });

  it("闲置 = 距上次活动满 45 秒（lastActivity 为 0 表示从未记录 → 不算闲置）", () => {
    const now = 1_000_000;
    expect(isIdle(now - 44_999, now)).toBe(false);
    expect(isIdle(now - IDLE_AFTER_MS, now)).toBe(true);
    expect(isIdle(0, now)).toBe(false);
    // 阈值可显式传（单测不依赖具体常量）
    expect(isIdle(now - 100, now, 50)).toBe(true);
  });
});