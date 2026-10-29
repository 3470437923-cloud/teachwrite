import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { platform } from "node:process";

/**
 * 构建目标按平台分流（macOS 移植批次，2026-10）。
 *
 * 为什么 macOS 不能继续用 `chrome110`：Tauri 的 WebView 是**系统 WebView** ——
 * macOS 上就是 WKWebView（Safari 内核），它**不是** Chromium，版本跟着系统走。
 * `chrome110` 会让 esbuild 以为 Safari 也支持 chrome110 的那套特性，于是不再补
 * `-webkit-` 前缀。实测（同一份源码、只改 --target）唯一的差别就在这里：
 *
 *   target=chrome110  → CSS 162262 字节，`-webkit-user-select` 出现 0 次
 *   target=safari16   → CSS 162459 字节，`-webkit-user-select` 出现 8 次
 *   （JS 产物 684242 字节、sha256 前 16 位 c4921200dfccef21，两者**逐字节相同**；
 *     safari15 / 16 / 16.1 / 16.4 / 17 / es2022 的 CSS 也与 safari16 完全一致）
 *
 * `user-select` 的无前缀形式在 Safari 上**至今不被支持**（web-features 把它列为
 * "Limited availability · Safari: Not supported"，Safari 只认 `-webkit-user-select`）。
 * 本项目的 `app.css` 在 body 与 input/textarea/select 上都写了 `user-select`，
 * 缺前缀的后果是 macOS 上这些规则**整条失效**：自绘标题栏拖窗口时会选中界面文字、
 * 输入框的选区行为与设计不符。所以 macOS 侧必须让 esbuild 按 Safari 的口径补前缀。
 *
 * 为什么选 `safari16`：它对齐 `tauri.conf.json` 的
 * `bundle.macOS.minimumSystemVersion: "13.0"`（macOS 13.0 自带 Safari 16.1）。
 * 本仓库的代码不需要任何 JS 降级（上面已实测各 target 的 JS 产物逐字节相同），
 * 所以这个更保守的目标**只带来前缀收益，零体积/零语义代价**。
 *
 * Windows 保持 `chrome110` **一个字不动**：那里是真的 Chromium（WebView2），
 * 而且要保持既有产物逐字节不变。
 */
const BUILD_TARGET = platform === "darwin" ? "safari16" : "chrome110";

// Tauri 需要固定端口、不清屏、固定 outDir
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    watch: {
      // src-tauri 由 cargo 自己管；另外必须忽略原子写入留下的临时目录：
      // 在 S: 这类卷上，编辑器落盘的 `.name.<pid>.<guid>.tmpdir/` 会被
      // 文件监视器当成新目录去 watch，随即以 EBUSY 崩掉整个 dev server。
      ignored: ["**/src-tauri/**", "**/*.tmpdir/**", "**/.*.tmpdir/**"],
    },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    target: BUILD_TARGET,
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
