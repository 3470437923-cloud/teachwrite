/**
 * 双协议（OpenAI 兼容 / Anthropic 兼容）的请求构造与 SSE 解析。
 *
 * 端点、鉴权与版本头（逐字）：
 *   OpenAI 格式：   /v1/chat/completions
 *   Anthropic 格式：/v1/messages 或 /messages（无 v1）
 *   鉴权：          authorization: Bearer <key>   |   x-api-key: <key>
 *   Anthropic 版本头：anthropic-version: 2023-06-01
 *   协议开关：      use_anthropic_format
 * 参数默认值：max_tokens 两种协议都发送，默认 128000（DEFAULT_MAX_TOKENS，D-040，
 *   可经 ProviderConfig.maxTokens 覆盖；上游拒绝时由 errors.ts 给出 max_tokens 文案）。
 */

import type { ReasoningEffort } from "../prefs";

/** 会话消息角色（既有落盘格式：system 只出现在请求构造里，会话文件仅存 user/assistant） */
export type Role = "system" | "user" | "assistant";

/** 一次工具调用（既有会话落盘格式：arguments/result 都是 JSON 字符串原文） */
export interface ToolCall {
  /** 上游返回的调用 id（回填 tool 结果时必须原样带回） */
  callId: string;
  name: string;
  /** 原始 JSON 字符串（与既有会话落盘格式一致） */
  arguments: string;
  /** 工具执行结果（同样为 JSON 字符串）；未执行时为 undefined */
  result?: string;
}

/** 会话消息（落盘形态，字段名与既有会话文件一致，不得改） */
export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  /** 思考流文本（reasoning/thinking 增量拼接；无则为 undefined，不写空串） */
  thinking?: string;
  toolCalls?: ToolCall[];
  /** isoMicros 格式（本地时间微秒，见 core/ids.ts） */
  createdAt: string;
}

/** 注册给模型的工具 schema（两种协议共用同一份中间形态） */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema（object 根） */
  parameters: Record<string, unknown>;
}

/** 一次对话请求所需的供应商配置（由 controller.providerOf 从 Prefs 装配） */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  useAnthropicFormat: boolean;
  /** 单次回复 max_tokens（两种协议都发送）；缺省用 DEFAULT_MAX_TOKENS（128000，D-040） */
  maxTokens?: number;
  reservedOutputTokens?: number;
  /**
   * 思考模式开关。**undefined = 请求体里完全不出现思考参数**（不支持的平台必须如此）；
   * true/false 才会写出对应协议的字段（附录 A §2）。
   */
  thinking?: boolean;
  /** 思考强度（仅 thinking === true 时有意义；缺省按官方默认 high） */
  reasoningEffort?: ReasoningEffort;
}

/** 传输层中立的请求描述（transport.ts 负责实际发出） */
export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Anthropic 版本头取值（逐字，上游契约） */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * OpenAI 格式的思考参数（附录 A §2）：
 *   开关 `thinking: {type: enabled|disabled}`；档位 `reasoning_effort: low|high|max`。
 * 关闭时**不发** reasoning_effort —— 开关关了还送档位是自相矛盾的请求体。
 */
function applyThinkingOpenAi(body: Record<string, unknown>, cfg: ProviderConfig): void {
  if (cfg.thinking === undefined) return;
  body.thinking = { type: cfg.thinking ? "enabled" : "disabled" };
  if (cfg.thinking) body.reasoning_effort = cfg.reasoningEffort ?? "high";
}

/**
 * OpenAI 格式流末尾的 usage 里，缓存字段有两套（实测同一条响应里两套都在）：
 *   `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（DeepSeek 原生）
 *   `prompt_tokens_details.cached_tokens`（OpenAI 兼容习惯；部分中继只给这个）
 * 命中数缺失时用后者兜底，未命中数则由「输入总数 − 命中数」推出。
 */
