/**
 * 预览入口（dev-only，不参与生产构建）。
 * 必须先 import mockBackend 安装 window.__TAURI_INTERNALS__，
 * 再加载 App —— ESM 按书写顺序执行副作用，保证 mock 先就位。
 */
import "./mockBackend";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../App";
import "../styles/tokens.css";
import "../styles/surface.css";
import "../styles/app.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
