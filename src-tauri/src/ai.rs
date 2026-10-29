//! AI 接入层的网络能力：把上游 SSE 原样转发到前端。
//!
//! 为什么放在 Rust：WebView 里直接 fetch 会撞 CORS，且流式响应在浏览器侧不可控。
//! 这里只做「转发」——协议解析、错误分类、工具循环全部在 TS 侧（可单测）。

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

/// 活跃流的中断句柄（request_id → Notify），供「停止生成」取消上游流
pub struct AbortMap(pub Mutex<HashMap<String, Arc<Notify>>>);

/// 取锁的统一出口：poisoned 也取出数据继续用（N-47）。
/// 持锁期间没有可 panic 的代码路径，poison 只可能来自外部不可控因素；
/// panic=abort 的 release 构建里 unwrap 会让整个应用死掉，退而求其次：
/// poisoned 锁里的 HashMap 仍是完整可用的（写操作要么没开始要么已完成）。
fn lock_map<'a>(state: &'a tauri::State<'a, AbortMap>) -> std::sync::MutexGuard<'a, HashMap<String, Arc<Notify>>> {
    state.0.lock().unwrap_or_else(|p| p.into_inner())
}

/// 一次流式请求的配置
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub request_id: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: Value,
}

/// 事件负载：kind = line | http_error | stream_error | done
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiChunk {
    pub request_id: String,
    pub kind: String,
    pub data: String,
}

pub const EVENT_NAME: &str = "ai_chunk";

fn emit(app: &AppHandle, request_id: &str, kind: &str, data: String) {
    let _ = app.emit(
        EVENT_NAME,
        AiChunk {
            request_id: request_id.to_string(),
            kind: kind.to_string(),
            data,
        },
    );
}