function openAiCache(usage: Record<string, unknown>): { hit?: number; miss?: number } {
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const hit =
    usage.prompt_cache_hit_tokens !== undefined
      ? num(usage.prompt_cache_hit_tokens)
      : details.cached_tokens !== undefined
        ? num(details.cached_tokens)
        : undefined;
  const miss =
    usage.prompt_cache_miss_tokens !== undefined
      ? num(usage.prompt_cache_miss_tokens)
      : hit !== undefined && usage.prompt_tokens !== undefined
        ? Math.max(0, num(usage.prompt_tokens) - hit)
        : undefined;
  return { hit, miss };
}

/**
 * Anthropic 格式的思考参数（**实测结论**，B5 真实 Key 实测，见 KNOWN-LIMITS KL-DF-05）：
 *   开关 = `thinking: {type: "enabled"|"disabled"}` —— 与 OpenAI 格式同名字段。
 *   档位 = `output_config: {effort: low|high|max}`。
 *
 * 实测过程（`tools/ds_probe.py --only anthropic/anth2`，deepseek-flash）：
 *   - `reasoning.effort: "none"` **关不掉思考**（响应里仍有 68 个 thinking_delta）→ 故不采用；
 *   - `thinking: {type: "disabled"}` → thinking_delta = 0（真正关闭）；
 *   - 不带任何思考字段 → 默认开启（733 个 thinking_delta），与附录 A §2 一致；
 *   - `output_config.effort` low vs max → 思考长度 615 vs 900（撞上限），档位有效。
 * `reasoning` 字段单独发也能通过（服务端容忍），但既然它不承担开关语义就不再发。
 */
function applyThinkingAnthropic(body: Record<string, unknown>, cfg: ProviderConfig): void {
  if (cfg.thinking === undefined) return;
  body.thinking = { type: cfg.thinking ? "enabled" : "disabled" };
  if (cfg.thinking) body.output_config = { effort: cfg.reasoningEffort ?? "high" };
}
/** max_tokens 缺省值（D-040：128K。它是上限不是目标——上游按实际产出计费，
 *  官方实测接受 384000；默认给足，让长章/长复盘一次写完，截断由 agent 的自动续写兜底） */
export const DEFAULT_MAX_TOKENS = 128000;

