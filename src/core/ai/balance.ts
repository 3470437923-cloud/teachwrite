/**
 * 账户余额查询（DeepSeek 官方独有端点 `GET /user/balance`）。
 *
 * 为什么走 Rust：与 SSE / 模型清单同理，WebView 直连会撞 CORS。
 * 事实依据：`docs/DECISIONS.md` 附录 A §6 —— 响应含 `is_available` 与
 * `balance_infos[{currency(CNY|USD), total_balance, granted_balance, topped_up_balance}]`。
 *
 * 裁决：D-019 面板显示余额；**D-020 不做人民币用量估算**（余额是官方权威值，不做差值推算）。
 * 只有 DeepSeek 官方平台有此端点（`platformSupportsBalance`），其他平台调用会失败，
 * 调用方须先判平台。
 */

import { invoke } from "@tauri-apps/api/core";

/** 单币种余额（金额是**字符串**，官方原样返回，避免浮点误差） */
export interface BalanceEntry {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface BalanceInfo {
  /** 余额是否足以继续调用 */
  isAvailable: boolean;
  balances: BalanceEntry[];
}

/**
 * 查余额。参数与 Rust 侧 `BalanceRequest`（serde camelCase）逐一对应。
 * 失败（未填地址/Key、网络失败、非 JSON 响应、余额端点不存在）以 Err 字符串 reject。
 */
export async function fetchBalance(baseUrl: string, apiKey: string): Promise<BalanceInfo> {
  return invoke<BalanceInfo>("ai_balance", { request: { baseUrl, apiKey } });
}