/**
 * 双协议请求构造与 SSE 解析（实测样本实证）。
 *
 * 锁定的契约：
 *  - 端点拼接（/v1 后缀两种习惯都兼容）与鉴权头（Bearer vs x-api-key + 版本头）；
 *  - OpenAI 形态：system 首条消息、tool_calls 展开 + tool 结果消息、stream_options；
 *  - Anthropic 形态：system 顶层字段、tool_use/tool_result 块、max_tokens 默认 128000（D-040）；
 *  - SSE：event:/data: 行解析、[DONE]、工具调用分片按 index 归并、
 *    Anthropic event 行缺失时回退 data JSON 的 type 字段。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TOKENS,
  StreamParser,
  anthropicUrl,
  buildRequest,
  isTruncatedReason,
  mapAnthropicEvent,
  mapOpenAiChunk,
  openAiUrl,
  parseSseLine,
  type ChatMessage,
  type ProviderConfig,
} from "../../src/core/ai/protocol";

const openaiCfg: ProviderConfig = {
  baseUrl: "https://newapi.example.cn",
  apiKey: "K",
  model: "deepseek-v4-pro",
  temperature: 0.8,
  useAnthropicFormat: false,
};

const anthropicCfg: ProviderConfig = {
  ...openaiCfg,
  baseUrl: "https://api.anthropic.com",
  useAnthropicFormat: true,
};

const msgs: ChatMessage[] = [
  { id: "1", role: "user", text: "写第一章", createdAt: "2026-01-01T00:00:00.000000" },
];

describe("思考参数（附录 A §2）", () => {
  it("OpenAI：开启时发 thinking.type=enabled + reasoning_effort", () => {
    const b = buildRequest({ ...openaiCfg, thinking: true, reasoningEffort: "max" }, msgs, [], "").body as Record<
      string,
      unknown
    >;
    expect(b.thinking).toEqual({ type: "enabled" });
    expect(b.reasoning_effort).toBe("max");
  });

  it("OpenAI：关闭时只发 thinking.type=disabled，不发 reasoning_effort", () => {
    const b = buildRequest({ ...openaiCfg, thinking: false, reasoningEffort: "max" }, msgs, [], "").body as Record<
      string,
      unknown
    >;
    expect(b.thinking).toEqual({ type: "disabled" });
    expect(b.reasoning_effort).toBeUndefined();
  });

  it("OpenAI：thinking 缺省（不支持的平台）时请求体里完全没有这两个字段", () => {
    const b = buildRequest({ ...openaiCfg }, msgs, [], "").body as Record<string, unknown>;
    expect(b.thinking).toBeUndefined();
    expect(b.reasoning_effort).toBeUndefined();
  });

  it("OpenAI：开启但未给档位时回落官方默认 high", () => {
    const b = buildRequest({ ...openaiCfg, thinking: true }, msgs, [], "").body as Record<string, unknown>;
    expect(b.reasoning_effort).toBe("high");
  });

  it("Anthropic：开关是 thinking.type，档位是 output_config.effort（B5 真实 Key 实测结论）", () => {
    // 实测：reasoning.effort="none" 关不掉思考（响应仍有 thinking_delta），
    // 而 thinking:{type:"disabled"} 的 thinking_delta 数为 0 → 开关只能是前者。
    const on = buildRequest({ ...anthropicCfg, thinking: true, reasoningEffort: "low" }, msgs, [], "").body as Record<
      string,
      unknown
    >;
    expect(on.thinking).toEqual({ type: "enabled" });
    expect(on.output_config).toEqual({ effort: "low" });
    expect(on.reasoning).toBeUndefined();
    const off = buildRequest({ ...anthropicCfg, thinking: false, reasoningEffort: "max" }, msgs, [], "").body as Record<
      string,
      unknown
    >;
    expect(off.thinking).toEqual({ type: "disabled" });
    expect(off.output_config).toBeUndefined();
    const absent = buildRequest({ ...anthropicCfg }, msgs, [], "").body as Record<string, unknown>;
    expect(absent.thinking).toBeUndefined();
    expect(absent.reasoning).toBeUndefined();
    expect(absent.output_config).toBeUndefined();
  });

  it("Anthropic：开启但未给档位时回落官方默认 high", () => {
    const b = buildRequest({ ...anthropicCfg, thinking: true }, msgs, [], "").body as Record<string, unknown>;
    expect(b.output_config).toEqual({ effort: "high" });
  });
});

describe("usage 缓存字段（B5 真实响应形态）", () => {
  it("OpenAI：prompt_cache_hit/miss_tokens 优先（实测两套字段同发）", () => {
    const ev = mapOpenAiChunk({
      choices: [],
      usage: {
        prompt_tokens: 2287,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 2048 },
        prompt_cache_hit_tokens: 2048,
        prompt_cache_miss_tokens: 239,
      },
    });
    const u = ev.find((e) => e.type === "usage") as Extract<ReturnType<typeof mapOpenAiChunk>[number], { type: "usage" }>;
    expect(u.inputTokens).toBe(2287);
    expect(u.cacheHitTokens).toBe(2048);
    expect(u.cacheMissTokens).toBe(239);
  });

  it("OpenAI：只有 prompt_tokens_details.cached_tokens 时兜底，未命中数由总数推得", () => {
    const ev = mapOpenAiChunk({
      choices: [],
      usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 768 } },
    });
    const u = ev.find((e) => e.type === "usage") as Extract<ReturnType<typeof mapOpenAiChunk>[number], { type: "usage" }>;
    expect(u.cacheHitTokens).toBe(768);
    expect(u.cacheMissTokens).toBe(232);
  });

  it("OpenAI：完全没有缓存字段时不凭空造数（缓存命中率显示为未知）", () => {
    const ev = mapOpenAiChunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } });
    const u = ev.find((e) => e.type === "usage") as Extract<ReturnType<typeof mapOpenAiChunk>[number], { type: "usage" }>;
    expect(u.cacheHitTokens).toBeUndefined();
    expect(u.cacheMissTokens).toBeUndefined();
  });

  it("Anthropic：读过缓存 → 命中数取 cache_read_input_tokens，未命中 = 未读缓存的那部分输入", () => {
    const ev = mapAnthropicEvent("message_start", {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 67,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 512,
          output_tokens: 1,
        },
      },
    });
    const u = ev[0] as Extract<ReturnType<typeof mapAnthropicEvent>[number], { type: "usage" }>;
    expect(u.type).toBe("usage");
    // Anthropic 口径：input_tokens 不含缓存读写，真实输入总数 = 67 + 0 + 512 = 579
    // （回归锁：命中 + 未命中 必须等于输入总数，曾只报 67 导致缓存命中越多输入越少计）
    expect(u.inputTokens).toBe(579);
    expect(u.cacheHitTokens).toBe(512);
    expect(u.cacheMissTokens).toBe(67);
    expect(u.cacheHitTokens! + u.cacheMissTokens!).toBe(u.inputTokens);
  });
});

describe("SSE 行过滤与截断标记", () => {
  it("注释行 / 空行 / retry: 行一律不产生事件（`: keep-alive` 不会污染 data）", () => {
    expect(parseSseLine(": keep-alive")).toBeNull();
    expect(parseSseLine("")).toBeNull();
    expect(parseSseLine("retry: 3000")).toBeNull();
    expect(parseSseLine(":")).toBeNull();
    expect(parseSseLine("event: ping")).toEqual({ event: "ping" });
    expect(parseSseLine("data: {}")).toEqual({ data: "{}" });
  });

  it("喂进完整流（含注释行）后事件序列不变", () => {
    const p = new StreamParser(false);
    const got = [
      ...p.feed(": keep-alive"),
      ...p.feed(""),
      ...p.feed('data: {"choices":[{"delta":{"content":"好"}}]}'),
      ...p.feed(": keep-alive"),
      ...p.feed("data: [DONE]"),
    ];
    expect(got.map((e) => e.type)).toEqual(["text_delta", "stop"]);
  });

  it("两种协议的截断叫法都认（length / max_tokens）", () => {
    expect(isTruncatedReason("length")).toBe(true);
    expect(isTruncatedReason("max_tokens")).toBe(true);
    expect(isTruncatedReason("stop")).toBe(false);
    expect(isTruncatedReason("end_turn")).toBe(false);
    expect(isTruncatedReason("tool_calls")).toBe(false);
  });
});

describe("端点拼接", () => {
  it("OpenAI：<base>/v1/chat/completions；base 已带 /v1 时不重复", () => {
    expect(openAiUrl("https://newapi.example.cn")).toBe("https://newapi.example.cn/v1/chat/completions");
    expect(openAiUrl("https://newapi.example.cn/")).toBe("https://newapi.example.cn/v1/chat/completions");
    expect(openAiUrl("https://x.cn/v1")).toBe("https://x.cn/v1/chat/completions");
  });

  it("Anthropic：/v1/messages，或 base 已含 /v1 时 /messages", () => {
    expect(anthropicUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages");
    // 中转站常见的子路径形态（/anthropic）同样只在末尾补一次 /v1
    expect(anthropicUrl("https://api.deepseek.com/anthropic")).toBe(
      "https://api.deepseek.com/anthropic/v1/messages",
    );
    expect(anthropicUrl("https://api.deepseek.com/anthropic/v1")).toBe(
      "https://api.deepseek.com/anthropic/v1/messages",
    );
  });
});

describe("OpenAI 请求体", () => {
  const req = buildRequest(openaiCfg, msgs, [], "系统提示");

  it("鉴权用 authorization: Bearer", () => {
    expect(req.headers.authorization).toBe("Bearer K");
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("system 提示作为首条消息；包含 temperature / stream / usage 选项", () => {
    const b = req.body as Record<string, unknown>;
    expect(b.model).toBe("deepseek-v4-pro");
    expect(b.temperature).toBe(0.8);
    expect(b.stream).toBe(true);
    expect(b.stream_options).toEqual({ include_usage: true });
    const list = b.messages as Record<string, unknown>[];
    expect(list[0]).toEqual({ role: "system", content: "系统提示" });
    expect(list[1]).toEqual({ role: "user", content: "写第一章" });
  });

  it("工具转成 function 形态", () => {
    const r2 = buildRequest(
      openaiCfg,
      msgs,
      [{ name: "file_read", description: "d", parameters: { type: "object", properties: {} } }],
      "",
    );
    const tools = (r2.body as Record<string, unknown>).tools as Record<string, unknown>[];
    expect(tools[0].type).toBe("function");
    expect((tools[0].function as Record<string, unknown>).name).toBe("file_read");
  });

  it("assistant 的 toolCalls 展开为 tool_calls + 后续 tool 消息", () => {
    // 历史回放契约：每个 tool_call 必须紧跟一条同 id 的 role:"tool" 结果消息
    const withTools: ChatMessage[] = [
      {
        id: "a",
        role: "assistant",
        text: "",
        createdAt: "t",
        toolCalls: [{ callId: "call_1", name: "file_read", arguments: '{"operation":"list"}', result: '{"ok":1}' }],
      },
    ];
    const r = buildRequest(openaiCfg, withTools, [], "");
    const list = (r.body as Record<string, unknown>).messages as Record<string, unknown>[];
    expect(list[0].role).toBe("assistant");
    expect((list[0].tool_calls as Record<string, unknown>[])[0]).toMatchObject({
      id: "call_1",
      type: "function",
    });
    expect(list[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"ok":1}' });
  });

  it("空回合（仅思考、无正文无工具调用）不进请求体 —— DeepSeek 会整轮 400（实测）", () => {
    // 实测缺陷：会话 123a86e8… 第 12 条是 thinking-only 的 assistant，
    // 旧写法序列化成 {role:"assistant", content:null}（无 tool_calls），
    // 上游返回 400 invalid_request_error: "Invalid assistant message:
    // content or tool_calls must be set"，之后该会话每次发送都失败。
    const history: ChatMessage[] = [
      { id: "u1", role: "user", text: "采用并回写", createdAt: "t" },
      { id: "a1", role: "assistant", text: "", thinking: "想了很多但没输出", createdAt: "t" },
      { id: "u2", role: "user", text: "继续", createdAt: "t" },
    ];
    const r = buildRequest(openaiCfg, history, [], "");
    const list = (r.body as Record<string, unknown>).messages as Record<string, unknown>[];
    // 空回合被整条丢掉：请求里既不出现它，也没有任何 content:null 的 assistant
    expect(list.map((m) => m.role)).toEqual(["user", "user"]);
    expect(list.some((m) => m.role === "assistant" && m.content === null && m.tool_calls === undefined)).toBe(false);
    // 正文非空、或带工具调用的 assistant 照常保留（不是"把 assistant 全丢了"）
    const keep: ChatMessage[] = [
      { id: "a2", role: "assistant", text: "已回写第41章", createdAt: "t" },
      {
        id: "a3",
        role: "assistant",
        text: "",
        createdAt: "t",
        toolCalls: [{ callId: "c1", name: "file_write", arguments: "{}", result: "{}" }],
      },
    ];
    const r2 = buildRequest(openaiCfg, keep, [], "");
    const list2 = (r2.body as Record<string, unknown>).messages as Record<string, unknown>[];
    expect(list2.map((m) => m.role)).toEqual(["assistant", "assistant", "tool"]);
  });
});

describe("Anthropic 请求体", () => {
  const req = buildRequest(anthropicCfg, msgs, [], "系统提示");

  it("鉴权用 x-api-key + anthropic-version", () => {
    expect(req.headers["x-api-key"]).toBe("K");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers.authorization).toBeUndefined();
  });

  it("system 走顶层字段；max_tokens 默认 128K（D-040）", () => {
    const b = req.body as Record<string, unknown>;
    expect(b.system).toBe("系统提示");
    expect(b.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(b.max_tokens).toBe(128000);
    // system 不再出现在 messages 里（顶层字段唯一）
    const list = b.messages as Record<string, unknown>[];
    expect(list.some((m) => m.role === "system")).toBe(false);
  });

  it("工具转成 input_schema 形态", () => {
    const r2 = buildRequest(
      anthropicCfg,
      msgs,
      [{ name: "file_write", description: "d", parameters: { type: "object", properties: {} } }],
      "",
    );
    const tools = (r2.body as Record<string, unknown>).tools as Record<string, unknown>[];
    expect(tools[0].name).toBe("file_write");
    expect(tools[0].input_schema).toBeDefined();
  });

  it("assistant 的 toolCalls 转 tool_use + tool_result(user)", () => {
    // Anthropic 历史回放契约：tool_use 块在 assistant 消息里，
    // 结果作为紧随其后的 user 消息（tool_result 块），id 一一配对
    const withTools: ChatMessage[] = [
      {
        id: "a",
        role: "assistant",
        text: "先看看目录",
        createdAt: "t",
        toolCalls: [{ callId: "toolu_1", name: "file_read", arguments: '{"path":"."}', result: '{"files":[]}' }],
      },
    ];
    const r = buildRequest(anthropicCfg, withTools, [], "");
    const list = (r.body as Record<string, unknown>).messages as Record<string, unknown>[];
    const first = list[0].content as Record<string, unknown>[];
    expect(first[0]).toEqual({ type: "text", text: "先看看目录" });
    expect(first[1]).toMatchObject({ type: "tool_use", id: "toolu_1", name: "file_read" });
    const second = list[1].content as Record<string, unknown>[];
    expect(second[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
  });

  it("空回合（仅思考）同样不进 Anthropic 请求体 —— 空 text 块会被拒", () => {
    const history: ChatMessage[] = [
      { id: "u1", role: "user", text: "继续", createdAt: "t" },
      { id: "a1", role: "assistant", text: "", thinking: "只有思考", createdAt: "t" },
    ];
    const r = buildRequest(anthropicCfg, history, [], "");
    const list = (r.body as Record<string, unknown>).messages as Record<string, unknown>[];
    expect(list.map((m) => m.role)).toEqual(["user"]);
    // 不留形如 {type:"text", text:""} 的空块
    expect(
      list.some((m) => Array.isArray(m.content) && (m.content as Record<string, unknown>[]).some((b) => b.type === "text" && b.text === "")),
    ).toBe(false);
  });
});

describe("SSE 行解析", () => {
  it("识别 event: 与 data:，忽略其余行", () => {
    expect(parseSseLine("event: content_block_delta")).toEqual({ event: "content_block_delta" });
    expect(parseSseLine("data: {\"a\":1}")).toEqual({ data: '{"a":1}' });
    // 心跳注释行与空行（事件边界）都被忽略
    expect(parseSseLine(": heartbeat")).toBeNull();
    expect(parseSseLine("")).toBeNull();
  });

  it("OpenAI：文本增量 / 思考增量 / 工具调用分片 / usage", () => {
    expect(mapOpenAiChunk({ choices: [{ delta: { content: "你好" } }] })).toEqual([
      { type: "text_delta", text: "你好" },
    ]);
    // reasoning_content（DeepSeek 系字段）→ thinking_delta
    expect(mapOpenAiChunk({ choices: [{ delta: { reasoning_content: "想…" } }] })).toEqual([
      { type: "thinking_delta", text: "想…" },
    ]);
    expect(
      mapOpenAiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "file_read", arguments: '{"op' } }] } }] }),
    ).toEqual([{ type: "tool_call_delta", index: 0, id: "c1", name: "file_read", argsDelta: '{"op' }]);
    // usage 统计块（choices 为空）也要放行
    expect(mapOpenAiChunk({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } })).toEqual([
      { type: "usage", inputTokens: 12, outputTokens: 7 },
    ]);
    // DeepSeek 的磁盘缓存字段一并上报（附录 A §6）
    expect(
      mapOpenAiChunk({
        choices: [],
        usage: { prompt_tokens: 30, completion_tokens: 4, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 10 },
      }),
    ).toEqual([{ type: "usage", inputTokens: 30, outputTokens: 4, cacheHitTokens: 20, cacheMissTokens: 10 }]);
    // 残缺 usage 只发上游真给了的字段：按 0 补齐会把先前拿到的值抹掉
    expect(mapOpenAiChunk({ choices: [], usage: { completion_tokens: 9 } })).toEqual([{ type: "usage", outputTokens: 9 }]);
    expect(mapOpenAiChunk({ choices: [], usage: {} })).toEqual([]);
  });

  it("Anthropic：用量分两次上报且不回填 0（回归锁 KL-AI-02）", () => {
    // message_start 只给输入 token：其中的 output_tokens 是占位值（通常为 1），不能当真实输出
    expect(
      mapAnthropicEvent("message_start", { message: { usage: { input_tokens: 120, output_tokens: 1 } } }),
    ).toEqual([{ type: "usage", inputTokens: 120 }]);
    // message_delta 的 output_tokens 是全消息累计值；不能再附带 inputTokens: 0
    expect(
      mapAnthropicEvent("message_delta", { usage: { output_tokens: 250 }, delta: { stop_reason: "end_turn" } }),
    ).toEqual([{ type: "usage", outputTokens: 250 }, { type: "stop", reason: "end_turn" }]);
  });

  it("Anthropic：content_block_delta 的 text/thinking/input_json", () => {
    expect(
      mapAnthropicEvent("content_block_delta", { delta: { type: "text_delta", text: "甲" } }),
    ).toEqual([{ type: "text_delta", text: "甲" }]);
    expect(
      mapAnthropicEvent("content_block_delta", { delta: { type: "thinking_delta", thinking: "乙" } }),
    ).toEqual([{ type: "thinking_delta", text: "乙" }]);
    expect(
      mapAnthropicEvent("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "{" } }),
    ).toEqual([{ type: "tool_call_delta", index: 2, argsDelta: "{" }]);
  });
});

describe("StreamParser 状态机", () => {
  it("OpenAI：累积工具调用分片并识别 [DONE]", () => {
    const p = new StreamParser(false);
    const out: unknown[] = [];
    out.push(...p.feed('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"file_read"}}]}}]}'));
    out.push(...p.feed('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\".\\"}"}}]}}]}'));
    out.push(...p.feed("data: [DONE]"));
    // 首片带 id+name、后续片带 args 片段：都按 index 归一成 tool_call_delta
    expect(out).toContainEqual({ type: "tool_call_delta", index: 0, id: "c1", name: "file_read", argsDelta: undefined });
    expect(out).toContainEqual({ type: "tool_call_delta", index: 0, id: undefined, name: undefined, argsDelta: '{"path":"."}' });
    expect(out[out.length - 1]).toEqual({ type: "stop", reason: "done" });
  });

  it("Anthropic：event 行 + data 行配对，message_stop 收尾", () => {
    const p = new StreamParser(true);
    // event: 行只进缓存不出事件；随后的 data 行配对消费
    expect(p.feed("event: content_block_delta")).toEqual([]);
    expect(p.feed('data: {"delta":{"type":"text_delta","text":"丙"}}')).toEqual([
      { type: "text_delta", text: "丙" },
    ]);
    expect(p.feed("event: message_stop")).toEqual([]);
    expect(p.feed("data: {}")).toEqual([{ type: "stop", reason: "end_turn" }]);
  });

  it("Anthropic：event 行缺失时回退 data JSON 的 type 字段（中继丢行兜底）", () => {
    // 非标准中继可能只转发 data 行；type 字段与 event 名同义（Anthropic 规范），
    // 缺了 event 行也不能整流静默丢事件
    const p = new StreamParser(true);
    expect(p.feed('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"丁"}}')).toEqual([
      { type: "text_delta", text: "丁" },
    ]);
    expect(p.feed('data: {"type":"message_stop"}')).toEqual([{ type: "stop", reason: "end_turn" }]);
  });
});
