/**
 * 标题栏用量入口（文字按键「用量」+ 用量面板）。
 *
 * 形态（D-044，2026-10-05 用户裁决）：不再是吉祥物图形——自绘鲸鱼 SVG 撤下，
 * 换成与标题栏其他控件同款的文字按键，位置从"走廊中点"挪进 `.win-tools`
 * （设置齿轮左侧）。走廊（`.whale-lane`）随之删除。
 * `whale_idle_pause` 配置键按封闭键集合纪律保留往返（prefs.ts），早已没有 UI。
 *
 * 交互契约（与鲸鱼时代完全一致，D-031② 的教训仍在）：
 *  - 悬停：120ms 后展开面板；离开后 250ms 才收起（悬停意图，避免穿过标题栏时误弹）；
 *  - 键盘：按键是 `<button>`，聚焦即展开（无延迟），Tab 离开即收起，Esc 关闭；
 *  - 标题栏的拖拽/双击最大化处理器都已排除 `button`，不会误触窗口拖动。
 *
 * 展开状态是三来源的并集（hoverOpen / pinned / focusOpen），不是单布尔取反——
 * 早先"单 open + 点击取反"会让 focus 展开、紧随的 click 又把它关掉，点按键什么都不弹。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { AppDirs } from "../core/dirs";
import type { Prefs } from "../core/prefs";
import type { UsageTotals } from "../core/usage/stats";
import UsagePanel from "./UsagePanel";

interface Props {
  dirs: AppDirs | null;
  prefs: Prefs | null;
  sessionUsage: UsageTotals;
}

/** 悬停意图延时：进 120ms / 出 250ms */
const OPEN_DELAY = 120;
const CLOSE_DELAY = 250;
/** 面板宽度（与 CSS `.usage-pop` 保持一致；只用于计算是否需要向左让位） */
const PANEL_W = 344;

export default function TitlebarUsage({ dirs, prefs, sessionUsage }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  /** 面板相对按键位置的偏移 + 右缘让位量（都在展开那一刻按实际矩形算） */
  const [panelLeft, setPanelLeft] = useState(0);
  const [shift, setShift] = useState(0);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const open = hoverOpen || pinned || focusOpen;
  const openTimer = useRef(0);
  const closeTimer = useRef(0);
  /** open 的 ref 镜像：ResizeObserver 回调里读"此刻是否展开"（见下方 anchor effect） */
  const openRef = useRef(false);
  openRef.current = open;

  /** 面板展开期间布局变化（开合面板、改窗口宽）→ 面板锚点跟着重算，不与按键脱开 */
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (openRef.current) measureAnchor();
    });
    ro.observe(document.body);
    return () => ro.disconnect();
    // measureAnchor 是 useCallback([])，不会造成 observer 反复重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(openTimer.current);
  }, []);

  const scheduleClose = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setHoverOpen(false), CLOSE_DELAY);
  }, []);

  /** 展开前按按键当前位置定位面板：先摆在它正下方，再按需向左让位避免越出窗口 */
  const measureAnchor = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    const wrapRect = wrapRef.current?.getBoundingClientRect();
    if (!rect || !wrapRect) return;
    setPanelLeft(Math.round(rect.left - wrapRect.left));
    const overflow = rect.left + PANEL_W - (window.innerWidth - 14);
    setShift(overflow > 0 ? -Math.round(overflow) : 0);
  }, []);

  const onEnter = useCallback(() => {
    cancelClose();
    openTimer.current = window.setTimeout(() => {
      measureAnchor();
      setHoverOpen(true);
    }, OPEN_DELAY);
  }, [cancelClose, measureAnchor]);

  const onLeave = useCallback(() => {
    scheduleClose();
  }, [scheduleClose]);

  /** 点一下钉住/取消钉住；取消时连悬停预览一起收掉（否则指针还在上面，看着像"点了没反应"） */
  const onTogglePin = useCallback(() => {
    cancelClose();
    measureAnchor();
    if (pinned) {
      setPinned(false);
      setHoverOpen(false);
    } else {
      setPinned(true);
    }
  }, [pinned, cancelClose, measureAnchor]);

  /** 收起（Esc / 焦点离开）：三个来源一起清 */
  const closeAll = useCallback(() => {
    cancelClose();
    setHoverOpen(false);
    setPinned(false);
    setFocusOpen(false);
  }, [cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  /**
   * 让位校正：上面的 `measureAnchor` 是"预测"（rect.left + 面板宽度），
   * 预测会受圆角、缩放、字体度量影响；面板真挂上去之后按它的**真实矩形**再修一次，
   * 保证左右两边都不越出窗口。layout effect 里改，用户看不到中间态。
   */
  useLayoutEffect(() => {
    if (!open) return;
    const pop = wrapRef.current?.querySelector<HTMLElement>(".usage-pop");
    if (!pop) return;
    const r = pop.getBoundingClientRect();
    const overRight = r.right - (window.innerWidth - 12);
    const overLeft = 12 - r.left;
    if (overRight > 0) setShift((s) => s - Math.round(overRight));
    else if (overLeft > 0) setShift((s) => s + Math.round(overLeft));
  }, [open]);

  return (
    <div
      className="usage-wrap"
      ref={wrapRef}
      style={{ "--panel-left": `${panelLeft}px`, "--usage-shift": `${shift}px` } as CSSProperties}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={(e) => {
        // 鼠标点击也会触发 focus；那种情况交给 hover/click（`pinned`）逻辑，
        // 只有键盘聚焦（:focus-visible）才在这里直接展开
        if (!(e.target as HTMLElement).matches(":focus-visible")) return;
        cancelClose();
        measureAnchor();
        setFocusOpen(true);
      }}
      onBlur={(e) => {
        // 焦点离开整个按键+面板区域才收起（面板内部的 Tab 不算离开）
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) setFocusOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          closeAll();
        }
      }}
    >
      <button
        ref={btnRef}
        className="usage-entry"
        title="用量与余额（悬停预览，点一下钉住）"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onTogglePin}
      >
        用量
      </button>

      {open ? <UsagePanel dirs={dirs} prefs={prefs} sessionUsage={sessionUsage} /> : null}
    </div>
  );
}
