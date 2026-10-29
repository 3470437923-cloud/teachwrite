//! 窗口几何记忆：尺寸 / 位置 / 最大化状态。
//!
//! 委托方要求：每次启动都要恢复上次正常关闭时的窗口大小与位置（"每次重启都要
//! 重新缩放大小"）。所以"记忆窗口几何"是 DeepCompose 新增的一项扩展行为 ——
//! 上次改成 1200×760 正常关闭后再启动，仍按 1200×760 恢复，而不是回到
//! 固定默认的 **1440×900 居中**。
//!
//! 落盘位置刻意**不写进** `shared_preferences.json`：本产品配置是封闭键集合，
//! 窗口几何属于 UI 运行时状态而非用户配置，另存
//! TeachWrite 专属应用根下的 `window_state.json`，与 prefs 同根。
//! Windows/macOS/Linux 都由 sys::prefs_path 推导，避免读取 DeepCompose 的窗口状态。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// 与 tauri.conf.json 的默认窗口一致（1440×900 居中）。
pub const DEFAULT_W: u32 = 1440;
pub const DEFAULT_H: u32 = 900;
/// 与 tauri.conf.json 的 minWidth / minHeight 一致。
pub const MIN_W: u32 = 980;
pub const MIN_H: u32 = 640;
/// 窗口与某块屏至少要有这么多像素相交，才认为它"看得见"。
const MIN_VISIBLE: i32 = 160;
/// 最大化/还原过渡的稳定等待，见 `track_soon` 与 `restore`。
const SETTLE_MS: u64 = 150;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WinState {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub maximized: bool,
}

/// 一块屏的边界（**物理像素**）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// 拖动/缩放期间把"还原态"几何记在内存里，关闭时只落盘一次
/// —— 避免拖拽过程中产生几十次小文件写。
///
/// `pending` 保证同一时刻只有一个待核对任务（见 `track_soon`），
/// 而 `Arc` 是为了能把句柄搬进异步任务里。
#[derive(Default, Clone)]
pub struct Tracker {
    inner: Arc<Mutex<Option<WinState>>>,
    pending: Arc<AtomicBool>,
}

impl Tracker {
    /// 读取内存基线（关闭落盘时用于"最大化前的还原态几何"）。
    fn get(&self) -> Option<WinState> {
        self.inner.lock().ok().and_then(|g| *g)
    }
}

fn state_path(app: &AppHandle) -> PathBuf {
    crate::sys::prefs_path(app).with_file_name("window_state.json")
}

pub fn load(app: &AppHandle) -> Option<WinState> {
    let raw = fs::read_to_string(state_path(app)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 落盘失败**故意忽略**：窗口几何是尽力而为的状态，绝不能因此挡住关窗。
pub fn save(app: &AppHandle, st: &WinState) {
    let Ok(raw) = serde_json::to_string_pretty(st) else {
        return;
    };
    let p = state_path(app);
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&p, raw);
}

fn span(st: &WinState, s: &Screen) -> (i32, i32) {
    // saturating 算术：window_state.json 是用户可写的，
    // 构造的极值（w 接近 u32::MAX、x 为 i32::MIN 等）不能让加法溢出 ——
    // debug 构建溢出即 panic，而 Cargo.toml 的 panic="abort" 会让 release 整进程死。
    let x1 = st.x.max(s.x);
    let y1 = st.y.max(s.y);
    let x2 = st
        .x
        .saturating_add(st.w.min(i32::MAX as u32) as i32)
        .min(s.x.saturating_add(s.w.min(i32::MAX as u32) as i32));
    let y2 = st
        .y
        .saturating_add(st.h.min(i32::MAX as u32) as i32)
        .min(s.y.saturating_add(s.h.min(i32::MAX as u32) as i32));
    ((x2 - x1).max(0), (y2 - y1).max(0))
}

/// 把记忆的几何夹回当前这块屏幕；返回 `None` 表示这组几何已经不可用
/// （外接屏被拔掉、分辨率变小等），调用方应当**保持 tauri.conf.json 的默认值**。
///
/// 规则：
///   1. 必须与某块屏有足够交集，否则整组丢弃；
///   2. 尺寸夹进该屏，且不低于最小尺寸；
///   3. 位置平移至完全落在该屏内 —— 无边框窗口一旦有一角跑到屏幕外，
///      用户就再也拖不回来了（这正是"窗口跑到看不见的地方"的经典故障）。
pub fn sanitize(st: WinState, screens: &[Screen]) -> Option<WinState> {
    if st.w < 1 || st.h < 1 {
        return None;
    }
    // 尺寸 sanity 上限：任何屏幕都不可能需要的量级直接夹掉
    //（window_state.json 用户可写，天文数字没有几何意义）
    let st = WinState {
        w: st.w.min(16384),
        h: st.h.min(16384),
        ..st
    };
    let host = screens.iter().find(|s| {
        let (sw, sh) = span(&st, s);
        sw >= MIN_VISIBLE && sh >= MIN_VISIBLE
    })?;

    let w = st.w.clamp(MIN_W.min(host.w), host.w.max(MIN_W));
    let h = st.h.clamp(MIN_H.min(host.h), host.h.max(MIN_H));
    let x = st.x.clamp(host.x, (host.x + host.w as i32 - w as i32).max(host.x));
    let y = st.y.clamp(host.y, (host.y + host.h as i32 - h as i32).max(host.y));
    Some(WinState {
        x,
        y,
        w,
        h,
        maximized: st.maximized,
    })
}

/// 用显示器整块边界：`Monitor::position()` / `size()` 返回的是引用（不是 Result），
/// 且 Tauri 2 的 `Monitor` 不暴露各屏工作区，故此处按整屏夹取。
fn screens(win: &WebviewWindow) -> Vec<Screen> {
    win.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            Screen {
                x: p.x,
                y: p.y,
                w: s.width,
                h: s.height,
            }
        })
        .collect()
}

