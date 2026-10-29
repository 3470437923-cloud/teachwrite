/**
 * 冷读悬浮面板（D-045，2026-10-05 用户裁决）。
 *
 * 与旧冷读（会话式）的根本差别：
 *  - 无遮罩悬浮层：不挡编辑器，用户看着问题清单手改正文；
 *  - 可拖动（头部拖拽）、可最小化（收成一条标题栏）；
 *  - 问题按类别成行：勾选 / 定位跳转 / 删除 / 发送给 AI；
 *  - 退出即弃：面板状态全在内存，关窗不保留任何材料（oplog 由调用方留一行）。
 *
 * 行状态机：open →（发送）→ submitted（置灰「已提交」）→ AI 回合成功才从清单移除；
 * AI 失败/被中止则回到 open（问题不能悄悄消失）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  COLD_READ_CATEGORIES,
  COLD_READ_CHANNEL_LABEL,
  type ColdIssue,
  type ColdReadChannel,
} from "../core/ai/coldread";

/** 行条目 = 解析出的问题 + 界面状态 */
export interface ColdRow extends ColdIssue {
  checked: boolean;
  state: "open" | "submitted";
}

/** 面板的全部状态（由 MainWorkbench 持有与推进，本组件只渲染与回传动作） */
export interface ColdPanelState {
  /** 被审章节（定位与修复目标；rel 用于组装修复指令） */
  tabRel: string;
  chapterLabel: string;
  channel: ColdReadChannel;
  priorCount: 0 | 1 | 2;
  phase: "setup" | "running" | "done";
  rows: ColdRow[];
  leftover: string;
  noIssues: boolean;
  note: string;
  error: string | null;
  /** 审读中的流式原文（running 阶段展示，让用户看得到进度） */
  streaming: string;
  /** style 通道但盘上没有风格档案（setup 阶段提示，禁止开始） */
  styleMissing: boolean;
}

interface Props {
  state: ColdPanelState;
  onChannel: (c: ColdReadChannel) => void;
  onPrior: (n: 0 | 1 | 2) => void;
  onStart: () => void;
  onStop: () => void;
  onClose: () => void;
  onToggle: (id: string) => void;
  onDelete: (ids: string[]) => void;
  onSend: (ids: string[]) => void;
  onLocate: (quote: string) => void;
}

const PANEL_W = 432;

