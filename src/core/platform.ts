/**
 * 运行平台判定（**全仓库唯一真源**）。
 *
 * 为什么不用 `process.platform` 就完事：Tauri 的 WebView 没开 node 集成，
 * 打包产物里 `process` 根本不存在，只有 `navigator.userAgent` 可用；
 * 反过来 Node 环境（vitest / 构建脚本 / 预览沙箱的 node 侧）则 `navigator` 不一定有。
 * 所以判定按「process → navigator → 兜底」三级走。
 *
 * 兜底刻意选 **Windows**：这是改动前的唯一行为。识别不出来时宁可保守，
 * 也不要把 Windows 的 `\` 换成 `/` —— 那会让既有路径集体失联。
 * 同理，`dirs.ts` 的路径拼接与本模块必须同源，否则会出现
 * 「路径按 macOS 拼、界面按 Windows 画」这种最难查的错位。
 */

export type Platform = "windows" | "macos" | "other";

function detectPlatform(): Platform {
  const proc = (globalThis as { process?: { platform?: string } }).process;
  if (proc && typeof proc.platform === "string" && proc.platform !== "") {
    if (proc.platform === "win32") return "windows";
    if (proc.platform === "darwin") return "macos";
    return "other";
  }
  const nav = (globalThis as { navigator?: { userAgent?: string; platform?: string } }).navigator;
  const ua = `${nav?.userAgent ?? ""} ${nav?.platform ?? ""}`.trim();
  if (ua === "") return "windows";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X|iPhone|iPad/i.test(ua)) return "macos";
  return "other";
}

export const PLATFORM: Platform = detectPlatform();

/** 是否 Windows（决定路径分隔符与 NTFS 专有检查） */
export const IS_WINDOWS: boolean = PLATFORM === "windows";

/** 是否 macOS（决定原生标题栏/交通灯与文案） */
export const IS_MACOS: boolean = PLATFORM === "macos";

/** 本机路径分隔符（Windows `\`，其余 `/`）。**不要**在别处再硬编码分隔符。 */
export const PATH_SEP: string = IS_WINDOWS ? "\\" : "/";

/**
 * 把平台写进 `<html data-os="…">`，供 CSS 做平台分支
 * （与既有的 `data-nav` / `data-theme` 同一套机制）。
 * 在渲染前调用一次即可；重复调用无副作用。
 */
export function applyPlatformAttribute(root: HTMLElement): void {
  root.dataset.os = PLATFORM;
}
