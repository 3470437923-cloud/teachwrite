/**
 * 工具调度循环：验证事件序列、工具真正落盘、结果回填、错误分类、中止传播。
 *
 * 传输层用可编程替身（fakeTransport）注入固定 SSE 行，
 * 文件系统用 node 实现（tests/support/nodeFs.ts），全程不碰 Tauri。
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeFs } from "../support/nodeFs";
import { runAgent, type AgentEvent, type RunOptions, type StreamTransport } from "../../src/core/ai/agent";
import type { HttpRequest, ProviderConfig } from "../../src/core/ai/protocol";
import { BODY_WRITE_FORBIDDEN } from "../../src/core/ai/writerPolicy";
import { AI_ERRORS } from "../../src/core/ai/errors";
import { IMPLEMENTED_TOOLS } from "../../src/core/tools/spec";

const cfg: ProviderConfig = {
  baseUrl: "https://example.cn",
  apiKey: "K",
  model: "m",
  temperature: 0.8,
  useAnthropicFormat: false,
};

let root: string;
let snapshotsDir: string;
const fs = createNodeFs();

/** 可编程传输层：按调用次序吐出预设的 SSE 行 */
function fakeTransport(scripts: string[][]): { transport: StreamTransport; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  let i = 0;
  const transport: StreamTransport = {
    async stream(req, handlers) {
      requests.push(req);
      // 脚本用尽后重复最后一组（工具循环多轮时持续供给同一响应）
      const lines = scripts[Math.min(i, scripts.length - 1)];
      i++;
      for (const l of lines) handlers.onLine(l);
    },
  };
  return { transport, requests };
}

/** 一轮「模型请求单个工具调用」的 OpenAI 形态 SSE 脚本 */
function toolCallScript(callId: string, name: string, argsJson: string): string[] {
  return [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${callId}","function":{"name":"${name}"}}]}}]}`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":${JSON.stringify(argsJson)}}}]}}]}`,
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    "data: [DONE]",
  ];
}

/** 一轮「模型纯文本收尾」的 SSE 脚本（含 usage 统计块） */
function textScript(text: string): string[] {
  return [
    `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}',
    "data: [DONE]",
  ];
}

function baseOpts(transport: StreamTransport, onEvent: (e: AgentEvent) => void): RunOptions {
  return {
    cfg,
    systemPrompt: "系统",
    tools: IMPLEMENTED_TOOLS,
    messages: [],
    userText: "看看目录里有什么",
    transport,
    onEvent,
    // 重试退避置零：错误路径用例不等真实退避（生产默认 1s/3s，见 DEFAULT_RETRY_DELAYS_MS）
    retryDelaysMs: [0, 0],
    toolCtx: {
      fs,
      roots: { projectRoot: root, skillsDir: path.join(root, "..", "skills"), booksRoot: path.join(root, "..") },
      booksRoot: path.join(root, ".."),
      snapshotsDir,
      sessionId: "s1",
    },
  };
}

beforeAll(async () => {
  // 临时目录前缀属产品命名语境：deepcompose-
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "deepcompose-agent-"));
  root = path.join(base, "书");
  snapshotsDir = path.join(base, "snapshots");
  await fsp.mkdir(path.join(root, "章节内容"), { recursive: true });
  await fsp.mkdir(snapshotsDir, { recursive: true });
  await fsp.writeFile(path.join(root, "章节内容", "第1章.md"), "正文一\n", "utf8");
});

afterAll(async () => {
  await fsp.rm(path.dirname(root), { recursive: true, force: true });
});