export default function ColdReadPanel({
  state,
  onChannel,
  onPrior,
  onStart,
  onStop,
  onClose,
  onToggle,
  onDelete,
  onSend,
  onLocate,
}: Props) {
  /** 面板位置（拖动）；初次挂载时取编辑器上方居中 */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [minimized, setMinimized] = useState(false);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (pos) return;
    setPos({
      x: Math.max(12, Math.round((window.innerWidth - PANEL_W) / 2)),
      y: 64,
    });
  }, [pos]);

  /* 流式输出自动跟到底部 */
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.streaming]);

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      if (!pos) return;
      // 只认左键；点在按钮上不算拖拽（按钮自己有点击语义）
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos],
  );
  const onDragMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({
      x: Math.min(Math.max(0, e.clientX - d.dx), window.innerWidth - 120),
      y: Math.min(Math.max(0, e.clientY - d.dy), window.innerHeight - 60),
    });
  }, []);
  const onDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  if (!pos) return null;

  const openRows = state.rows.filter((r) => r.state === "open");
  const checkedIds = openRows.filter((r) => r.checked).map((r) => r.id);
  const categories = COLD_READ_CATEGORIES[state.channel];
  /** 按类别分组展示（封闭集合顺序即展示顺序；「其他」永远在最后） */
  const grouped = categories
    .map((cat) => ({ cat, rows: state.rows.filter((r) => r.category === cat) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div
      className={minimized ? "cold-float mini surface-raised" : "cold-float surface-raised"}
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={`冷读 · ${state.chapterLabel}`}
    >
      <div
        className="cf-head"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        title="拖动移动面板"
      >
        <span className="cf-title">冷读 · {state.chapterLabel}</span>
        <span className="cf-channel">{COLD_READ_CHANNEL_LABEL[state.channel]}</span>
        <button
          className="cf-x"
          title={minimized ? "展开" : "最小化"}
          onClick={() => setMinimized((v) => !v)}
        >
          <svg viewBox="0 0 20 20" className="ic">
            {minimized ? <path d="M5 12l5-5 5 5" /> : <path d="M5 10h10" />}
          </svg>
        </button>
        <button className="cf-x" title="关闭（冷读材料不保留）" onClick={onClose}>
          <svg viewBox="0 0 20 20" className="ic">
            <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
          </svg>
        </button>
      </div>

      {minimized ? null : (
        <div className="cf-body">
          {state.phase === "setup" ? (
            <>
              <div className="qgroup">
                <div className="qg-label">审读通道（单次只选一个）</div>
                <div className="qopts-row">
                  {(["plot", "style"] as const).map((c) => (
                    <button
                      key={c}
                      className={state.channel === c ? "qopt on" : "qopt"}
                      onClick={() => onChannel(c)}
                    >
                      {COLD_READ_CHANNEL_LABEL[c]}
                    </button>
                  ))}
                </div>
                <div className="cf-hint">
                  {state.channel === "plot"
                    ? "完全冷：审读员没有大纲、设定与任何资料，只查连贯度与硬性 bug。"
                    : "半冷：审读员只拿到 06-写作风格.md 档案，逐段对照查风格不符。"}
                </div>
              </div>
              {state.channel === "plot" ? (
                <div className="qgroup">
                  <div className="qg-label">提供前文（取自已采用的正式正文）</div>
                  <div className="qopts-row">
                    {([0, 1, 2] as const).map((n) => (
                      <button
                        key={n}
                        className={state.priorCount === n ? "qopt on" : "qopt"}
                        onClick={() => onPrior(n)}
                      >
                        {n === 0 ? "无前文" : n === 1 ? "上一章" : "前两章"}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {state.channel === "style" && state.styleMissing ? (
                <div className="cf-error">这本书还没有 06-写作风格.md 档案，风格通道需要它。请先让 AI 建立风格档案，或改用剧情通道。</div>
              ) : null}
              <div className="qrow">
                <button
                  className="qsubmit btn btn-accent"
                  disabled={state.channel === "style" && state.styleMissing}
                  onClick={onStart}
                >
                  开始冷读
                </button>
                <button className="btn" onClick={onClose}>
                  取消
                </button>
              </div>
            </>
          ) : null}

          {state.phase === "running" ? (
            <>
              <div className="cf-running">正在审读（独立实例：零工具、零设定）…</div>
              <div className="cf-stream" ref={streamRef}>
                {state.streaming || "…"}
              </div>
              <div className="qrow">
                <button className="btn" onClick={onStop}>
                  停止
                </button>
              </div>
            </>
          ) : null}

          {state.phase === "done" ? (
            <>
              {state.error ? <div className="cf-error">{state.error}</div> : null}
              {state.noIssues ? (
                <div className="cf-clean">
                  <div className="cf-clean-h">未发现有依据的问题</div>
                  {state.note ? <div className="cf-clean-note">{state.note}</div> : null}
                </div>
              ) : null}
              {grouped.map((g) => (
                <div className="cf-group" key={g.cat}>
                  <div className="cf-group-h">
                    {g.cat}
                    <span className="cf-count">{g.rows.length}</span>
                  </div>
                  {g.rows.map((r) => (
                    <div
                      key={r.id}
                      className={
                        r.state === "submitted" ? "cf-row submitted" : r.checked ? "cf-row on" : "cf-row"
                      }
                    >
                      {r.state === "open" ? (
                        <input
                          type="checkbox"
                          className="cf-check"
                          checked={r.checked}
                          onChange={() => onToggle(r.id)}
                          aria-label="选中这条问题"
                        />
                      ) : (
                        <span className="cf-sent">已提交</span>
                      )}
                      <div className="cf-main">
                        <div className="cf-loc">
                          {r.location || "位置未标注"}
                          {r.quote ? <span className="cf-quote">「{r.quote}」</span> : null}
                        </div>
                        <div className="cf-problem">{r.problem}</div>
                        {r.basis ? <div className="cf-sub">依据：{r.basis}</div> : null}
                        {r.fix ? <div className="cf-sub">补足：{r.fix}</div> : null}
                      </div>
                      {r.state === "open" ? (
                        <div className="cf-acts">
                          {r.quote ? (
                            <button className="cf-act" title="在正文里定位这段引文" onClick={() => onLocate(r.quote)}>
                              定位
                            </button>
                          ) : null}
                          <button className="cf-act" title="把这条交给 AI 修改" onClick={() => onSend([r.id])}>
                            修复
                          </button>
                          <button className="cf-act danger" title="不是问题，删除" onClick={() => onDelete([r.id])}>
                            删除
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ))}
              {state.leftover ? (
                <details className="cf-leftover">
                  <summary>审读附言（未能成行条目的原文）</summary>
                  <div className="cf-leftover-body">{state.leftover}</div>
                </details>
              ) : null}
              {state.rows.length > 0 ? (
                <div className="cf-bulk">
                  <button
                    className="btn"
                    disabled={checkedIds.length === 0}
                    onClick={() => onSend(checkedIds)}
                    title="把勾选的问题交给 AI 修改（AI 回合成功才从清单移除）"
                  >
                    修复选中（{checkedIds.length}）
                  </button>
                  <button
                    className="btn"
                    disabled={checkedIds.length === 0}
                    onClick={() => onDelete(checkedIds)}
                  >
                    删除选中
                  </button>
                  <button className="btn" onClick={onClose}>
                    完成，关闭
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
