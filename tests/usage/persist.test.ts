/**
 * token 统计落盘：读 / 写 / 记运行 / 记余额 / 记错误。
 * 用 node 实现的文件桥（tests/support/nodeFs.ts），全程不碰 Tauri。
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeFs } from "../support/nodeFs";
import {
  loadUsageStats,
  recordBalance,
  recordError,
  recordUsage,
  saveUsageStats,
} from "../../src/core/usage/persist";
import { todayTotals } from "../../src/core/usage/stats";

const fs = createNodeFs();
let dir: string;
let file: string;

/** 本地正午时刻：无论跑测机器在哪个时区，本地日期都稳定 */
function localNoon(day: number): Date {
  return new Date(2026, 0, day, 12, 0, 0, 0);
}

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "deepcompose-usage-"));
  file = path.join(dir, "usage_stats.json");
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("读写与记账", () => {
  it("文件不存在时读出空统计", async () => {
    const f = await loadUsageStats(fs, file);
    expect(f.days).toEqual({});
    expect(f.lastBalance).toBeNull();
  });

  it("recordUsage 落盘并可读回（按本地日期分桶、累加运行次数）", async () => {
    const delta = { inputTokens: 120, outputTokens: 30, cacheHitTokens: 90, cacheMissTokens: 30 };
    await recordUsage(fs, file, delta, localNoon(5));
    const after = await recordUsage(fs, file, delta, localNoon(5));

    const day = todayTotals(after, localNoon(5));
    expect(day.inputTokens).toBe(240);
    expect(day.outputTokens).toBe(60);
    expect(day.cacheHitTokens).toBe(180);
    expect(day.requests).toBe(2);

    // 真落盘：重新从磁盘读回，内容一致
    const reread = await loadUsageStats(fs, file);
    expect(reread).toEqual(after);
  });

  it("不同日期分到不同桶", async () => {
    const delta = { inputTokens: 5, outputTokens: 1, cacheHitTokens: 0, cacheMissTokens: 0 };
    const f = await recordUsage(fs, file, delta, localNoon(6));
    expect(Object.keys(f.days).length).toBeGreaterThanOrEqual(2);
  });

  it("recordBalance / recordError 覆盖最近值且不影响 token 桶", async () => {
    const before = await loadUsageStats(fs, file);
    const withBal = await recordBalance(fs, file, {
      at: "2026-01-05T12:00:00.000Z",
      isAvailable: true,
      currency: "CNY",
      total: "7.77",
      granted: "0.00",
      toppedUp: "7.77",
    });
    expect(withBal.lastBalance?.total).toBe("7.77");
    expect(withBal.days).toEqual(before.days);

    const withErr = await recordError(fs, file, {
      at: "2026-01-05T12:05:00.000Z",
      message: "HTTP 429: Rate Limit Reached",
    });
    expect(withErr.lastError?.message).toContain("429");
    expect(withErr.lastBalance?.total).toBe("7.77");
  });

  it("统计文件损坏时不抛，按空统计继续记账（旁路职责）", async () => {
    await fsp.writeFile(file, "{这不是 JSON", "utf8");
    const f = await loadUsageStats(fs, file);
    expect(f.days).toEqual({});
    const next = await recordUsage(
      fs,
      file,
      { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0, cacheMissTokens: 0 },
      localNoon(7),
    );
    expect(next.days).not.toEqual({});
  });

  it("saveUsageStats 对不存在的父目录也能写（fs 桥自动建目录）", async () => {
    const deep = path.join(dir, "a", "b", "usage_stats.json");
    await saveUsageStats(fs, deep, await loadUsageStats(fs, file));
    expect(await fs.exists(deep)).toBe(true);
  });
});