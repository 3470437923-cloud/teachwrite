//! 网页版参考栏（D-057，2026-10-09 用户裁决）：白名单站点内嵌为主窗口的子 webview。
//!
//! 隔离纪律（用户原话「不能支持这个浏览器ai接入任何东西」）：
//!  - URL 白名单**编译期硬编码**，前端只能传 key，任何其它输入直接拒绝 ——
//!    应用没有"任意地址浏览器"这条攻击面；
//!  - 远程页面零 IPC：capabilities 不给任何远程源开口，子 webview 的 JS
//!    调不动本应用的任何命令（fs/ai/prefs 全部不可达）；
//!  - 独立 webview 数据存储（与主窗口互不影响），登录态属于用户自己的网页会话；
//!  - 应用不注入脚本、不抓取内容、不回读任何数据。
//!
//! 已知坑（tauri 文档）：Windows 上 add_child 在同步命令/事件处理器里会死锁
//! （wry#583）—— 本模块三个命令全部是 async，务必保持。
//!
//! 生命周期：子 webview 不随前端 DOM 卸载自动消失，前端的栏位组件负责在
//! 栏收起 / 进设置屏 / 组件卸载时显式调 web_close；开过的栏重开时 web_open
//! 复用已存在的子视图（只挪几何 + 聚焦，不重载页面）。
//!
//! ── 数据存储的平台口径（**待 Mac 上验证**）──
//! wry 0.57 **只在 Windows(WebView2) 与 Linux(webkitgtk) 实现 `data_directory`**：
//! macOS 上该调用**静默无效**（`wkwebview` 里根本没有读它的代码），目录永不创建，
//! 子视图的登录态与主窗口共用同一个 default store —— 于是
//! `docs/DEVELOPMENT.md` 写的「删掉 `webview-sessions\{deepseek,zhuque}` = 网页版退出登录」
//! 在 macOS 上**不再成立**。
//! 所以 macOS 改用 wry/tauri 为此专门提供的替代品
//! `WebviewBuilder::data_store_identifier([u8;16])`
//! （tauri 2.12 `webview/mod.rs:1159-1170`：`WKWebsiteDataStore::dataStoreForIdentifier`，
//! 需要 macOS 14+；本产品目标 macOS 26，满足）。
//! Windows 侧**保持 `data_directory` 不变**（`data_store_identifier` 在 Windows 上
//! 不被 wry 读取，同时设置互不干扰）。

use std::path::PathBuf;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// key → URL 白名单（编译期常量；加站点 = 改这里 + 重编译）。
/// 两个入口的语义：
///  - deepseek：DeepSeek 网页版（参考对话，与 API 配置无关）
///  - zhuque：腾讯朱雀 AI 检测（AI 生成内容鉴别，https://matrix.tencent.com/ai-detect/ai_gen）
pub fn allowed_url(key: &str) -> Option<&'static str> {
    match key {
        "deepseek" => Some("https://chat.deepseek.com/"),
        "zhuque" => Some("https://matrix.tencent.com/ai-detect/ai_gen"),
        _ => None,
    }
}

fn label_of(key: &str) -> String {
    format!("web-{key}")
}

/// 子视图的独立数据目录（登录态与主窗口隔离）：<配置目录>\webview-sessions\<key>
/// —— 仅 Windows/Linux 生效（见文件头的平台口径说明）。
fn data_dir(app: &AppHandle, key: &str) -> PathBuf {
    crate::sys::prefs_path(app)
        .with_file_name("webview-sessions")
        .join(key)
}

