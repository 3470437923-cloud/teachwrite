/**
 * 用量信息面板（标题栏「用量」按键悬停/聚焦时展开；D-044 起入口是文字按键，不再是鲸鱼图形）。
 *
 * 四块内容与裁决依据（D-019 / D-020 / D-021）：
 *   1. 今日 token 汇总（输入 / 输出 / 缓存命中 / 未命中 + 命中率）——读 `usage_stats.json`；
 *   2. 本次会话累计（输入 / 输出 / 合计）——由主界面按会话维护，只存内存；
 *   3. 闲时 / 忙时倒计时（含本地时段与"节假日未计入"提醒）；
 *   4. 余额（DeepSeek 官方 `GET /user/balance`；非官方端点直接说明"该平台未提供余额接口"）。
 *
 * 纪律：**没有任何人民币用量估算**（D-020）。金额一律原样展示官方返回的字符串。
 * 统计与余额都是旁路：任何失败都只影响这一小块，不影响对话与写作。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppDirs } from "../core/dirs";
import { getFs } from "../core/fsbridge";
import { platformOfUrl, type Prefs, type ProviderPlatform } from "../core/prefs";
import { platformSupportsBalance } from "../core/ai/platforms";
import { fetchBalance, type BalanceInfo } from "../core/ai/balance";
import { loadUsageStats, recordBalance, recordError } from "../core/usage/persist";
import { peakStatus, type PeakStatus } from "../core/usage/peak";
import { ZERO_USAGE, todayTotals, type BalanceSnapshot, type UsageTotals } from "../core/usage/stats";
import {
  balanceSnapshot,
  balanceText,
  hitRateText,
  peakText,
  sessionRows,
  shouldRefreshBalance,
  snapshotText,
  todayRows,
} from "../core/usage/view";

interface Props {
  dirs: AppDirs | null;
  prefs: Prefs | null;
  /** 本次会话累计（主界面维护；未开始生成时为全零） */
  sessionUsage: UsageTotals;
}

/** 余额块的界面状态 */
type BalanceState =
  | { kind: "loading" }
  | { kind: "ok"; info: BalanceInfo }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }
  | { kind: "idle"; snapshot: BalanceSnapshot | null };

/** 余额上次拉取时刻（**模块级**，N-21）：面板随开随卸载，节流时间戳放在组件里
 *  会被卸载清零 ——「60 秒内重复打开不再请求上游」从未跨打开周期生效过。 */
let lastBalanceFetch = 0;

