/**
 * 模态焦点管理（Dialogs.tsx 与 MemoModal.tsx 共用）。
 *
 * 只做三件事，但这三件都是键盘用户真正会撞到的问题：
 *   1. 打开时把焦点移进面板（否则它还在触发按钮上，从此 Tab 一路
 *      走进遮罩背后的主界面 —— 视觉上"弹了个框"，键盘上什么也没变）；
 *   2. Tab / Shift+Tab 在面板内循环（模态之外的东西不该被 Tab 到）；
 *   3. 关闭时把焦点还给打开前的那个元素（不还的话焦点掉回文档开头，
 *      连续操作的人每次都得重新摸一遍）。
 *
 * 叠层与逃逸（D-1 / N-40 的修复）：
 *   - 模态栈：多个模态叠开时，Tab 只由**栈顶**模态接管 —— 旧实现每个实例
 *     都在 window 上挂监听，一次 Tab 被两层各自 preventDefault + focus，
 *     谁赢取决于注册顺序；
 *   - focusin 兜底：焦点经程序化 focus()、点击非聚焦区域等途径**逃出面板**
 *     时拉回来 —— 旧实现只拦 keydown 的 Tab，其余逃逸路径全部失守；
 *   - 归还纪律：只有自己仍是栈顶时才把焦点还给 prev —— 下层模态先关
 *     （上层还开着）不许抢焦点。
 *
 * 用 rAF 而不是直接 focus()：面板此时还没挂载进 DOM。
 */

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 模态栈（模块级）：effect 依激活顺序入栈，卸载出栈；只认栈顶 */
const dialogStack: symbol[] = [];

export function useDialogFocus(
  active: boolean,
  panelRef: RefObject<HTMLElement | null>,
  initialRef?: RefObject<HTMLElement | null>,
) {
  /** 只在「从关到开」那一次记录的触发元素（B12-8，见下） */
  const prevRef = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);

  useEffect(() => {
    if (!active) {
      wasActive.current = false; // 关闭才复位：effect 因依赖变化重跑时不算"重新打开"
      return;
    }
    const token = Symbol("dialog");
    dialogStack.push(token);
    const isTop = () => dialogStack[dialogStack.length - 1] === token;
    // B12-8：`prev` 只在**打开那一刻**捕获一次。旧实现写在 effect 体内，于是任何一次
    // 重跑（panelRef/initialRef 变化、父组件重渲染）都会把 activeElement 重新记一遍 ——
    // 叠层场景下抓到的其实是**上层模态里的输入框**，cleanup 归还焦点时就把焦点从上层的
    // 手打确认框抢回下层面板（Tab 陷阱随之失效，Esc 与视觉焦点错位）。
    if (!wasActive.current) {
      prevRef.current = document.activeElement as HTMLElement | null;
      wasActive.current = true;
    }

    const raf = requestAnimationFrame(() => {
      if (!isTop()) return; // 栈顶另有其人（同帧又开了更上层的模态）：让位
      const target = initialRef?.current ?? panelRef.current;
      target?.focus();
    });

    const focusables = () =>
      Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (!isTop()) return; // 叠层：Tab 归最上层模态管
      const panel = panelRef.current;
      if (!panel) return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const cur = document.activeElement as HTMLElement | null;
      const inside = cur ? panel.contains(cur) : false;
      if (e.shiftKey && (!inside || cur === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || cur === last)) {
        e.preventDefault();
        first.focus();
      }
    };

    // focusin 兜底：焦点逃出面板（程序化 focus / 点击非聚焦区把焦点打到
    // body 或遮罩）就拉回面板内；非栈顶不掺和
    const onFocusIn = (e: FocusEvent) => {
      if (!isTop()) return;
      const panel = panelRef.current;
      if (!panel) return;
      const t = e.target as HTMLElement | null;
      if (t && panel.contains(t)) return;
      const items = focusables();
      (items[0] ?? panel).focus();
    };

    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      const wasTop = dialogStack[dialogStack.length - 1] === token;
      const idx = dialogStack.indexOf(token);
      if (idx >= 0) dialogStack.splice(idx, 1);
      // 面板已经卸载，焦点会掉到 body —— 主动还回去。
      // 只有自己原本是栈顶才归还：下层先关不许抢上层模态的焦点。
      // B12-8：只还「打开那一刻」记录的元素，且它仍在文档里（可能已被卸载/替换）。
      const prev = prevRef.current;
      if (wasTop && prev && prev.isConnected) prev.focus?.();
    };
  }, [active, panelRef, initialRef]);
}
