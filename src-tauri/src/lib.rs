use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

mod ai;
mod fs;
mod sys;
mod web;
mod winstate;

/// 应用身份信息(名称 + 版本 + 署名与社群),供设置屏「关于」、首启弹窗、使用教程共同读取。
/// 版本与署名都是编译期常量(B19/D-053 的结构锚定):Rust 侧是唯一权威源,前端只读不写;
/// 同一组常量由 build.rs 写进 PE 版本资源(LegalCopyright / Comments),于是任何未改源码的
/// 再分发都会在用户自己的机器上替作者留名。改署名要重编 Rust,改不动前端就行不通。
#[derive(Serialize, Clone)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub author: String,
    pub copyright: String,
    pub qq_group: String,
    /// 作者抖音主页(https;open_url 只放行 https)
    pub douyin_url: String,
    /// 构建烙印:提交号 + 构建时间(由 build.rs 注入;git 不可用时提交号为空)
    pub build: String,
}

/// 署名与社群的唯一真源(与前端 src/core/author.ts 内容一致;改动须两边同批改并记 ADR)。
pub const AUTHOR: &str = "Liumorrow";
pub const AUTHOR_SINCE: &str = "2026";
pub const QQ_GROUP: &str = "1071188925";
pub const DOUYIN_URL: &str = "https://v.douyin.com/cKG2h8pU1IM/";
#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        // 「关于」面板显示的名字:与 productName / 产物 / crate 名保持同一代际
        name: "TeachWrite".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        author: AUTHOR.into(),
        copyright: format!("Copyright © {} {}", AUTHOR_SINCE, AUTHOR),
        qq_group: QQ_GROUP.into(),
        douyin_url: DOUYIN_URL.into(),
        build: format!("{} @ {}", env!("TW_BUILD_COMMIT"), env!("TW_BUILD_TIME")),
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(ai::AbortMap(Mutex::new(HashMap::new())))
        .manage(winstate::Tracker::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            sys::app_dirs,
            sys::prefs_load,
            sys::prefs_save,
            sys::open_dir,
            sys::open_url,
            fs::fs_read_text,
            fs::fs_write_text,
            fs::fs_append_text,
            fs::fs_list,
            fs::fs_exists,
            fs::fs_mkdir,
            fs::fs_remove,
            fs::fs_remove_child,
            fs::fs_rename,
            fs::fs_copy,
            fs::fs_stat,
            ai::ai_stream,
            ai::ai_models,
            ai::ai_balance,
            ai::ai_abort,
            web::web_open,
            web::web_move,
            web::web_close,
        ])
        .setup(|app| {
            // tauri.conf.json 里窗口是 visible:false —— 先把记忆的几何摆好再显示，
            // 否则窗口会先在居中的默认位置闪一下、再跳到上次的位置。
            // 顺序依据：tauri 2.11.6 app.rs:2531 先建配置窗口、2536 才跑 setup。
            // 只能用 get_webview_window：Manager trait 上没有 get_window。
            if let Some(win) = app.get_webview_window("main") {
                let tracker = app.state::<winstate::Tracker>();
                // 注意：restore 内部负责 show()。有记忆几何时它会先补偿尺寸、
                // 该最大化就最大化，全部落定后再显示（否则会看到尺寸跳一下）。
                winstate::restore(&win, &tracker);

                // 兜底：万一上面的恢复任务没能走到 show()，这里无条件补一次
                // （重复 show 是幂等的）。宁可多显示一次，也不能让窗口永不出现。
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
                    let _ = win.show();
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // on_window_event 给的是 &Window，几何方法两边都有，但几何模块统一收
            // &WebviewWindow，故在此按 label 取回同一个窗口。
            let Some(win) = window.app_handle().get_webview_window(window.label()) else {
                return;
            };
            let tracker = win.state::<winstate::Tracker>();
            match event {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                    winstate::track_soon(&win, &tracker)
                }
                // 关窗有两条路径（前端守卫确认后 destroy()，以及直接 CloseRequested），
                // 两条都落盘，保证无论怎么关都能记住几何。
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                    winstate::persist(&win, &tracker)
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("TeachWrite 启动失败");
}
