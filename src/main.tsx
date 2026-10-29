import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyPlatformAttribute } from "./core/platform";
import "./styles/tokens.css";
import "./styles/surface.css";
import "./styles/app.css";

// 运行时错误只进控制台（打包版不污染窗口标题）
window.onerror = (msg, src, line, col) => {
  console.error("ERR:", String(msg), src, line, col);
  return false;
};
window.onunhandledrejection = (e) => {
  console.error("REJ:", String(e.reason));
};

// 平台标记必须在首帧之前落到 <html>：CSS 要靠它决定标题栏左内边距
// （macOS 的交通灯是原生按钮，叠在网页左上角，品牌必须让位）。
// 放在渲染前而不是组件 effect 里，是为了避免首帧"品牌被交通灯压住"的闪动。
applyPlatformAttribute(document.documentElement);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