#[tauri::command]
pub async fn ai_stream(
    app: AppHandle,
    state: tauri::State<'_, AbortMap>,
    request: AiRequest,
) -> Result<(), String> {
    let AiRequest {
        request_id,
        url,
        headers,
        body,
    } = request;

    // 中断句柄**进门就注册**（早于连接）：连接阶段（弱网可达数秒）用户点
    // 「停止生成」时 ai_abort 也能拿到句柄。配合 ai_abort 的 notify_one
    // （无等待者时存许可），abort 早于本处 select 注册也不会丢。
    let notify = Arc::new(Notify::new());
    lock_map(&state).insert(request_id.clone(), notify.clone());

    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(e) => {
            // 失败路径同样要清掉进门时注册的中断句柄（其余所有退出路径都清了），
            // 否则 AbortMap 残留条目永不释放，同 id 复用时 abort 会打到旧句柄
            lock_map(&state).remove(&request_id);
            return Err(format!("HTTP 客户端创建失败: {e}"));
        }
    };

    let mut req = client.post(&url).json(&body);
    for (k, v) in headers.iter() {
        req = req.header(k.as_str(), v.as_str());
    }

    // 连接阶段同样可中断：abort 即干净收尾（TS 侧按中止契约以「已中止」结束，
    // 不发任何 line，界面保留已有内容）
    let sent = tokio::select! {
        _ = notify.notified() => {
            lock_map(&state).remove(&request_id);
            emit(&app, &request_id, "done", String::new());
            return Ok(());
        }
        res = req.send() => res,
    };

    let resp = match sent {
        Ok(r) => r,
        Err(e) => {
            lock_map(&state).remove(&request_id);
            emit(&app, &request_id, "stream_error", format!("{e}"));
            emit(&app, &request_id, "done", String::new());
            return Ok(());
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        lock_map(&state).remove(&request_id);
        // 错误体截断到 200 字符再转发（与 ai_models/ai_balance 同口径）：
        // 上游错误页可以是整份 HTML，无界转发会撑爆事件负载
        let brief: String = text.chars().take(200).collect();
        emit(
            &app,
            &request_id,
            "http_error",
            format!("{}|{}", status.as_u16(), brief),
        );
        emit(&app, &request_id, "done", String::new());
        return Ok(());
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();

    let mut aborted = false;
    loop {
        tokio::select! {
            _ = notify.notified() => {
                aborted = true;
                break;
            }
            item = stream.next() => {
                match item {
                    Some(Ok(bytes)) => {
                        buf.extend_from_slice(&bytes);
                        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=pos).collect();
                            let s = String::from_utf8_lossy(&line[..line.len() - 1])
                                .trim_end_matches('\r')
                                .to_string();
                            emit(&app, &request_id, "line", s);
                        }
                    }
                    Some(Err(e)) => {
                        emit(&app, &request_id, "stream_error", format!("{e}"));
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    lock_map(&state).remove(&request_id);

    if !buf.is_empty() {
        let s = String::from_utf8_lossy(&buf).to_string();
        emit(&app, &request_id, "line", s);
    }
    emit(&app, &request_id, "done", String::new());
    let _ = aborted; // 中断即干净收尾：已收到的部分正文保留
    Ok(())
}

/// 「停止生成」：中断指定请求的上游流（已收到的部分正文保留）。
/// 用 notify_one 而非 notify_waiters：abort 先于流循环注册等待者到达时，
/// 许可会被存下，随后的 notified() 立即返回，不丢中断。
#[tauri::command]
pub async fn ai_abort(state: tauri::State<'_, AbortMap>, request_id: String) -> Result<(), String> {
    if let Some(notify) = lock_map(&state).remove(&request_id) {
        notify.notify_one();
    }
    Ok(())
}

/// 拉取上游模型清单（OpenAI 兼容 GET {base}/models；Anthropic 用 x-api-key 头）。
/// 供设置屏「检测连接 + 模型下拉」使用。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsRequest {
    pub base_url: String,
    pub api_key: String,
    pub use_anthropic_format: bool,
}

#[tauri::command]
pub async fn ai_models(request: ModelsRequest) -> Result<Vec<String>, String> {
    let ModelsRequest {
        base_url,
        api_key,
        use_anthropic_format,
    } = request;

    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() || api_key.trim().is_empty() {
        return Err("请先填写接口地址与 API Key".into());
    }
    // base 可能带 /v1 后缀；两种习惯都兼容
    let url = if base.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    let mut req = client.get(&url);
    if use_anthropic_format {
        req = req
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", "2023-06-01");
    } else {
        req = req.header("authorization", format!("Bearer {}", api_key.trim()));
    }

    let resp = req.send().await.map_err(|e| format!("连接失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let brief: String = text.chars().take(200).collect();
        return Err(format!("HTTP {}: {}", status.as_u16(), brief));
    }

    let v: Value = serde_json::from_str(&text).map_err(|_| "响应不是 JSON".to_string())?;
    // OpenAI 兼容：{"data":[{"id":...}]}; Anthropic：{"data":[{"id":...}]} 同构
    let mut ids: Vec<String> = Vec::new();
    if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    Ok(ids)
}

/// 余额查询请求（只有 DeepSeek 官方提供 `GET /user/balance`，见 docs/DECISIONS.md 附录 A §6）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceRequest {
    pub base_url: String,
    pub api_key: String,
}

/// 单币种余额（金额原样透传为字符串，避免浮点误差）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceEntry {
    pub currency: String,
    pub total_balance: String,
    pub granted_balance: String,
    pub topped_up_balance: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceInfo {
    pub is_available: bool,
    pub balances: Vec<BalanceEntry>,
}

/// 把用户填的 Base URL 规整成余额端点：去掉尾部 '/'、剥掉结尾的 `/v1`
/// （余额端点**不在** `/v1` 下，见官方 API Reference），再拼 `/user/balance`。
pub fn balance_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let base = base.strip_suffix("/v1").unwrap_or(base);
    format!("{base}/user/balance")
}

/// 查余额（DeepSeek 官方独有端点）。失败以 Err 字符串返回，界面直接展示。
#[tauri::command]
pub async fn ai_balance(request: BalanceRequest) -> Result<BalanceInfo, String> {
    let BalanceRequest { base_url, api_key } = request;
    if base_url.trim().is_empty() || api_key.trim().is_empty() {
        return Err("请先填写接口地址与 API Key".into());
    }
    let url = balance_url(&base_url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    let resp = client
        .get(&url)
        .header("authorization", format!("Bearer {}", api_key.trim()))
        .send()
        .await
        .map_err(|e| format!("连接失败: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let brief: String = text.chars().take(200).collect();
        return Err(format!("HTTP {}: {}", status.as_u16(), brief));
    }

    let v: Value = serde_json::from_str(&text).map_err(|_| "响应不是 JSON".to_string())?;
    let is_available = v.get("is_available").and_then(|b| b.as_bool()).unwrap_or(false);
    let mut balances: Vec<BalanceEntry> = Vec::new();
    if let Some(arr) = v.get("balance_infos").and_then(|b| b.as_array()) {
        for item in arr {
            let s = |k: &str| item.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            balances.push(BalanceEntry {
                currency: s("currency"),
                total_balance: s("total_balance"),
                granted_balance: s("granted_balance"),
                topped_up_balance: s("topped_up_balance"),
            });
        }
    }
    Ok(BalanceInfo {
        is_available,
        balances,
    })
}

#[cfg(test)]
mod tests {
    use super::balance_url;

    #[test]
    fn balance_url_规整_v1_与尾部斜杠() {
        assert_eq!(
            balance_url("https://api.deepseek.com"),
            "https://api.deepseek.com/user/balance"
        );
        assert_eq!(
            balance_url("https://api.deepseek.com/"),
            "https://api.deepseek.com/user/balance"
        );
        assert_eq!(
            balance_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/user/balance"
        );
        assert_eq!(
            balance_url("https://api.deepseek.com/v1/"),
            "https://api.deepseek.com/user/balance"
        );
        assert_eq!(
            balance_url("  https://api.deepseek.com/v1  "),
            "https://api.deepseek.com/user/balance"
        );
        // 以 /v1 开头的其它路径不能被误剥（只剥完整的 /v1 结尾）
        assert_eq!(
            balance_url("https://example.com/v1beta"),
            "https://example.com/v1beta/user/balance"
        );
    }
}