describe("一轮工具调用后收尾", () => {
  it("事件序列与工具结果回填正确", async () => {
    const events: AgentEvent[] = [];
    const { transport, requests } = fakeTransport([
      toolCallScript("call_1", "file_read", '{"operation":"list","path":"章节内容"}'),
      textScript("目录里有第1章.md"),
    ]);

    const res = await runAgent(baseOpts(transport, (e) => events.push(e)));
    expect(res.error).toBeUndefined();

    // 事件序列骨架：run_started 开头、run_completed 收尾，中间含工具三事件与正文开始
    const kinds = events.map((e) => e.type);
    expect(kinds[0]).toBe("run_started");
    expect(kinds).toContain("tool_calls_received");
    expect(kinds).toContain("tool_started");
    expect(kinds).toContain("tool_completed");
    expect(kinds).toContain("text_started");
    expect(kinds[kinds.length - 1]).toBe("run_completed");

    // assistant 消息带 toolCalls 且 result 是真实工具结果
    const assistant = res.added.find((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0)!;
    const call = assistant.toolCalls![0];
    expect(call.name).toBe("file_read");
    expect(call.callId).toBe("call_1");
    const parsed = JSON.parse(call.result!) as { files: { name: string }[] };
    expect(parsed.files[0].name).toBe("第1章.md");

    // 第二轮请求把工具结果带回去了
    expect(requests).toHaveLength(2);
    const msgs2 = (requests[1].body as Record<string, unknown>).messages as Record<string, unknown>[];
    expect(msgs2.some((m) => m.role === "tool")).toBe(true);

    // 最终文本
    const last = res.added[res.added.length - 1];
    expect(last.text).toBe("目录里有第1章.md");
  });

  it("text_delta 逐字累积，thinking 单独成流", async () => {
    const events: AgentEvent[] = [];
    const { transport } = fakeTransport([
      [
        'data: {"choices":[{"delta":{"reasoning_content":"先想一下"}}]}',
        'data: {"choices":[{"delta":{"content":"甲"}}]}',
        'data: {"choices":[{"delta":{"content":"乙"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ],
    ]);
    const res = await runAgent(baseOpts(transport, (e) => events.push(e)));
    const m = res.added[res.added.length - 1];
    // 正文与思考流分开累积：text 拼 delta，thinking 拼 reasoning_content
    expect(m.text).toBe("甲乙");
    expect(m.thinking).toBe("先想一下");
    expect(events.map((e) => e.type)).toContain("thinking_started");
  });
});

describe("写入类工具真的落盘", () => {
  it("file_write 写入小说资料并留快照", async () => {
    const events: AgentEvent[] = [];
    const { transport } = fakeTransport([
      toolCallScript("call_w", "file_write", '{"operation":"write","path":"小说资料/普通资料.md","content":"资料内容"}'),
      textScript("已写入资料"),
    ]);
    const res = await runAgent(baseOpts(transport, (e) => events.push(e)));
    expect(res.error).toBeUndefined();
    // 真实写盘 + 写前快照（快照按 sessionId 落 s1.json，含相对路径与 callId）
    expect(await fsp.readFile(path.join(root, "小说资料", "普通资料.md"), "utf8")).toBe("资料内容");
    const snap = await fsp.readFile(path.join(snapshotsDir, "s1.json"), "utf8");
    expect(snap).toContain("小说资料/普通资料.md");
    expect(snap).toContain("call_w");
  });
});

describe("TeachWrite 正文工具调用经过 runAgent 仍拒绝", () => {
  const body = "章节内容/第1章.md";
  const cases: [string, string, Record<string, unknown>][] = [
    ["write", "file_write", { operation: "write", path: body, content: "替代正文" }],
    ["append", "file_write", { operation: "append", path: body, content: "续写正文" }],
    ["replace", "file_write", { operation: "replace", path: body, old_text: "正文一", new_text: "替代句" }],
    ["insert", "file_write", { operation: "insert", path: body, position: "start", new_text: "示范" }],
    ["delete_lines", "file_write", { operation: "delete_lines", path: body, start_line: 1, end_line: 1 }],
    ["delete", "file_manage", { operation: "delete", path: body }],
    ["copy into body", "file_manage", { operation: "copy", path: "小说资料/普通资料.md", new_path: body }],
    ["rename into body", "file_manage", { operation: "rename", path: "小说资料/普通资料.md", new_path: body }],
    ["rename out of body", "file_manage", { operation: "rename", path: body, new_path: "小说资料/搬出的正文.md" }],
    ["candidate", "file_write", { operation: "write", path: "待确认/候选.md", content: "候选稿" }],
  ];
  it.each(cases)("%s：拒绝结果回填模型，正文不变且无写前快照", async (_label, name, args) => {
    const snapshotsBefore = await fs.readText(path.join(snapshotsDir, "s1.json"));
    const events: AgentEvent[] = [];
    const { transport, requests } = fakeTransport([
      toolCallScript("call_forbidden", name, JSON.stringify(args)),
      textScript("只提供问题、依据、影响与方向"),
    ]);
    const options = baseOpts(transport, event => events.push(event));
    let confirmations = 0;
    options.toolCtx.confirmWrites = true;
    options.toolCtx.askQuestions = async () => { confirmations++; return [["确认"]]; };
    const result = await runAgent(options);
    expect(result.error).toBeUndefined();
    const call = result.added.flatMap(message => message.toolCalls ?? []).find(call => call.callId === "call_forbidden")!;
    expect(JSON.parse(call.result!).error).toBe(BODY_WRITE_FORBIDDEN);
    expect(events.some(event => event.type === "tool_completed")).toBe(true);
    expect(requests).toHaveLength(2);
    const messages = requests[1].body.messages as { role: string; content: string }[];
    expect(messages.some(message => message.role === "tool" && message.content.includes(BODY_WRITE_FORBIDDEN))).toBe(true);
    expect(confirmations).toBe(0);
    expect(await fs.readText(path.join(root, "章节内容", "第1章.md"))).toBe("正文一\n");
    expect(await fs.readText(path.join(root, "小说资料", "普通资料.md"))).toBe("资料内容");
    expect(await fs.exists(path.join(root, "待确认", "候选.md"))).toBe(false);
    expect(await fs.exists(path.join(root, "小说资料", "搬出的正文.md"))).toBe(false);
    expect(await fs.readText(path.join(snapshotsDir, "s1.json"))).toBe(snapshotsBefore);
  });
});

describe("截断可见性（KL-DF：撞上 max_tokens 不能装作写完了）", () => {
  /** 一轮被 max_tokens 截断的流：OpenAI 叫 length */
  function truncatedScript(): string[] {
    return [
      'data: {"choices":[{"delta":{"content":"开头部分"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":32000}}',
      "data: [DONE]",
    ];
  }

  it("OpenAI finish_reason=length → 自动续写 3 次仍截断才标 truncated（D-041）", async () => {
    const events: AgentEvent[] = [];
    const { transport, requests } = fakeTransport([truncatedScript()]);
    const res = await runAgent(baseOpts(transport, (e) => events.push(e)));
    expect(res.truncated).toBe(true);
    expect(events.some((e) => e.type === "truncated" && e.reason === "length")).toBe(true);
    // D-041：截断不再直接收尾 —— 自动续写至多 3 次（首发 + 3 程 = 4 次请求），
    // 全部仍被截断才标记；四程正文拼成同一条 assistant 消息（不是四条）
    expect(requests).toHaveLength(4);
    const last = res.added[res.added.length - 1];
    expect(last.text).toBe("开头部分".repeat(4));
  });

  it("Anthropic stop_reason=max_tokens → truncated=true", async () => {
    const anthCfg = { ...cfg, useAnthropicFormat: true };
    const events: AgentEvent[] = [];
    const { transport } = fakeTransport([
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半句"}}',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":900}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ],
    ]);
    const res = await runAgent({ ...baseOpts(transport, (e) => events.push(e)), cfg: anthCfg });
    expect(res.truncated).toBe(true);
    expect(events.some((e) => e.type === "truncated" && e.reason === "max_tokens")).toBe(true);
  });

  it("正常收尾（stop / end_turn）不标记截断", async () => {
    const { transport } = fakeTransport([textScript("写完了")]);
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(res.truncated).toBe(false);
  });
});