/** 去掉 baseUrl 末尾的连续 '/'，避免拼出 //v1 */
function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/** OpenAI 兼容端点：<base>/v1/chat/completions */
export function openAiUrl(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  // base 已带 /v1 时不再重复（用户两种填写习惯都兼容）
  if (/\/v1$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** Anthropic 兼容端点：<base>/v1/messages，或 base 已含 /v1 时 <base>/messages */
export function anthropicUrl(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  if (/\/v1$/.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

/**
 * 按 cfg.useAnthropicFormat 分派到对应协议的请求构造。
 * 契约：返回的 body 一律 stream: true；tools 为空时不带 tools 键
 * （冷读隔离依赖这一点：零工具请求体里物理上没有 tools）。
 */
export function buildRequest(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  systemPrompt: string,
): HttpRequest {
  if (cfg.useAnthropicFormat) return buildAnthropic(cfg, messages, tools, systemPrompt);
  return buildOpenAi(cfg, messages, tools, systemPrompt);
}

/**
 * OpenAI 兼容形态：system 作为首条消息；assistant.toolCalls 展开为
 * tool_calls 数组 + 每个调用一条 role:"tool" 结果消息（顺序紧随 assistant）。
 */
function buildOpenAi(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  systemPrompt: string,
): HttpRequest {
  const msgs: Record<string, unknown>[] = [];
  if (systemPrompt.trim() !== "") msgs.push({ role: "system", content: systemPrompt });

  for (const m of messages) {
    if (m.role === "assistant") {
      const toolCalls = m.toolCalls ?? [];
      // 空回合（无正文、无工具调用）**不进请求序列**：DeepSeek 会整轮拒收并返回
      // 400 invalid_request_error："Invalid assistant message: content or tool_calls
      // must be set"（旧写法把它序列化成 `content: null` 且无 tool_calls）。
      // 这种回合真实存在 —— 模型只产出思考流（正文为空）、或用户在中途点「停止」，
      // 历史里就留下一条 thinking-only 的 assistant；它会让**下一次**发送整轮失败
      // （实测：会话 123a86e8… 第 12 条即此形态，之后连续三次发送全部 400）。
      // 按 D-012 思考内容本来就不回传，跳掉它对上下文没有任何信息损失。
      if ((m.text ?? "") === "" && toolCalls.length === 0) continue;
      // 纯工具调用回合 text 为空：OpenAI 规范要求 content 为 null 而非空串
      const entry: Record<string, unknown> = { role: "assistant", content: m.text || null };
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls.map((t) => ({
          id: t.callId,
          type: "function",
          function: { name: t.name, arguments: t.arguments },
        }));
      }
      msgs.push(entry);
      // 每个 tool_call 必须有一条对应 id 的 tool 消息，否则严格上游会 400；
      // 未执行的调用（result undefined）以空串占位
      for (const t of toolCalls) {
        msgs.push({ role: "tool", tool_call_id: t.callId, content: t.result ?? "" });
      }
      continue;
    }
    msgs.push({ role: m.role, content: m.text });
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: msgs,
    temperature: cfg.temperature,
    stream: true,
    // 让上游在流末尾附带 usage 统计块（choices 为空、含 prompt/completion tokens）
    stream_options: { include_usage: true },
    max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  applyThinkingOpenAi(body, cfg);
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  return {
    url: openAiUrl(cfg.baseUrl),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body,
  };
}

/**
 * Anthropic 兼容形态：system 走顶层 system 字段；assistant.toolCalls 转
 * tool_use 块，工具结果转紧随其后的 user 消息（tool_result 块）。
 */
function buildAnthropic(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  systemPrompt: string,
): HttpRequest {
  const msgs: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // system 走顶层 system 字段
    if (m.role === "assistant") {
      const toolCalls = m.toolCalls ?? [];
      // 与 OpenAI 分支同一纪律：空回合（无正文、无工具调用）不进请求序列 ——
      // Anthropic 同样拒绝空 text 块（"text content blocks must be non-empty"），
      // 而旧写法会为它补一个 `{type:"text", text:""}` 的空块。
      if ((m.text ?? "") === "" && toolCalls.length === 0) continue;
      const blocks: Record<string, unknown>[] = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const t of toolCalls) {
        blocks.push({
          type: "tool_use",
          id: t.callId,
          name: t.name,
          // tool_use.input 是对象而非字符串；历史里存的 arguments 是 JSON 串，
          // 解析失败时以空对象兜底（不让整次请求构造抛异常）
          input: safeParse(t.arguments),
        });
      }
      // 兜底：上面的空回合已被跳过，正常路径到不了这里（保留以防将来有
      // "无 text 但有其它块类型"的形态被加进来）；Anthropic 不接受空 content 数组。
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });
      msgs.push({ role: "assistant", content: blocks });

      // 工具结果必须放在下一条 user 消息里，与 tool_use 一一配对
      const results = (m.toolCalls ?? []).map((t) => ({
        type: "tool_result",
        tool_use_id: t.callId,
        content: t.result ?? "",
      }));
      if (results.length > 0) msgs.push({ role: "user", content: results });
      continue;
    }
    msgs.push({ role: "user", content: [{ type: "text", text: m.text }] });
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: msgs,
    temperature: cfg.temperature,
    stream: true,
    max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (systemPrompt.trim() !== "") body.system = systemPrompt;
  applyThinkingAnthropic(body, cfg);
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  return {
    url: anthropicUrl(cfg.baseUrl),
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body,
  };
}

/** JSON.parse 安全版：失败回退空对象（用于历史工具参数回放） */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return {};
  }
}

// ────────────────────────────── SSE 解析 ──────────────────────────────

