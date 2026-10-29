/**
 * 上游模型清单拉取（设置屏「检测连接 + 模型下拉」）。
 * 走 Rust 侧 ai_models 命令（避开 WebView CORS）。
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * 拉取模型 id 清单（升序）。
 * 参数与 Rust 侧 ModelsRequest（serde camelCase）逐一对应：
 * baseUrl / apiKey / useAnthropicFormat——Anthropic 格式用 x-api-key +
 * anthropic-version 头，OpenAI 格式用 Bearer 鉴权；15 秒超时与非空校验在 Rust 侧。
 * 失败（未填地址/Key、连接失败、非 JSON 响应）以 Err 字符串 reject，界面直接展示。
 */
export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  useAnthropicFormat: boolean,
): Promise<string[]> {
  return invoke<string[]>("ai_models", {
    request: {
      baseUrl,
      apiKey,
      useAnthropicFormat,
    },
  });
}

/**
 * 模型下拉的过滤（设置页自绘组合框用）：大小写不敏感的子串匹配，
 * 空查询返回全量。保持「输入即筛选、清空见全部」这一条最简单的规则 ——
 * 原生 datalist 只按前缀过滤且弹层高度不受控（"下拉框显示不全"的来源），
 * 自绘弹层才能把完整清单交给用户。
 */
export function filterModelOptions(options: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...options];
  return options.filter((m) => m.toLowerCase().includes(q));
}
