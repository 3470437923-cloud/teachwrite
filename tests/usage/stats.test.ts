/**
 * token 统计数据模型：按日分桶、容错解析、裁剪、缓存命中率。
 * 时区显式传参（offsetMinutes），保证与跑测机器时区无关。
 */
import { describe, expect, it } from "vitest";
import {
  USAGE_DAY_KEEP,
  ZERO_USAGE,
  addTotals,
  cacheHitRate,
  dayKey,
  emptyUsageStats,
  parseUsageStats,
  pruneDays,
  recordRun,
  serializeUsageStats,
  todayTotals,
  withBalance,
  withError,
  type UsageStatsFile,
} from "../../src/core/usage/stats";

const USAGE = { inputTokens: 100, outputTokens: 20, cacheHitTokens: 60, cacheMissTokens: 40 };

describe("按日分桶", () => {
  it("dayKey 按本地偏移换算（东八区跨零点归到次日）", () => {
    // 2026-01-05 16:30 UTC = 东八区 2026-01-06 00:30
    const t = new Date(Date.UTC(2026, 0, 5, 16, 30));
    expect(dayKey(t, 480)).toBe("2026-01-06");
    expect(dayKey(t, 0)).toBe("2026-01-05");
  });

  it("recordRun 累加 token 与运行次数，且不改入参", () => {
    const when = new Date(Date.UTC(2026, 0, 5, 12, 0));
    const f0 = emptyUsageStats();
    const f1 = recordRun(f0, when, USAGE, 0);
    const f2 = recordRun(f1, when, USAGE, 0);
    expect(Object.keys(f0.days)).toHaveLength(0); // 纯函数：原对象不变
    expect(f2.days["2026-01-05"]).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      cacheHitTokens: 120,
      cacheMissTokens: 80,
      requests: 2,
    });
  });

  it("todayTotals 对没有记录的日期返回全零（调用方无需兜底 undefined）", () => {
    const f = emptyUsageStats();
    expect(todayTotals(f, new Date(Date.UTC(2026, 0, 5, 12, 0)), 0)).toEqual({ ...ZERO_USAGE, requests: 0 });
  });

  it("addTotals 逐字段相加", () => {
    expect(addTotals(ZERO_USAGE, USAGE)).toEqual(USAGE);
  });
});

describe("缓存命中率", () => {
  it("没有缓存数据时返回 null（面板据此显示「无缓存数据」而不是 0%）", () => {
    expect(cacheHitRate(ZERO_USAGE)).toBeNull();
    expect(cacheHitRate({ ...ZERO_USAGE, inputTokens: 999 })).toBeNull();
  });

  it("有数据时返回 0–1 的比例", () => {
    expect(cacheHitRate({ ...ZERO_USAGE, cacheHitTokens: 75, cacheMissTokens: 25 })).toBeCloseTo(0.75, 5);
    expect(cacheHitRate({ ...ZERO_USAGE, cacheHitTokens: 0, cacheMissTokens: 10 })).toBe(0);
  });
});

describe("裁剪与快照", () => {
  it("pruneDays 只留最近 keep 天（键字符串排序即时间序）", () => {
    const days: UsageStatsFile["days"] = {};
    for (const d of ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]) {
      days[d] = { ...ZERO_USAGE, requests: 1 };
    }
    const pruned = pruneDays({ ...emptyUsageStats(), days }, 3);
    expect(Object.keys(pruned.days).sort()).toEqual(["2026-01-03", "2026-01-04", "2026-01-05"]);
  });

  it("保留天数上限是 90 天", () => {
    expect(USAGE_DAY_KEEP).toBe(90);
  });

  it("withBalance / withError 覆盖对应字段", () => {
    const f = withBalance(emptyUsageStats(), {
      at: "2026-01-05T12:00:00.000Z",
      isAvailable: true,
      currency: "CNY",
      total: "42.18",
      granted: "0.00",
      toppedUp: "42.18",
    });
    const g = withError(f, { at: "2026-01-05T12:01:00.000Z", message: "HTTP 402: Insufficient Balance" });
    expect(g.lastBalance?.total).toBe("42.18");
    expect(g.lastError?.message).toContain("402");
  });
});

describe("解析容错", () => {
  it("空串 / 坏 JSON / 非对象一律回落空统计，不抛", () => {
    expect(parseUsageStats("")).toEqual(emptyUsageStats());
    expect(parseUsageStats("{坏")).toEqual(emptyUsageStats());
    expect(parseUsageStats("[]")).toEqual(emptyUsageStats());
  });

  it("带 BOM 的文件仍能解析", () => {
    const text = "\uFEFF" + JSON.stringify({ days: { "2026-01-05": { ...USAGE, requests: 1 } } });
    expect(parseUsageStats(text).days["2026-01-05"].inputTokens).toBe(100);
  });

  it("非法日期键、非法数值、坏元素被丢弃或归零", () => {
    const text = JSON.stringify({
      days: {
        "not-a-date": { inputTokens: 5, requests: 1 },
        "2026-01-05": { inputTokens: -3, outputTokens: 1.7, cacheHitTokens: "x", requests: null },
      },
    });
    const f = parseUsageStats(text);
    expect(Object.keys(f.days)).toEqual(["2026-01-05"]);
    expect(f.days["2026-01-05"]).toEqual({
      inputTokens: 0, // 负数非法 → 0
      outputTokens: 1, // 小数向下取整
      cacheHitTokens: 0, // 非数字 → 0
      cacheMissTokens: 0,
      requests: 0,
    });
  });

  it("序列化 → 解析 往返一致（单行 JSON）", () => {
    const when = new Date(Date.UTC(2026, 0, 5, 12, 0));
    const f = recordRun(emptyUsageStats(), when, USAGE, 0);
    const text = serializeUsageStats(f);
    expect(text).not.toContain("\n");
    expect(parseUsageStats(text)).toEqual(f);
  });
});