/**
 * 协议中立的流式内部事件（两种协议的 SSE 都归一化成这一组）：
 *  - text_delta / thinking_delta：正文与思考流增量；
 *  - tool_call_delta：工具调用分片（按 index 归并；id/name 首片携带，args 逐片拼接）；
 *  - usage：token 用量统计的**请求级快照**（OpenAI 在流末尾一次性给出；Anthropic 分
 *    message_start 输入 + message_delta 累计输出两次）——消费方只能覆盖、不能累加（KL-AI-02）；
 *  - stop：收尾信号（reason 为上游 finish_reason / stop_reason / "done"）。
 */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argsDelta?: string }
  | {
      type: "usage";
      /** 输入（prompt）token；字段缺失 = 本次事件未报告该值（Anthropic 分两次上报） */
      inputTokens?: number;
      /** 输出（completion）token；Anthropic 的 message_delta 给的是**累计值** */
      outputTokens?: number;
      /** 磁盘缓存命中的输入 token（DeepSeek 独有字段，见附录 A §6） */
      cacheHitTokens?: number;
      /** 磁盘缓存未命中的输入 token（同上） */
      cacheMissTokens?: number;
    }
  | { type: "stop"; reason: string };

/** 一行 SSE 的解析产物：event: 行给出事件名，data: 行给出负载（二者都只出现一个） */
export interface RawSse {
  event?: string;
  data?: string;
}

/** 解析一行 SSE；非 `event:`/`data:` 行返回 null（心跳注释行、空行、retry: 等一律忽略）
 *
 * 实测（B5，`tools/ds_probe.py --only keepalive`）：DeepSeek 官方流里本轮**没有**出现
 * `: keep-alive` 注释行，也没有非 event:/data: 的有效负载行；但附录 A §8 明确说流式请求
 * 会持续返回注释行，所以这里保持"白名单解析"（只有 event:/data: 才算数据），
 * 而不是"黑名单过滤"——将来上游任何新增的注释/控制行都会被自动忽略。 */
export function parseSseLine(line: string): RawSse | null {
  if (!line) return null;
  if (line.startsWith("event:")) return { event: line.slice(6).trim() };
  if (line.startsWith("data:")) return { data: line.slice(5).trim() };
  return null;
}

/**
 * 上游的收尾原因是否表示"被 max_tokens 截断"（两种协议的叫法不同）：
 * OpenAI 格式 `finish_reason: "length"`；Anthropic 格式 `stop_reason: "max_tokens"`
 * （两者都在 B5 实测中出现过）。截断必须让用户看见，否则会被误当成"模型写完了"。
 */
export function isTruncatedReason(reason: string): boolean {
  return reason === "length" || reason === "max_tokens" || reason === "max_output_tokens";
}

/** 数值安全提取：非有限数字（缺失/null/NaN）一律按 0 计 */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 提取 data JSON 里的 type 字段（Anthropic 规范中与 event: 行同义，用作中继丢行时的回退） */
function jsonTypeName(json: unknown): string | undefined {
  if (json && typeof json === "object") {
    const t = (json as Record<string, unknown>).type;
    if (typeof t === "string" && t !== "") return t;
  }
  return undefined;
}

/**
 * OpenAI 兼容流式片段 → 内部事件。
 * 兼容点：思考流字段 reasoning_content（DeepSeek 系）与 reasoning 都认；
 * usage 块（stream_options.include_usage 的末尾统计）choices 为空也要放行。
 */