describe("截断自动续写（D-041）", () => {
  it("截断后自动续写：两程拼成一整条，请求带部分正文 + 合成「继续」", async () => {
    const { transport, requests } = fakeTransport([
      [
        'data: {"choices":[{"delta":{"content":"前半章"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        "data: [DONE]",
      ],
      [
        'data: {"choices":[{"delta":{"content":"后半章"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ],
    ]);
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(res.error).toBeUndefined();
    // 续写补完了就不算截断
    expect(res.truncated).toBe(false);
    expect(requests).toHaveLength(2);
    // 一整条 assistant 消息（不是两条），用户视角不间断
    expect(res.added.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(res.added[res.added.length - 1].text).toBe("前半章后半章");
    // 续写请求 = 历史 + 部分 assistant + 合成 user「继续」；合成消息不落盘
    const msgs = (requests[1].body as Record<string, unknown>).messages as Record<string, unknown>[];
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "继续" });
    expect(msgs[msgs.length - 2]).toEqual({ role: "assistant", content: "前半章" });
    expect(res.added.some((m) => m.role === "user" && m.text === "继续")).toBe(false);
  });

  it("截断但有待执行工具 → 不续写，照常执行工具进入下一回合", async () => {
    // 模型已给出完整工具调用时被截断：续写会把「继续」塞在工具配对中间，污染语义；
    // 这种回合直接执行工具。截断如实标记（用户该知道这回合被截过）
    const { transport, requests } = fakeTransport([
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c_t","function":{"name":"file_read","arguments":"{\\"operation\\":\\"list\\",\\"path\\":\\"章节内容\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        "data: [DONE]",
      ],
      textScript("读完了"),
    ]);
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(res.error).toBeUndefined();
    expect(res.truncated).toBe(true);
    expect(requests).toHaveLength(2); // 1 程截断 + 1 程工具结果回合，无续写请求
    const msgs = (requests[1].body as Record<string, unknown>).messages as Record<string, unknown>[];
    expect(msgs.some((m) => m.role === "tool")).toBe(true);
  });

  it("续写期间点「停止」：立即收尾，已拼内容保留", async () => {
    const signal = { aborted: false };
    let calls = 0;
    const transport: StreamTransport = {
      async stream(_req, handlers) {
        calls += 1;
        if (calls === 1) {
          handlers.onLine('data: {"choices":[{"delta":{"content":"前半"}}]}');
          handlers.onLine('data: {"choices":[{"delta":{},"finish_reason":"length"}]}');
          handlers.onLine("data: [DONE]");
        } else {
          // 续写流途中用户点「停止」：上游被截断，已收到的续写片段保留
          handlers.onLine('data: {"choices":[{"delta":{"content":"后半的一部分"}}]}');
          signal.aborted = true;
        }
      },
    };
    const res = await runAgent({ ...baseOpts(transport, () => {}), signal });
    expect(res.error).toBe("已中止");
    expect(calls).toBe(2); // 首发截断 + 1 程续写被中止，不再续第二程
    expect(res.added[res.added.length - 1].text).toBe("前半后半的一部分");
  });
});