export default function UsagePanel({ dirs, prefs, sessionUsage }: Props) {
  const [today, setToday] = useState<UsageTotals>({ ...ZERO_USAGE });
  const [requests, setRequests] = useState(0);
  const [peak, setPeak] = useState<PeakStatus | null>(null);
  const [bal, setBal] = useState<BalanceState>({ kind: "idle", snapshot: null });

  /** 余额查询（force = 用户点「刷新」；否则走 60s 节流）——D-019 */
  const refreshBalance = useCallback(
    async (force: boolean) => {
      if (!prefs || !dirs) {
        setBal({ kind: "error", message: "未配置接口地址或 API Key" });
        return;
      }
      // 平台判定用**请求地址**（与思考参数同一口径）：非官方端点没有这个端点
      const platform: ProviderPlatform = platformOfUrl(prefs.llmBaseUrl);
      if (!platformSupportsBalance(platform)) {
        setBal({ kind: "unsupported" });
        return;
      }
      const now = Date.now();
      // 节流时间戳是模块级的（见 lastBalanceFetch 声明处注释）——跨打开周期生效
      if (!force && !shouldRefreshBalance(lastBalanceFetch, now)) return;
      lastBalanceFetch = now;
      setBal((cur) => (cur.kind === "ok" ? cur : { kind: "loading" }));
      try {
        const info = await fetchBalance(prefs.llmBaseUrl, prefs.apiKey);
        setBal({ kind: "ok", info });
        // 快照落盘（旁路：失败只当没缓存，不打扰用户）
        const snap = balanceSnapshot(info, new Date().toISOString());
        if (snap) {
          try {
            await recordBalance(getFs(), dirs.usageStatsFile, snap);
          } catch {
            /* 统计文件不可写：不影响展示 */
          }
        }
      } catch (e) {
        const message = String(e instanceof Error ? e.message : e);
        setBal({ kind: "error", message });
        try {
          await recordError(getFs(), dirs.usageStatsFile, { at: new Date().toISOString(), message });
        } catch {
          /* 同上 */
        }
      }
    },
    [prefs, dirs],
  );

  /** 重读统计文件的「今日」块（旁路：任何失败只影响这一小块） */
  const readToday = useCallback(async (): Promise<void> => {
    if (!dirs) return;
    try {
      const file = await loadUsageStats(getFs(), dirs.usageStatsFile);
      const day = todayTotals(file, new Date());
      setToday(day);
      setRequests(day.requests);
    } catch {
      /* 统计是旁路 */
    }
  }, [dirs]);

  /** 打开时读一次统计 + 闲忙时 + 余额（余额受节流约束） */
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (dirs) {
        try {
          const file = await loadUsageStats(getFs(), dirs.usageStatsFile);
          if (!alive) return;
          // todayTotals 返还当天的分桶（含 requests），跨零点后自然归零
          const day = todayTotals(file, new Date());
          setToday(day);
          setRequests(day.requests);
          setBal({ kind: "idle", snapshot: file.lastBalance });
        } catch {
          /* 统计是旁路 */
        }
      }
      if (!alive) return;
      void refreshBalance(false);
    })();
    return () => {
      alive = false;
    };
  }, [dirs, refreshBalance]);

  /** B12-8：本次会话累计一变（每轮生成结束）就重读统计 —— 旧实现只在"打开那一刻"读一次，
   *  面板钉住时「今日」永远停在打开时的数字，看着像统计坏了。 */
  useEffect(() => {
    void readToday();
  }, [readToday, sessionUsage]);

  /** B12-8：跨零点重读（面板钉住过夜时，「今日」不该继续显示前一天的数字）。
   *  每分钟核一次日期键，只有真的换天才读盘。 */
  useEffect(() => {
    if (!dirs) return;
    let dayKey = new Date().toDateString();
    const t = window.setInterval(() => {
      const now = new Date();
      if (now.toDateString() === dayKey) return;
      dayKey = now.toDateString();
      void readToday();
    }, 60_000);
    return () => window.clearInterval(t);
  }, [dirs, readToday]);

  /** 倒计时每秒刷新一次（只有面板开着才跑） */
  useEffect(() => {
    const tick = () => setPeak(peakStatus(new Date()));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, []);

  const peakLine = peak ? peakText(peak) : null;
  const balanceLine =
    bal.kind === "ok"
      ? balanceText(bal.info, "")
      : bal.kind === "unsupported"
        ? { main: "该平台未提供余额接口", sub: "只有 DeepSeek 官方直连可以查余额（GET /user/balance）" }
        : bal.kind === "error"
          ? { main: `余额查询失败：${bal.message}`, sub: "请检查接口地址与网络；也可稍后重试" }
          : bal.kind === "loading"
            ? { main: "正在查询余额…", sub: "" }
            : snapshotText(bal.snapshot);

  return (
    <div
      className="usage-pop surface-raised"
      role="dialog"
      aria-label="DeepSeek 用量与余额"
      // 面板自己吃掉指针事件：从「用量」按键移进来不能让浮层关掉
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="up-head">
        <span className="up-title">DeepSeek 用量</span>
        <button
          className="btn btn-quiet up-refresh"
          title="刷新余额（60 秒内重复打开不再请求上游）"
          disabled={bal.kind === "loading"}
          onClick={() => void refreshBalance(true)}
        >
          刷新余额
        </button>
      </div>

      <div className="up-block">
        <div className="up-block-head">
          <span className="up-block-title">今日</span>
          <span className="up-block-note">
            {requests > 0 ? `${requests} 次生成` : "统计只记 token（官方无按日账单接口）"}
          </span>
        </div>
        <div className="up-grid">
          {todayRows(today).map((r) => (
            <div className="up-cell" key={r.label}>
              <span className="up-cell-label">{r.label}</span>
              <span className="up-cell-value">{r.value}</span>
            </div>
          ))}
        </div>
        <div className="up-line">
          缓存命中率 <b>{hitRateText(today)}</b>
          <span className="up-hint">· 命中率高说明前缀没被改写，能省输入费用</span>
        </div>
      </div>

      <div className="up-block">
        <div className="up-block-head">
          <span className="up-block-title">本次会话累计</span>
          <span className="up-block-note">只存内存，换会话即清零</span>
        </div>
        <div className="up-grid up-grid-3">
          {sessionRows(sessionUsage).map((r) => (
            <div className="up-cell" key={r.label}>
              <span className="up-cell-label">{r.label}</span>
              <span className="up-cell-value">{r.value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="up-block">
        <div className="up-block-head">
          <span className="up-block-title">价格时段</span>
          {peakLine ? (
            <span className={peak?.isPeak ? "up-state busy" : "up-state idle"}>
              {peakLine.state} · {peakLine.countdown}
            </span>
          ) : null}
        </div>
        {peakLine ? (
          <>
            <div className="up-line up-mono">{peakLine.windows}</div>
            <div className="up-line up-hint">{peakLine.note}</div>
          </>
        ) : null}
      </div>

      <div className="up-block">
        <div className="up-block-head">
          <span className="up-block-title">余额</span>
          <span className="up-block-note">
            {bal.kind === "ok" ? "官方实时值" : bal.kind === "unsupported" ? "不适用" : "缓存/实时"}
          </span>
        </div>
        <div className="up-balance">{balanceLine.main}</div>
        {balanceLine.sub ? <div className="up-line up-hint">{balanceLine.sub}</div> : null}
      </div>

      <div className="up-foot">
        <div className="up-line up-hint">统计只记 token，金额一律是官方返回原文；统计文件可随时删除，不影响作品与配置。</div>
      </div>
    </div>
  );
}