export function mapOpenAiChunk(json: unknown): StreamEvent[] {
  const out: StreamEvent[] = [];
  if (!json || typeof json !== "object") return out;
  const o = json as Record<string, unknown>;

  const usage = o.usage as Record<string, unknown> | undefined;
  if (usage) {
    // 只填上游真的给了的字段：部分网关会分片上报残缺 usage，缺失字段若按 0 覆盖，
    // 会把先前已拿到的值抹掉。cache 两字段只有 DeepSeek 系会带。
    const ev: Extract<StreamEvent, { type: "usage" }> = { type: "usage" };
    if (usage.prompt_tokens !== undefined) ev.inputTokens = num(usage.prompt_tokens);
    if (usage.completion_tokens !== undefined) ev.outputTokens = num(usage.completion_tokens);
    const cache = openAiCache(usage);
    if (cache.hit !== undefined) ev.cacheHitTokens = cache.hit;
    if (cache.miss !== undefined) ev.cacheMissTokens = cache.miss;
    if (
      ev.inputTokens !== undefined ||
      ev.outputTokens !== undefined ||
      ev.cacheHitTokens !== undefined ||
      ev.cacheMissTokens !== undefined
    ) {
      out.push(ev);
    }
  }

  const choices = o.choices;
  if (!Array.isArray(choices) || choices.length === 0) return out;
  // 只消费第一个 choice（本产品单生成并发，n>1 无意义）
  const c0 = choices[0] as Record<string, unknown>;
  const delta = (c0.delta ?? {}) as Record<string, unknown>;

  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === "string" && reasoning !== "") {
    out.push({ type: "thinking_delta", text: reasoning });
  }
  if (typeof delta.content === "string" && delta.content !== "") {
    out.push({ type: "text_delta", text: delta.content });
  }

  // 工具调用是增量协议：首片带 index+id+name，后续片只带 index+arguments 片段
  const tcs = delta.tool_calls;
  if (Array.isArray(tcs)) {
    for (const raw of tcs) {
      const t = raw as Record<string, unknown>;
      const fn = (t.function ?? {}) as Record<string, unknown>;
      out.push({
        type: "tool_call_delta",
        index: num(t.index),
        id: typeof t.id === "string" ? t.id : undefined,
        name: typeof fn.name === "string" ? fn.name : undefined,
        argsDelta: typeof fn.arguments === "string" ? fn.arguments : undefined,
      });
    }
  }

  // finish_reason 出现在最后一个 choice 分片（stop/tool_calls/length 等）
  const finish = c0.finish_reason;
  if (typeof finish === "string" && finish !== "") out.push({ type: "stop", reason: finish });
  return out;
}

/**
 * Anthropic 兼容事件 → 内部事件。
 * 覆盖：content_block_start（tool_use 块头，携带 id/name）、content_block_delta
 * （text/thinking/input_json 三种增量）、message_start（输入 usage）、
 * message_delta（累计输出 usage + stop_reason）。其余事件（ping 等）忽略。
 */