describe("瞬时错误自动重试（D-042：仅空回合）", () => {
  it("429 后自动重试成功", async () => {
    const { transport, requests } = fakeTransport([["__HTTP_ERROR__429|{}"], textScript("好了")]);
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(res.error).toBeUndefined();
    expect(res.added[res.added.length - 1].text).toBe("好了");
    expect(requests).toHaveLength(2);
  });

  it("持续 429：重试 2 次后报逐字限流文案（共 3 次尝试）", async () => {
    const { transport, requests } = fakeTransport([["__HTTP_ERROR__429|{}"]]);
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(res.error).toBe(AI_ERRORS.rateLimited);
    expect(requests).toHaveLength(3);
  });

  it("400/404 不重试（配置问题重试只会原样再败一次）", async () => {
    const a = fakeTransport([['__HTTP_ERROR__400|{"error":{"message":"temperature is not supported"}}']]);
    expect((await runAgent(baseOpts(a.transport, () => {}))).error).toBe(AI_ERRORS.temperatureUnsupported);
    expect(a.requests).toHaveLength(1);
    const b = fakeTransport([["__HTTP_ERROR__404|{}"]]);
    expect((await runAgent(baseOpts(b.transport, () => {}))).error).toBe(AI_ERRORS.modelNotFound);
    expect(b.requests).toHaveLength(1);
  });

  it("已流出正文的断流不重试（已 emit 的 delta 收不回，重试会重复一份）", async () => {
    let calls = 0;
    const transport: StreamTransport = {
      async stream(_req, handlers) {
        calls += 1;
        handlers.onLine('data: {"choices":[{"delta":{"content":"半截正文"}}]}');
        handlers.onError("socket hang up");
      },
    };
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(calls).toBe(1);
    expect(res.error).toBe("socket hang up");
    expect(res.added.some((m) => m.text === "半截正文")).toBe(true);
  });

  it("重试进行中经 error 事件上浮提示（用户看得见在重试）", async () => {
    const events: AgentEvent[] = [];
    const { transport } = fakeTransport([["__HTTP_ERROR__503|{}"], textScript("恢复")]);
    const res = await runAgent(baseOpts(transport, (e) => events.push(e)));
    expect(res.error).toBeUndefined();
    expect(events.some((e) => e.type === "error" && e.message.includes("自动重试"))).toBe(true);
  });
});

