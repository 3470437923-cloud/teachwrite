/**
 * 流式增量合批(B19 崩溃根因修复)。
 *
 * 症状:用快捷提示词跑长任务(novel-writer 写整章)时界面偶发崩溃/无响应。
 * 实测依据(预览沙箱 CDP 探针 tools/_qp_stress_probe.py):历史堆到 35 条消息 +
 * 25 行工具后,下一次流式发送中出现 51ms 长任务、13 帧 >33ms;而真实最大会话是
 * 108 条消息 / 171 个工具调用 / 单会话 120K 字符思考流(见 docs/KNOWN-LIMITS.md KL-PF-01)。
 *
 * 原因:agent 的每个 delta 都调一次 setState,于是**每个 token 重渲染整棵工作台**
 * (全部历史消息 + 每条思考块 + 每条工具行都要重新 diff),同时 t => t + delta
 * 每 token 复制一遍已流出的全文 —— O(n²) 字符串分配。合批后渲染次数与复制次数
 * 从「每 token」降到「每帧」。
 *
 * 核心是纯类 StreamCoalescer(调度器可注入,单测不需要浏览器),
 * useStreamBatcher 只是把它接到 React 的 rAF 与 state 上。
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

export type CoalescerSchedule = (run: () => void) => void;

/**
 * 把高频增量合并成每「帧」一次的批量交付。
 * 契约:
 *  - push(chunk):空串忽略;非空进缓冲,并(若本帧尚未排程)排一次交付。
 *  - flush():立刻交付当前缓冲(回合边界/报错前用,已流出的内容必须可见)。
 *  - drop():丢弃缓冲并取消排程(调用方即将清空/替换 state 时用,
 *    否则残量会在清空后被追加回去)。
 *  - apply 抛错不吞(那是业务 bug,应当被上层看到)。
 */
export class StreamCoalescer {
  private buf = "";
  private scheduled = false;
  private dead = false;

  constructor(
    private apply: (merged: string) => void,
    private schedule: CoalescerSchedule,
  ) {}

  push(chunk: string): void {
    if (this.dead || chunk === "") return;
    this.buf += chunk;
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.deliver();
    });
  }

  flush(): void {
    this.scheduled = false; // 排程照常跑,但届时缓冲已空,deliver 自然跳过
    this.deliver();
  }

  drop(): void {
    this.buf = "";
    this.scheduled = false;
  }

  /** 永久停用(组件卸载):之后的 push 全部忽略,不再触碰 state */
  dispose(): void {
    this.dead = true;
    this.buf = "";
    this.scheduled = false;
  }

  private deliver(): void {
    if (this.dead) return;
    const merged = this.buf;
    this.buf = "";
    if (merged !== "") this.apply(merged);
  }
}

export interface StreamBatcher {
  push: (chunk: string) => void;
  flush: () => void;
  drop: () => void;
}

/**
 * React 接线:一个实例对应一路流(正文/思考/冷读各一个)。
 * apply 只允许是纯 setState 类回调 —— 它会被合批后的每个帧调用一次。
 */
export function useStreamBatcher(apply: (merged: string) => void): StreamBatcher {
  // 用 ref 透传最新 apply,coalescer 本体与三个回调全程引用稳定
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const coalescerRef = useRef<StreamCoalescer | null>(null);
  if (coalescerRef.current === null) {
    coalescerRef.current = new StreamCoalescer(
      (merged) => applyRef.current(merged),
      (run) => requestAnimationFrame(run),
    );
  }
  const coalescer = coalescerRef.current;

  const push = useCallback((chunk: string) => coalescer.push(chunk), [coalescer]);
  const flush = useCallback(() => coalescer.flush(), [coalescer]);
  const drop = useCallback(() => coalescer.drop(), [coalescer]);

  useEffect(() => {
    return () => coalescer.dispose();
  }, [coalescer]);

  // 返回值也必须稳定:每次渲染新建对象的话,调用方写进 useCallback/useMemo 依赖
  // 就等于每渲染一次重建一次回调 —— 本 hook 的目的正是减少重渲染,不能自己拆台。
  return useMemo(() => ({ push, flush, drop }), [push, flush, drop]);
}