/// 位置取**外框**（`set_position` 也是外框口径），尺寸取**客户区**
/// （`set_size` 走 tao 的 `set_inner_size`，是客户区口径）。
/// 两边各自自洽才能原样往返 —— 实测把外框尺寸交给 `set_size`，窗口每次会比
/// 上次大一圈（存 1200×760 的外框，恢复出来是 1216×799）。
fn current(win: &WebviewWindow) -> Option<WinState> {
    let p = win.outer_position().ok()?;
    let s = win.inner_size().ok()?;
    Some(WinState {
        x: p.x,
        y: p.y,
        w: s.width,
        h: s.height,
        maximized: false,
    })
}

/// 把客户区尺寸调到 `w×h`。
///
/// 实测到的机制（**Windows 专有**）：窗口创建后**第一次** `set_size` 的落地值会多出
/// 一个标题栏高度（本机 30px @100% DPI —— 那一刻窗口样式里还算着 `WS_CAPTION`），
/// 而**之后**再设就精确了。所以这里是"用同一个值重试直到读回一致"，
/// 不是按差额补偿 —— 补偿会反向多减 30px（实测踩过：想要 751，落成 721）。
///
/// macOS 上不存在 `WS_CAPTION` 这回事，`set_size` 一次就准；照旧跑这段只会
/// 白等 3×60ms 再 `show()`，把启动显示推迟约 180ms。故整段只在 Windows 编译。
#[cfg(windows)]
async fn correct_size(win: &WebviewWindow, w: u32, h: u32) {
    for _ in 0..3 {
        let Ok(now) = win.inner_size() else {
            return;
        };
        if now.width == w && now.height == h {
            return;
        }
        let _ = win.set_size(PhysicalSize::new(w, h));
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
}

/// 非 Windows：`set_size` 直接生效，不需要补偿循环（保留同名空实现，
/// 让 `restore` 的调用点两平台一致、不出现 cfg 分叉的可读性代价）。
#[cfg(not(windows))]
async fn correct_size(_win: &WebviewWindow, _w: u32, _h: u32) {}

/// 启动时套用记忆的几何。没有记忆 / 记忆不可用 → 什么都不做，
/// 保持 tauri.conf.json 的 1440×900 居中（并立刻显示）。
///
/// 有记忆时窗口**先不显示**：尺寸补偿与最大化都在异步任务里做，
/// 全部落定后才 `show()`,否则用户会看到窗口先以错尺寸出现、再跳一下。
pub fn restore(win: &WebviewWindow, tracker: &Tracker) {
    let saved = load(win.app_handle()).and_then(|st| sanitize(st, &screens(win)));
    if let Some(st) = saved {
        let _ = win.set_size(PhysicalSize::new(st.w, st.h));
        let _ = win.set_position(PhysicalPosition::new(st.x, st.y));
    }
    // 建立基线：恢复成功就用恢复值，否则用当前（tauri.conf 默认）几何。
    let base = saved
        .map(|mut st| {
            st.maximized = false;
            st
        })
        .or_else(|| current(win));
    if let Ok(mut g) = tracker.inner.lock() {
        *g = base;
    }

    match saved {
        Some(st) => {
            let win = win.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(SETTLE_MS)).await;
                correct_size(&win, st.w, st.h).await;
                // 最大化必须放在几何落定之后：紧接着 set_size/set_position 调
                // maximize，Windows 会抢在移动生效前记下"最大化前的矩形"，
                // 于是取消最大化会回到屏幕中央而不是用户原来的 (x,y)
                // （实测踩过：期望 (120,80)，实际回到 (240,66)）。
                if st.maximized {
                    let _ = win.maximize();
                }
                let _ = win.show();
            });
        }
        None => {
            let _ = win.show();
        }
    }
}