describe("历史消息回放形态（D-012 + B5 实测）", () => {
  it("两种协议的请求体里都不会出现 reasoning_content（实测：不回传也 200）", async () => {
    // 实测结论（tools/ds_probe.py --only replay，deepseek-flash）：
    // 带 tools + 历史轮缺 reasoning_content → 200；补回传也是 200；零工具也是 200。
    // 因此本软件**一律不回传**历史思考内容：省 token，且不改写历史前缀（保前缀缓存）。
    const history = [
      { id: "1", role: "user" as const, text: "写一段", createdAt: "t" },
      { id: "2", role: "assistant" as const, text: "好", createdAt: "t" },
    ];
    for (const useAnthropicFormat of [false, true]) {
      const events: AgentEvent[] = [];
      const { transport, requests } = fakeTransport([textScript("继续")]);
      await runAgent({
        ...baseOpts(transport, (e) => events.push(e)),
        cfg: { ...cfg, useAnthropicFormat },
        messages: history,
      });
      const msgs = (requests[0].body as Record<string, unknown>).messages as Record<string, unknown>[];
      for (const m of msgs) {
        expect(m.reasoning_content).toBeUndefined();
        expect(m.reasoning).toBeUndefined();
      }
    }
  });
});

describe("错误路径", () => {
  it("HTTP 401 → 逐字 API Key 文案", async () => {
    const events: AgentEvent[] = [];
    // Rust 侧 http_error 折成哨兵行：__HTTP_ERROR__<status>|<body>
    const { transport } = fakeTransport([["__HTTP_ERROR__401|{\"error\":\"bad key\"}"]]);
    const res = await runAgent(baseOpts(transport, (e) => events.push(e)));
    expect(res.error).toBe(AI_ERRORS.invalidKey);
    expect(events.some((e) => e.type === "error" && e.message === AI_ERRORS.invalidKey)).toBe(true);
  });

  it("HTTP 429 → 逐字 429 文案", async () => {
    const { transport } = fakeTransport([["__HTTP_ERROR__429|{}"]]);
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(res.error).toBe(AI_ERRORS.rateLimited);
  });

  it("HTTP 400 提到 temperature → 逐字温度文案", async () => {
    const { transport } = fakeTransport([
      ['__HTTP_ERROR__400|{"error":{"message":"temperature is not supported"}}'],
    ]);
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(res.error).toBe(AI_ERRORS.temperatureUnsupported);
  });

  it("HTTP 402 → 余额不足文案（附录 A §7 官方专门列出的码）", async () => {
    const { transport } = fakeTransport([['__HTTP_ERROR__402|{"error":{"message":"Insufficient Balance"}}']]);
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(res.error).toBe(AI_ERRORS.insufficientBalance);
  });

  it("HTTP 422 → 参数无效文案；带上下文关键词时归到上下文超长", async () => {
    const a = fakeTransport([['__HTTP_ERROR__422|{"error":{"message":"invalid parameter: thinking"}}']]);
    expect((await runAgent(baseOpts(a.transport, () => {}))).error).toBe(AI_ERRORS.invalidParam);
    const b = fakeTransport([
      ['__HTTP_ERROR__422|{"error":{"message":"This model maximum context length is 65536 tokens"}}'],
    ]);
    expect((await runAgent(baseOpts(b.transport, () => {}))).error).toBe(AI_ERRORS.contextTooLong);
  });

  it("HTTP 404 → 地址/模型文案（官方错误码表里没有 404，实务上等价于地址写错）", async () => {
    const { transport } = fakeTransport([["__HTTP_ERROR__404|{}"]]);
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(res.error).toBe(AI_ERRORS.modelNotFound);
    expect(AI_ERRORS.modelNotFound).toContain("Base URL");
  });

  it("流中断 → 归类为网络类文案", async () => {
    const transport: StreamTransport = {
      async stream(_req, handlers) {
        handlers.onError("connection reset by peer");
      },
    };
    const res = await runAgent(baseOpts(transport, () => {}));
    // 归不了类的网络消息保留原文（errors.ts 的兜底语义）
    expect(res.error).toBe("connection reset by peer");
  });

  it("B12-8：断流时已解析出的工具调用要回填「未执行」（否则下一轮被序列化成空串=形似成功）", async () => {
    const transport: StreamTransport = {
      async stream(_req, handlers) {
        // 工具调用的 id/name/arguments 都齐了，流在回填结果前断掉
        for (const l of toolCallScript("c1", "file_write", '{"operation":"write","path":"a.md","content":"x"}')) {
          handlers.onLine(l);
        }
        handlers.onError("socket hang up");
      },
    };
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(res.error).toBe("socket hang up");
    const withCalls = res.added.find((m) => (m.toolCalls ?? []).length > 0);
    expect(withCalls).toBeTruthy();
    const call = withCalls!.toolCalls![0];
    expect(call.result).toBeDefined();
    expect(JSON.parse(call.result!)).toEqual({ error: "流中断，工具未执行" });
  });

  it("传输层自身抛异常 → 折算为错误结果，用户消息不丢", async () => {
    // runAgent 的全函数契约：不 reject；异常折算进 RunResult.error，added 仍含用户消息
    const transport: StreamTransport = {
      async stream() {
        throw new Error("ipc broken");
      },
    };
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(res.error).toBe("ipc broken");
    expect(res.added.some((m) => m.role === "user" && m.text === "看看目录里有什么")).toBe(true);
  });

  it("工具轮次超上限时停止", async () => {
    // 脚本只有一组且用尽后重复：模型每轮都请求工具，循环必然打满上限
    const { transport } = fakeTransport([toolCallScript("c", "file_read", '{"operation":"list","path":"."}')]);
    const opts = baseOpts(transport, () => {});
    opts.maxToolRounds = 3;
    const res = await runAgent(opts);
    // B12-8：轮次上限的失败文案**只有一份** —— emit 与 RunResult.error 同源
    // （旧实现各写一句，界面按事件先后覆盖 chatError，用户看到的措辞会漂）
    expect(res.error).toBe("工具调用轮次超过上限（3），已停止");
  });
});