export function mapAnthropicEvent(event: string | undefined, json: unknown): StreamEvent[] {
  const out: StreamEvent[] = [];
  if (!json || typeof json !== "object") return out;
  const o = json as Record<string, unknown>;

  switch (event) {
    case "content_block_start": {
      const block = (o.content_block ?? {}) as Record<string, unknown>;
      if (block.type === "tool_use") {
        out.push({
          type: "tool_call_delta",
          index: num(o.index),
          id: typeof block.id === "string" ? block.id : undefined,
          name: typeof block.name === "string" ? block.name : undefined,
        });
      }
      break;
    }
    case "content_block_delta": {
      const d = (o.delta ?? {}) as Record<string, unknown>;
      if (d.type === "text_delta" && typeof d.text === "string") {
        out.push({ type: "text_delta", text: d.text });
      } else if (d.type === "thinking_delta" && typeof d.thinking === "string") {
        out.push({ type: "thinking_delta", text: d.thinking });
      } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
        // 工具入参 JSON 的裸片段：按 index 归并后再整体 parse
        out.push({ type: "tool_call_delta", index: num(o.index), argsDelta: d.partial_json });
      }
      break;
    }
    case "message_start": {
      // 只取输入 token：此处 usage.output_tokens 是占位值（通常为 1），真正的累计输出
      // 在 message_delta 给出。旧实现把两者一起发出并让上层累加，导致输出 token 重复计数（KL-AI-02）。
      //
      // 缓存字段实测形态（B5）：`{input_tokens, cache_creation_input_tokens,
      // cache_read_input_tokens, output_tokens, service_tier}` —— 用 Anthropic 原生的
      // 「读缓存」语义映射到我们的命中数；未命中数 = 非读缓存的那部分输入
      // （input_tokens + cache_creation），与 OpenAI 侧「命中 + 未命中 = 输入总数」口径一致。
      const msg = (o.message ?? {}) as Record<string, unknown>;
      const usage = (msg.usage ?? {}) as Record<string, unknown>;
      const ev: Extract<StreamEvent, { type: "usage" }> = { type: "usage" };
      // Anthropic 口径：input_tokens **不含**缓存读写两部分，真实输入总数
      // = input_tokens + cache_creation + cache_read（上游按这个总量计费）。
      // 只报 input_tokens 会让「命中 + 未命中 ≠ 输入总数」，缓存命中越多输入少计越多。
      const cacheRead = num(usage.cache_read_input_tokens);
      const cacheCreation = num(usage.cache_creation_input_tokens);
      if (usage.input_tokens !== undefined) {
        ev.inputTokens = num(usage.input_tokens) + cacheCreation + cacheRead;
      }
      if (usage.cache_read_input_tokens !== undefined) {
        ev.cacheHitTokens = cacheRead;
        ev.cacheMissTokens = num(usage.input_tokens) + cacheCreation;
      }
      if (ev.inputTokens !== undefined || ev.cacheHitTokens !== undefined) out.push(ev);
      break;
    }
    case "message_delta": {
      // message_delta 的 output_tokens 是全消息累计值（非增量）
      const usage = (o.usage ?? {}) as Record<string, unknown>;
      if (usage.output_tokens !== undefined) {
        // 不再附带 inputTokens: 0 —— 那会让上层把已拿到的输入 token 覆盖成 0
        out.push({ type: "usage", outputTokens: num(usage.output_tokens) });
      }
      const d = (o.delta ?? {}) as Record<string, unknown>;
      if (typeof d.stop_reason === "string" && d.stop_reason !== "") {
        out.push({ type: "stop", reason: d.stop_reason });
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * 流式状态机：喂 SSE 行，吐内部事件（协议由构造参数决定）。
 *
 * 契约与边界：
 *  - 逐行喂入（Rust 侧按 '\n' 切好，UTF-8 完整字符由 Rust 缓冲保证）；
 *  - `data: [DONE]`（OpenAI 习惯）→ stop/done；Anthropic 的 message_stop → stop/end_turn；
 *  - 每条 data 行按「单行完整 JSON」解析（两大协议实际都这么发）；解析失败静默跳过该行；
 *  - Anthropic 的 event: 行与 data 行配对缓存在 buffer 里；部分中继只发 data 不发
 *    event: 行，此时回退用 data JSON 的 type 字段（规范中二者同义），避免整流静默丢事件；
 *  - 真正的流结束以传输层的 done 信号为准（agent 不依赖 stop 事件收尾）。
 */
export class StreamParser {
  /** 暂存最近一条 event: 行（Anthropic 事件名与随后的 data 行配对） */
  private buffer: RawSse = {};
  /** 原始行累积（仅排错用；随解析器同生命周期，回合结束即释放） */
  private raw = "";

  constructor(private useAnthropic: boolean) {}

  feed(line: string): StreamEvent[] {
    this.raw += line;
    const parsed = parseSseLine(line);
    if (parsed === null) return [];
    if (parsed.event !== undefined) this.buffer.event = parsed.event;
    if (parsed.data === undefined) return [];
    const data = parsed.data;
    if (data === "[DONE]") return [{ type: "stop", reason: "done" }];

    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      // 半截 JSON / 非 JSON 负载：跳过（上游偶发脏行不应中断整流）
      return [];
    }

    if (!this.useAnthropic) {
      const evts = mapOpenAiChunk(json);
      // OpenAI 的单条消息可能同时携带 stop；保持原样返回
      if (evts.some((e) => e.type === "stop")) this.buffer = {};
      return evts;
    }

    // Anthropic：优先用 event: 行；中继丢行时回退 data JSON 的 type 字段
    const evtName = this.buffer.event ?? jsonTypeName(json);
    this.buffer = {};
    if (evtName === "message_stop") return [{ type: "stop", reason: "end_turn" }];
    return mapAnthropicEvent(evtName, json);
  }

  /** 原始流（排错用） */
  rawText(): string {
    return this.raw;
  }
}