/// 子视图的独立数据存储标识（macOS 专用替代品）：由 key 稳定推导的 16 字节 UUID。
///
/// **必须是确定性推导**：换算法或换常量等于给用户换一个空 store，
/// 网页版的登录态会在升级后"莫名退出"。同 key 永远同标识，故用 FNV-1a 双通道展开。
/// 末两处位运算把结果规范成 UUID v4 形态（`NSUUID::from_bytes` 本身不校验，
/// 规范只是为了排查时好看）。
fn store_id(key: &str) -> [u8; 16] {
    const SEED: &[u8] = b"DeepCompose/webview-sessions/";
    let mut out = [0u8; 16];
    for (i, slot) in out.chunks_exact_mut(8).enumerate() {
        // 两个通道用不同的偏移量，避免 16 字节出现重复的 8 字节
        let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ (i as u64).wrapping_mul(0x0100_0000_01b3);
        for b in SEED.iter().chain(key.as_bytes()) {
            h ^= *b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        slot.copy_from_slice(&h.to_be_bytes());
    }
    out[6] = (out[6] & 0x0f) | 0x40;
    out[8] = (out[8] & 0x3f) | 0x80;
    out
}

#[tauri::command]
pub async fn web_open(app: AppHandle, key: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let Some(url) = allowed_url(&key) else {
        return Err(format!("未知的网页入口：{key}"));
    };
    let label = label_of(&key);
    // 已存在 = 复用：挪到最新几何并聚焦，不重载页面（登录态与浏览位置都保留）
    if let Some(wv) = app.get_webview(&label) {
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = app.get_window("main").ok_or("主窗口不存在")?;
    let parsed = url.parse().map_err(|e| format!("白名单 URL 解析失败（不该发生）：{e}"))?;
    // 两个隔离手段同时挂上：Windows/Linux 认 data_directory，macOS 认
    // data_store_identifier（另一个在各自平台上被忽略，互不干扰）。
    let builder = tauri::webview::WebviewBuilder::new(label, WebviewUrl::External(parsed))
        .data_directory(data_dir(&app, &key))
        .data_store_identifier(store_id(&key));
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn web_move(app: AppHandle, key: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    if allowed_url(&key).is_none() {
        return Err(format!("未知的网页入口：{key}"));
    }
    if let Some(wv) = app.get_webview(&label_of(&key)) {
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn web_close(app: AppHandle, key: String) -> Result<(), String> {
    if allowed_url(&key).is_none() {
        return Err(format!("未知的网页入口：{key}"));
    }
    if let Some(wv) = app.get_webview(&label_of(&key)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_allows_only_the_two_entries() {
        assert_eq!(allowed_url("deepseek"), Some("https://chat.deepseek.com/"));
        assert_eq!(allowed_url("zhuque"), Some("https://matrix.tencent.com/ai-detect/ai_gen"));
    }

    #[test]
    fn whitelist_rejects_everything_else() {
        // 完整 URL、大小写变体、空串、带 NUL 的注入串：一律拒绝
        assert_eq!(allowed_url("https://evil.example/"), None);
        assert_eq!(allowed_url("DeepSeek"), None);
        assert_eq!(allowed_url(""), None);
        assert_eq!(allowed_url("deepseek\0zhuque"), None);
    }

    /// 数据存储标识必须**稳定**（换算法 = 用户升级后网页版登录态莫名退出）
    /// 且**两个入口互不相同**（否则两个参考栏会共用一个 store，隔离失效）。
    #[test]
    fn store_id_is_stable_and_distinct() {
        assert_eq!(store_id("deepseek"), store_id("deepseek"));
        assert_eq!(store_id("zhuque"), store_id("zhuque"));
        assert_ne!(store_id("deepseek"), store_id("zhuque"));
        // 规范成 UUID v4 形态（version=4 / variant=10xx）
        let id = store_id("deepseek");
        assert_eq!(id[6] & 0xf0, 0x40);
        assert_eq!(id[8] & 0xc0, 0x80);
        // 固定向量：种子/算法一旦改动，这条会立刻红（改种子 = 用户升级后登录态全丢）
        assert_eq!(
            store_id("deepseek"),
            [
                0x5e, 0xa5, 0xd9, 0xce, 0x1f, 0x7a, 0x47, 0xac, 0x87, 0x45, 0xdf, 0xcd, 0x83, 0x12,
                0x76, 0x75
            ]
        );
        assert_eq!(
            store_id("zhuque"),
            [
                0x6e, 0xd1, 0xd9, 0x3a, 0xc0, 0xbc, 0x43, 0x3c, 0xaa, 0x61, 0x7e, 0x0c, 0xfc, 0x58,
                0xa2, 0x4d
            ]
        );
    }
}