describe("中止传播（「停止生成」语义）", () => {
  it("流被截断后：不执行工具、保留部分正文、未执行调用回填中止说明", async () => {
    const events: AgentEvent[] = [];
    const signal = { aborted: false };
    // 传输替身：吐半截正文 + 一个 file_write 调用后置位 aborted，
    // 模拟用户点「停止」→ Rust 截断上游 → 照常发 done 收尾
    const transport: StreamTransport = {
      async stream(_req, handlers) {
        handlers.onLine('data: {"choices":[{"delta":{"content":"写了一半"}}]}');
        handlers.onLine(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c_abort","function":{"name":"file_write","arguments":"{\\"operation\\":\\"write\\",\\"path\\":\\"小说资料/中止不应写入.md\\",\\"content\\":\\"不该出现\\"}"}}]}}]}',
        );
        signal.aborted = true;
      },
    };
    const opts = baseOpts(transport, (e) => events.push(e));
    opts.signal = signal;

    const res = await runAgent(opts);
    expect(res.error).toBe("已中止");

    // 部分正文保留入库（「停止」截断流，不丢已收内容）
    const assistant = res.added[res.added.length - 1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.text).toBe("写了一半");

    // 目标为允许维护的资料文件：必须由中止机制阻止落盘，不能靠正文禁写策略兜底
    await expect(fsp.readFile(path.join(root, "小说资料", "中止不应写入.md"), "utf8")).rejects.toThrow();

    // 未执行的调用回填了中止说明（会话里每条 toolCalls 都有 result，下轮请求可配对）
    expect(assistant.toolCalls![0].result).toContain("已中止");

    // 从未进入工具执行（无 tool_started），错误事件已发
    expect(events.some((e) => e.type === "tool_started")).toBe(false);
    expect(events.some((e) => e.type === "error" && e.message === "已中止")).toBe(true);
  });

  it("工具执行期间中止：同轮剩余调用不再执行", async () => {
    const events: AgentEvent[] = [];
    const signal = { aborted: false };
    // 一轮里请求两个工具调用（index 0 / 1）
    const { transport } = fakeTransport([
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"file_read","arguments":"{\\"operation\\":\\"list\\",\\"path\\":\\".\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"file_read","arguments":"{\\"operation\\":\\"list\\",\\"path\\":\\"章节内容\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ],
    ]);
    const opts = baseOpts(transport, (e) => {
      events.push(e);
      // 模拟：第一个工具执行完（例如 question 弹窗刚被回答）时用户点了「停止」
      if (e.type === "tool_completed" && e.call.callId === "c1") signal.aborted = true;
    });
    opts.signal = signal;

    const res = await runAgent(opts);
    expect(res.error).toBe("已中止");

    const assistant = res.added[res.added.length - 1];
    const calls = assistant.toolCalls!;
    expect(calls).toHaveLength(2);
    // 第一个调用已真实执行（有目录清单结果）；第二个未执行，回填中止说明
    expect(JSON.parse(calls[0].result!).files).toBeDefined();
    expect(calls[1].result).toContain("已中止");
    // 只执行了一个工具
    expect(events.filter((e) => e.type === "tool_started")).toHaveLength(1);
  });
});

