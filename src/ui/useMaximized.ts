/**
 * 跟踪窗口是否处于最大化状态。
 *
 * 为什么需要它：窗口是 `decorations: false`（无边框、自绘标题栏），系统标题栏
 * 没有了，于是「最大化 ⇄ 还原」这个状态在界面上**没有任何别的提示**——
 * 按钮的图标与 tooltip 就是用户唯一的反馈。此前两者都写死为「最大化」，
 * 窗口最大化之后按下去仍然显示「最大化」，看不出当前处于哪个状态。
 *
 * 状态来源：双击标题栏、Aero Snap（拖到屏幕顶端/两侧）、Win+↑ 都会改状态，
 * 所以除了启动时同步一次，还要监听 resize 事件持续同步。
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function useMaximized(): boolean {
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;
    const sync = () => {
      void win
        .isMaximized()
        .then((v) => {
          if (alive) setMaxed(!!v);
        })
        // 浏览器预览沙箱里没有真实窗口状态；失败就保持原值，不要抛到控制台
        .catch(() => {});
    };
    sync();
    const un = win.onResized(sync).catch(() => null);
    return () => {
      alive = false;
      void un.then((f) => f && f());
    };
  }, []);

  return maxed;
}