/// 收到 Resized/Moved 后**延迟**核对，再记基线。
///
/// 为什么必须延迟：最大化/还原的过渡里「几何已经变成整屏」会**先于**
/// `is_maximized()` 变成 true 到达事件回调。当场就记，会把最大化后的整屏矩形
/// 当成"还原态"存下来 —— 实测踩过：state 被写成
/// `{"x":-8,"y":-8,"w":1936,"h":1048,"maximized":true}`，
/// 于是下次取消最大化得到的是整屏尺寸，而不是用户原先调好的大小。
///
/// 拖拽期间事件很密集，`pending` 保证只挂一个任务；该任务读的是**当下**几何，
/// 所以它天然收敛到最终值。
pub fn track_soon(win: &WebviewWindow, tracker: &Tracker) {
    if tracker.pending.swap(true, Ordering::SeqCst) {
        return; // 已有一个待核对任务
    }
    let win = win.clone();
    let inner = tracker.inner.clone();
    let pending = tracker.pending.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SETTLE_MS)).await;
        pending.store(false, Ordering::SeqCst);
        // 只在**非**最大化/最小化时记：要留的是"还原后"的几何
        if win.is_maximized().unwrap_or(false) || win.is_minimized().unwrap_or(false) {
            return;
        }
        if let Some(st) = current(&win) {
            if let Ok(mut g) = inner.lock() {
                *g = Some(st);
            }
        }
    });
}

/// 关闭时落盘。最大化时记"还原后的几何 + maximized=true"，这样下次启动会先
/// 还原到旧尺寸再最大化，用户取消最大化就能回到自己原先调好的大小。
pub fn persist(win: &WebviewWindow, tracker: &Tracker) {
    let maximized = win.is_maximized().unwrap_or(false);
    // 未最大化时以"当下几何"为准（最新最准）；最大化时用内存基线（还原后的几何）。
    let live = if maximized { None } else { current(win) };
    let mut st = live.or_else(|| tracker.get()).unwrap_or(WinState {
        x: 0,
        y: 0,
        w: DEFAULT_W,
        h: DEFAULT_H,
        maximized: false,
    });
    st.maximized = maximized;
    save(win.app_handle(), &st);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Screen = Screen {
        x: 0,
        y: 0,
        w: 1920,
        h: 1032,
    };
    const SECOND: Screen = Screen {
        x: 1920,
        y: 0,
        w: 1920,
        h: 1032,
    };

    fn st(x: i32, y: i32, w: u32, h: u32) -> WinState {
        WinState {
            x,
            y,
            w,
            h,
            maximized: false,
        }
    }

    #[test]
    fn keeps_a_sane_rect_untouched() {
        let s = st(240, 66, 1440, 900);
        assert_eq!(sanitize(s, &[SCREEN]), Some(s));
    }

    #[test]
    fn drops_a_rect_that_is_off_every_screen() {
        assert_eq!(sanitize(st(-3000, 100, 1440, 900), &[SCREEN]), None);
    }

    #[test]
    fn drops_a_rect_barely_touching_the_edge() {
        // 只剩 1px 露在屏内，不算"看得见"
        assert_eq!(sanitize(st(-1439, 0, 1440, 900), &[SCREEN]), None);
    }

    #[test]
    fn clamps_a_rect_from_a_bigger_monitor() {
        assert_eq!(
            sanitize(st(0, 0, 3840, 2160), &[SCREEN]),
            Some(st(0, 0, 1920, 1032))
        );
    }

    #[test]
    fn nudges_a_rect_back_inside() {
        // 右下角出屏，但仍与屏有足够交集 → 整体平移回去
        assert_eq!(
            sanitize(st(1700, 800, 1440, 900), &[SCREEN]),
            Some(st(480, 132, 1440, 900))
        );
    }

    #[test]
    fn raises_a_too_small_rect_to_the_minimum() {
        assert_eq!(
            sanitize(st(10, 10, 300, 200), &[SCREEN]),
            Some(st(10, 10, 980, 640))
        );
    }

    #[test]
    fn rejects_a_degenerate_rect() {
        assert_eq!(sanitize(st(0, 0, 0, 0), &[SCREEN]), None);
    }

    #[test]
    fn accepts_a_rect_on_a_second_screen() {
        let s = st(2000, 100, 1440, 900);
        assert_eq!(sanitize(s, &[SCREEN, SECOND]), Some(s));
    }

    #[test]
    fn falls_back_when_the_second_screen_is_unplugged() {
        // 上次在第二块屏（x=2000），拔掉后只剩主屏 → 整组丢弃，回到默认居中
        assert_eq!(sanitize(st(2000, 100, 1440, 900), &[SCREEN]), None);
    }

    #[test]
    fn keeps_the_maximized_flag() {
        let mut s = st(240, 66, 1440, 900);
        s.maximized = true;
        assert!(sanitize(s, &[SCREEN]).unwrap().maximized);
    }

    #[test]
    fn serializes_with_camel_case_keys() {
        let raw = serde_json::to_string(&WinState {
            x: 1,
            y: 2,
            w: 3,
            h: 4,
            maximized: true,
        })
        .unwrap();
        assert_eq!(raw, r#"{"x":1,"y":2,"w":3,"h":4,"maximized":true}"#);
    }

    #[test]
    fn old_files_without_the_flag_still_parse() {
        let s: WinState = serde_json::from_str(r#"{"x":1,"y":2,"w":3,"h":4}"#).unwrap();
        assert!(!s.maximized);
    }
}