describe("用量合计（token 统计的数据源）", () => {
  it("OpenAI：回合内后值覆盖前值，跨回合求和", async () => {
    const events: AgentEvent[] = [];
    // 第一轮工具调用（无 usage）+ 第二轮文本收尾（同一回合内上报两次）
    const { transport } = fakeTransport([
      toolCallScript("call_1", "file_read", '{"operation":"list","path":"章节内容"}'),
      [
        'data: {"choices":[{"delta":{"content":"好了"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5}}',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ],
    ]);
    const res = await runAgent(baseOpts(transport, (e) => events.push(e)));
    expect(res.error).toBeUndefined();
    // 是 100/20 而不是 200/25：回合内是「快照覆盖」语义
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheHitTokens: 80, cacheMissTokens: 20 });
    // 界面收到的 usage 事件同样是回合累计快照，不会翻倍
    const usageEvents = events.filter((e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage");
    expect(usageEvents.map((e) => e.outputTokens)).toEqual([5, 20]);
  });

  it("Anthropic：message_delta 的累计输出不会被重复累加（KL-AI-02 回归锁）", async () => {
    const { transport } = fakeTransport([
      [
        "event: message_start",
        'data: {"message":{"usage":{"input_tokens":120,"output_tokens":1}}}',
        "event: content_block_delta",
        'data: {"delta":{"type":"text_delta","text":"甲"}}',
        "event: message_delta",
        'data: {"usage":{"output_tokens":30},"delta":{"stop_reason":"end_turn"}}',
        "event: message_delta",
        'data: {"usage":{"output_tokens":48},"delta":{"stop_reason":"end_turn"}}',
        "event: message_stop",
        "data: {}",
      ],
    ]);
    const opts = baseOpts(transport, () => {});
    opts.cfg = { ...cfg, useAnthropicFormat: true };
    const res = await runAgent(opts);
    expect(res.error).toBeUndefined();
    // 输入 120（不是 0，也不是 240）、输出 48（不是 79、也不是 1+30+48）
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 48, cacheHitTokens: 0, cacheMissTokens: 0 });
  });

  it("报错的回合也计入已产生的用量（上游照实计费）", async () => {
    const { transport } = fakeTransport([
      ['data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":2}}', "__HTTP_ERROR__429|{\"error\":1}"],
    ]);
    const opts = baseOpts(transport, () => {});
    // 本用例锁定「单次失败回合的用量计入」：关掉重试，否则同一脚本会按重试次数重复计费
    opts.retryDelaysMs = [];
    const res = await runAgent(opts);
    expect(res.error).toBeTruthy();
    expect(res.usage.inputTokens).toBe(40);
    expect(res.usage.outputTokens).toBe(2);
  });

  it("上游没给用量时合计全零（不编造数据）", async () => {
    const { transport } = fakeTransport([["data: [DONE]"]]);
    const res = await runAgent(baseOpts(transport, () => {}));
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 });
  });
});
