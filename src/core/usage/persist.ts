/**
 * token 统计的读写（唯一落盘入口）。
 *
 * 落点：`%APPDATA%\com.writerd\writerD\usage_stats.json`（与 shared_preferences.json、
 * window_state.json 同目录；**additive 契约**，见 README 契约表与 DECISIONS D-023）。
 *
 * 纪律：统计是**旁路**——任何读写失败都不允许影响对话主流程，因此这里只抛 I/O 错误，
 * 由调用方决定吞掉（controller 已 try/catch）。文件损坏按「空统计」处理，不试图"修复"。
 */

import type { FsBridge } from "../fsbridge";
import {
  emptyUsageStats,
  parseUsageStats,
  pruneDays,
  recordRun,
  serializeUsageStats,
  withBalance,
  withError,
  USAGE_DAY_KEEP,
  type BalanceSnapshot,
  type UsageNote,
  type UsageStatsFile,
  type UsageTotals,
} from "./stats";

/** 读取统计文件；不存在或损坏一律返回空统计 */
export async function loadUsageStats(fs: FsBridge, file: string): Promise<UsageStatsFile> {
  try {
    if (!(await fs.exists(file))) return emptyUsageStats();
    return parseUsageStats(await fs.readText(file));
  } catch {
    return emptyUsageStats();
  }
}

/** 写出统计文件（父目录由 fs 桥自动创建） */
export async function saveUsageStats(fs: FsBridge, file: string, stats: UsageStatsFile): Promise<void> {
  await fs.writeText(file, serializeUsageStats(stats));
}

/**
 * 进程内串行队列（与 snapshot/session 同一手法）：三条 record* 都是
 * 「读 → 改 → 写」整条链，不串行的话并发更新互相整文件覆盖 ——
 * 生成结束落 token 与用量面板刷新余额时间重叠时，后写者盖掉先写者，
 * 丢一日统计或丢余额快照。前序失败不阻塞后续；各调用方仍拿到自己的错误。
 */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

/** 记一次运行并落盘：读 → 按日累加 → 裁剪 90 天 → 写（经串行队列） */
export function recordUsage(
  fs: FsBridge,
  file: string,
  delta: UsageTotals,
  when: Date = new Date(),
): Promise<UsageStatsFile> {
  return enqueue(async () => {
    const current = await loadUsageStats(fs, file);
    const next = pruneDays(recordRun(current, when, delta), USAGE_DAY_KEEP);
    await saveUsageStats(fs, file, next);
    return next;
  });
}

/** 缓存一次余额快照（面板展示；不做任何金额推算；经串行队列） */
export function recordBalance(fs: FsBridge, file: string, snapshot: BalanceSnapshot): Promise<UsageStatsFile> {
  return enqueue(async () => {
    const current = await loadUsageStats(fs, file);
    const next = withBalance(current, snapshot);
    await saveUsageStats(fs, file, next);
    return next;
  });
}

/** 记一次错误（诊断用；面板异常态读取；经串行队列） */
export function recordError(fs: FsBridge, file: string, note: UsageNote): Promise<UsageStatsFile> {
  return enqueue(async () => {
    const current = await loadUsageStats(fs, file);
    const next = withError(current, note);
    await saveUsageStats(fs, file, next);
    return next;
  });
}