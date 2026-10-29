/**
 * 工具调度循环（agent loop）。
 *
 * 事件名逐字（既有格式，不得改）：
 *   ai_run_started / ai_tool_started / ai_tool_calls_received / ai_tool_completed /
 *   ai_text_started / ai_thinking_started / ai_cleanup_started / ai_cleanup_completed /
 *   ai_run_completed
 *
 * 循环结构（「读结构化设定 → 读最近 N 章 → 生成 → 提炼摘要 → 回写」的机制底座）：
 *   流式回合 → 若模型请求工具 → 逐个执行（写前快照）→ 结果回填 → 再开一回合，
 *   直到模型不再请求工具或达到轮次上限。
 *
 * 中止契约：signal.aborted 置位后（UI「停止生成」），已收到的部分正文保留并入库，
 * 但不再执行任何工具（写入类工具有副作用）、不再开新回合，以「已中止」错误收尾。
 */

import { isoMicros } from "../ids";
import { executeTool, type QuestionItem, type ToolContext } from "../tools/exec";
import { AI_ERRORS, classifyHttpError, classifyStreamError } from "./errors";
import {
  StreamParser,
  buildRequest,
  isTruncatedReason,
  type ChatMessage,
  type HttpRequest,
  type ProviderConfig,
  type StreamEvent,
  type ToolCall,
  type ToolSchema,
} from "./protocol";
import { ZERO_USAGE, addTotals, type UsageTotals } from "../usage/stats";

/**
 * 既有格式的逐字事件名表（wire 契约，不得改）。
 * 注意：当前实现经 onEvent 回调把 AgentEvent 交给界面，本表仅作对外契约参照；
 * cleanup_started / cleanup_completed 两个事件在现行代码里没有发射点（保留占位）。
 */
export const EVENT_NAMES = {
  runStarted: "ai_run_started",
  textStarted: "ai_text_started",
  thinkingStarted: "ai_thinking_started",
  toolCallsReceived: "ai_tool_calls_received",
  toolStarted: "ai_tool_started",
  toolCompleted: "ai_tool_completed",
  cleanupStarted: "ai_cleanup_started",
  cleanupCompleted: "ai_cleanup_completed",
  runCompleted: "ai_run_completed",
} as const;

/** 单次运行最多几轮工具调用。既有数值未取到，此为自定值。 */
export const DEFAULT_MAX_TOOL_ROUNDS = 12;

/**
 * 截断自动续写上限（D-041）：一回合以 max_tokens 截断且没有待执行工具时，
 * 自动把已流出内容随一条合成「继续」再发一程，最多续这么多次。
 * 用尽仍截断才标记 truncated（界面提示条照旧）。
 */
export const MAX_CONTINUATIONS = 3;

/** 续写用的合成用户消息文本（只进请求序列，不进落盘会话——用户没说过这句话） */
export const CONTINUE_TEXT = "继续";

/**
 * 瞬时错误的重试退避序列（D-042）：每项 = 第 N 次重试前等待的毫秒数。
 * 默认重试 2 次（共 3 次尝试）；测试注入 [0, 0] 免等待。
 */
export const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];

/**
 * 失败是否值得自动重试（D-042）：
 *  - HTTP 429 / 5xx：限流与服务端波动，重试有效；
 *  - 无状态码的网络层断流（连接重置/超时/IPC 瞬断）：重试有效；
 *  - 400/401/402/403/404/422 与「上下文超长」「Key 无效」：配置与预算问题，
 *    重试只会原样再败一次，直接报错。
 */
export function isRetryableFailure(httpStatus: number | null, message: string): boolean {
  if (httpStatus !== null) return httpStatus === 429 || httpStatus >= 500;
  if (message === AI_ERRORS.contextTooLong || message === AI_ERRORS.invalidKey) return false;
  return true;
}

/** 退避等待，100ms 粒度轮询中止信号（退避最长 3s，轮询开销可忽略） */
function sleepAbortable(ms: number, signal?: { aborted: boolean }): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const poll = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(poll);
        resolve();
      }
    }, 100);
    setTimeout(() => {
      clearInterval(poll);
      resolve();
    }, ms);
  });
}

/**
 * 面向界面的运行事件流（onEvent 回调逐条推送）：
 *  - run_started：本次运行开始（runId 供关联日志）；
 *  - thinking_started / thinking_delta：思考流开始与增量；
 *  - text_started / text_delta：正文流开始与增量；
 *  - tool_calls_received：模型本轮请求的全部工具调用（尚未执行）；
 *  - tool_started / tool_completed：单个工具执行前后（completed 时 call.result 已回填）；
 *  - usage：上游 token 用量统计（透传，可能多次）；
 *  - cleanup_started / cleanup_completed：既有契约占位，当前无发射点；
 *  - run_completed：正常收尾（message 为最终 assistant 消息）；
 *  - error：失败或中止（message 为逐字错误文案，detail 附 HTTP 状态）。
 */
export type AgentEvent =
  | { type: "run_started"; runId: string }
  | { type: "thinking_started" }
  | { type: "thinking_delta"; text: string }
  | { type: "text_started" }
  | { type: "text_delta"; text: string }
  | { type: "tool_calls_received"; calls: ToolCall[] }
  | { type: "tool_started"; call: ToolCall }
  | { type: "tool_completed"; call: ToolCall }
  | {
      type: "usage";
      /** 本回合用量快照（非增量）：上游按请求计费，回合内以最后一次上报为准 */
      inputTokens: number;
      outputTokens: number;
      /** 磁盘缓存命中/未命中的输入 token（DeepSeek 独有；其他上游恒为 0） */
      cacheHitTokens: number;
      cacheMissTokens: number;
    }
  | { type: "cleanup_started" }
  | { type: "cleanup_completed" }
  /** 本轮被 max_tokens 截断（reason 为上游原文：length / max_tokens） */
  | { type: "truncated"; reason: string }
  | { type: "run_completed"; message: ChatMessage }
  | { type: "error"; message: string; detail?: string };

/** 传输层抽象：生产走 Tauri 事件，测试注入固定 SSE 行 */
export interface StreamTransport {
  /** 返回 true 表示流正常结束；false 表示已通过 onError 报错 */
  stream(
    req: HttpRequest,
    handlers: { onLine: (line: string) => void; onError: (message: string) => void },
  ): Promise<void>;
}

/** runAgent 的输入（一次完整运行 = 用户消息 + 若干流式回合 + 工具循环） */
export interface RunOptions {
  cfg: ProviderConfig;
  systemPrompt: string;
  tools: ToolSchema[];
  /** 已有对话（不含本轮用户消息） */
  messages: ChatMessage[];
  /** 本轮用户消息 */
  userText: string;
  toolCtx: ToolContext;
  transport: StreamTransport;
  /** 工具轮次上限（缺省 DEFAULT_MAX_TOOL_ROUNDS；controller 会再钳制到 1..50） */
  maxToolRounds?: number;
  /** 瞬时错误重试的退避序列（缺省 DEFAULT_RETRY_DELAYS_MS；传 [] 关闭重试） */
  retryDelaysMs?: number[];
  onEvent?: (e: AgentEvent) => void;
  /** 中止信号（UI「停止生成」置位；轮询式，见文件头中止契约） */
  signal?: { aborted: boolean };
}

export interface RunResult {
  /** 本轮新增的全部消息（assistant + 工具结果挂在 assistant.toolCalls 上） */
  added: ChatMessage[];
  /** 失败/中止时的逐字文案；正常结束为 undefined（即使 error 存在，added 也应入库） */
  error?: string;
  /** 本次运行（含工具循环的全部回合）的用量合计：轮内快照、轮间求和 */
  usage: UsageTotals;
  /** 任一回合碰到 max_tokens 上限（界面要给出可见提示，不能装作写完了） */
  truncated: boolean;
}

/** 生成消息/运行 id：优先 crypto.randomUUID，测试环境无 crypto 时退化为时间戳随机数 */
function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `m_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

/**
 * apply() 透传给界面的事件：协议事件原样透传，外加一个**装配层**事件
 * `truncated`（收尾原因表示被 max_tokens 截断）——它不是协议词汇，
 * 但如果只当协议细节丢掉，用户就会把"写到一半停住"误当成"写完了"。
 */
type PassthroughEvent = StreamEvent | Extract<AgentEvent, { type: "truncated" }>;

/** 累积中的工具调用（流式片段拼装） */
interface PendingCall {
  index: number;
  callId: string;
  name: string;
  args: string;
}

/**
 * 把流式事件累加成一个 assistant 回合。
 * apply() 返回「需要透传给界面」的事件（tool_call_delta 与 stop 被本类消化，不透传）；
 * message() 在回合结束时产出可落盘的 ChatMessage。
 */
class TurnAccumulator {
  text = "";
  thinking = "";
  /** 按上游分片的 index 归并（两种协议的工具调用都是按 index 增量拼装） */
  calls = new Map<number, PendingCall>();
  // 用量是「请求级快照」：回合内后值覆盖前值（不能累加，见 KL-AI-02），
  // 跨回合求和由 runAgent 负责。
  inputTokens = 0;
  outputTokens = 0;
  cacheHitTokens = 0;
  cacheMissTokens = 0;
  /** 本程请求是否以 max_tokens 截断收尾（粘性标记：同一请求里随后到来的
   *  非截断收尾事件——如 Anthropic 的 message_stop——不洗掉它；每开一程新请求前清零）。
   *  续写判定只看它（D-041）。 */
  truncatedHere = false;

  /** 本回合用量快照 */
  usage(): UsageTotals {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheHitTokens: this.cacheHitTokens,
      cacheMissTokens: this.cacheMissTokens,
    };
  }

  /** 取出并清零已计用量：续写/重试是同一会话里的多个独立请求，
   *  上游按请求分别计费，必须逐段求和（覆盖语义会在续写间丢前一段的账）。 */
  takeUsage(): UsageTotals {
    const u = this.usage();
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheHitTokens = 0;
    this.cacheMissTokens = 0;
    return u;
  }

  apply(events: StreamEvent[]): PassthroughEvent[] {
    const passthrough: PassthroughEvent[] = [];
    for (const e of events) {
      switch (e.type) {
        case "text_delta":
          this.text += e.text;
          passthrough.push(e);
          break;
        case "thinking_delta":
          this.thinking += e.text;
          passthrough.push(e);
          break;
        case "tool_call_delta": {
          // 同 index 的分片合并：id/name 首片给出，args 逐片追加
          const cur = this.calls.get(e.index) ?? { index: e.index, callId: "", name: "", args: "" };
          if (e.id) cur.callId = e.id;
          if (e.name) cur.name = e.name;
          if (e.argsDelta) cur.args += e.argsDelta;
          this.calls.set(e.index, cur);
          break;
        }
        case "usage":
          // 覆盖式更新：Anthropic 的 message_delta.output_tokens 是累计值，
          // 旧实现用 `+=` 会把输出 token 累加成数倍（KL-AI-02）。
          if (e.inputTokens !== undefined) this.inputTokens = e.inputTokens;
          if (e.outputTokens !== undefined) this.outputTokens = e.outputTokens;
          if (e.cacheHitTokens !== undefined) this.cacheHitTokens = e.cacheHitTokens;
          if (e.cacheMissTokens !== undefined) this.cacheMissTokens = e.cacheMissTokens;
          // 透传给界面的是「回合累计快照」，而不是上游的原始分片
          passthrough.push({
            type: "usage",
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            cacheHitTokens: this.cacheHitTokens,
            cacheMissTokens: this.cacheMissTokens,
          });
          break;
        case "stop":
          // 收尾以传输层 done 为准，stop 仅协议信息，不透传；唯一例外是"被截断"——
          // 它必须让用户看见（length / max_tokens 两种叫法见 protocol.isTruncatedReason）
          if (isTruncatedReason(e.reason)) {
            this.truncatedHere = true;
            passthrough.push({ type: "truncated", reason: e.reason });
          }
          break;
      }
    }
    return passthrough;
  }

  /** 归并完成的工具调用（按 index 升序；无名调用视为无效分片丢弃） */
  toolCalls(): ToolCall[] {
    return [...this.calls.values()]
      .filter((c) => c.name !== "")
      .sort((a, b) => a.index - b.index)
      .map((c) => ({
        // 上游没给 id 时自造一个：assistant.tool_calls 与 tool 结果消息共用同一 id，配对仍成立
        callId: c.callId || `call_${c.index}_${Math.floor(Math.random() * 1e6)}`,
        name: c.name,
        // 空参数（模型未给或流被截断在首片前）按 {} 处理，交给 executeTool 校验必填参数
        arguments: c.args === "" ? "{}" : c.args,
      }));
  }

  /** 产出本回合的 assistant 消息（thinking 为空时不写字段，保持既有落盘形态） */
  message(): ChatMessage {
    const calls = this.toolCalls();
    const m: ChatMessage = {
      id: newId(),
      role: "assistant",
      text: this.text,
      createdAt: isoMicros(),
    };
    if (this.thinking !== "") m.thinking = this.thinking;
    if (calls.length > 0) m.toolCalls = calls;
    return m;
  }
}

/** 中止时给未执行工具调用回填的结果（与 executeTool 的 {"error":…} 形态一致） */
function abortedToolResult(): string {
  return JSON.stringify({ error: "已中止，工具未执行" });
}

/** 断流时给未执行工具调用回填的结果（B12-8：与中止路径同形态，措辞区分原因） */
function streamErrorToolResult(): string {
  return JSON.stringify({ error: "流中断，工具未执行" });
}

/**
 * 跑一轮对话（自动处理工具调用循环）。
 *
 * 全函数不 reject：传输层异常/上游错误/中止一律折算成 RunResult.error，
 * added（含用户消息与部分正文）始终返回，调用方据此落盘会话，不丢消息。
 */
export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const emit = opts.onEvent ?? (() => {});
  const added: ChatMessage[] = [];
  const maxRounds = opts.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;

  const runId = newId();
  emit({ type: "run_started", runId });

  // 本次运行的用量合计：每回合结束时把该回合快照累加进来（含报错/中止前已产生的部分）
  let usage: UsageTotals = { ...ZERO_USAGE };

  // 用户消息先行入库（即使后续失败，added 里也带着它，会话不丢用户输入）
  const userMsg: ChatMessage = {
    id: newId(),
    role: "user",
    text: opts.userText,
    createdAt: isoMicros(),
  };
  added.push(userMsg);

  let history = [...opts.messages, userMsg];
  let textStarted = false;
  let thinkingStarted = false;
  /** 木桶效应：任一回合最终以截断收尾（续写预算用尽/有工具不便续写），整轮就标记截断 */
  let truncated = false;
  const retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  /** 发一次流式请求并把事件喂给 acc；一切失败折算为返回值，本函数不抛 */
  const streamOnce = async (
    req: HttpRequest,
    acc: TurnAccumulator,
  ): Promise<{ error: string | null; status: number | null }> => {
    const parser = new StreamParser(opts.cfg.useAnthropicFormat);
    let streamError: string | null = null;
    let httpStatus: number | null = null;
    try {
      await opts.transport.stream(req, {
        onLine: (line) => {
          // Rust 侧 HTTP 错误哨兵行：__HTTP_ERROR__<status>|<body>（见 transport.ts）
          if (line.startsWith("__HTTP_ERROR__")) {
            const rest = line.slice("__HTTP_ERROR__".length);
            const sep = rest.indexOf("|");
            httpStatus = parseInt(rest.slice(0, sep), 10);
            streamError = classifyHttpError(httpStatus, rest.slice(sep + 1));
            return;
          }
          for (const e of acc.apply(parser.feed(line))) {
            if (e.type === "text_delta") {
              if (!textStarted) {
                textStarted = true;
                emit({ type: "text_started" });
              }
              emit({ type: "text_delta", text: e.text });
            } else if (e.type === "thinking_delta") {
              if (!thinkingStarted) {
                thinkingStarted = true;
                emit({ type: "thinking_started" });
              }
              emit({ type: "thinking_delta", text: e.text });
            } else if (e.type === "usage") {
              // 透传值是 apply() 补全后的「本程请求快照」：直接取累加器当前值（字段均必填）
              emit({ type: "usage", ...acc.usage() });
            } else if (e.type === "truncated") {
              emit({ type: "truncated", reason: e.reason });
            }
          }
        },
        onError: (message) => {
          streamError = classifyStreamError(message);
        },
      });
    } catch (e) {
      // 传输层自身抛异常（IPC 故障等）：折算为网络类错误，不让整个 runAgent reject，
      // 否则本轮用户消息与部分正文会随异常一起丢失（controller 拿不到 added）
      streamError = classifyStreamError(String(e instanceof Error ? e.message : e));
    }
    return { error: streamError, status: httpStatus };
  };

  for (let round = 0; round < maxRounds; round++) {
    // 每轮开头检查中止：上一轮工具执行期间用户点了「停止」时在这里收尾
    if (opts.signal?.aborted) {
      emit({ type: "error", message: "已中止" });
      return { added, error: "已中止", usage, truncated };
    }

    // ── 本回合首个请求：瞬时失败且尚未流出任何内容时自动重试（D-042）──
    // 重试只发生在「空回合」：已流出正文/思考/工具分片的断流不重试 ——
    // 已 emit 的 delta 收不回，重试会让界面与落盘各重复一份。
    let acc = new TurnAccumulator();
    let streamError: string | null = null;
    let httpStatus: number | null = null;
    for (let attempt = 0; ; attempt++) {
      const r = await streamOnce(buildRequest(opts.cfg, history, opts.tools, opts.systemPrompt), acc);
      streamError = r.error;
      httpStatus = r.status;
      // 无论成功、报错还是中止，本程已产生的用量都计入（上游按请求计费）
      usage = addTotals(usage, acc.takeUsage());
      if (streamError === null) break;
      const hasContent = acc.text !== "" || acc.thinking !== "" || acc.calls.size > 0;
      if (
        hasContent ||
        attempt >= retryDelays.length ||
        !isRetryableFailure(httpStatus, streamError) ||
        opts.signal?.aborted
      ) {
        break;
      }
      emit({
        type: "error",
        message: `请求失败（${streamError}），${Math.max(1, Math.round(retryDelays[attempt] / 1000))} 秒后自动重试（第 ${attempt + 1}/${retryDelays.length} 次）`,
      });
      await sleepAbortable(retryDelays[attempt], opts.signal);
      if (opts.signal?.aborted) break;
      acc = new TurnAccumulator();
    }

    // 中止优先：即便最后一次尝试以失败收尾，用户的意图是停
    if (opts.signal?.aborted) {
      const partial = acc.message();
      for (const c of partial.toolCalls ?? []) {
        if (c.result === undefined) c.result = abortedToolResult();
      }
      if (partial.text !== "" || partial.thinking !== undefined || partial.toolCalls !== undefined) {
        added.push(partial);
      }
      emit({ type: "error", message: "已中止" });
      return { added, error: "已中止", usage, truncated };
    }

    // ── 截断自动续写（D-041）──
    // 本回合以 max_tokens 截断、且没有待执行工具时：把已流出内容作为部分 assistant
    // 随合成「继续」再发一程，delta 继续拼进同一个 acc —— 用户看到与落盘的都是
    // 一整条不间断的消息；续写消息只进请求序列，不进会话文件。
    let continuations = 0;
    while (
      acc.truncatedHere &&
      acc.toolCalls().length === 0 &&
      continuations < MAX_CONTINUATIONS &&
      !opts.signal?.aborted
    ) {
      continuations += 1;
      const continueMsg: ChatMessage = {
        id: newId(),
        role: "user",
        text: CONTINUE_TEXT,
        createdAt: isoMicros(),
      };
      const contHistory = [...history, acc.message(), continueMsg];
      acc.truncatedHere = false; // 每开一程新请求前清零，判定只看本程
      const r = await streamOnce(buildRequest(opts.cfg, contHistory, opts.tools, opts.systemPrompt), acc);
      usage = addTotals(usage, acc.takeUsage());
      if (r.error !== null) {
        streamError = r.error;
        httpStatus = r.status;
        break;
      }
    }
    // 续写预算用尽仍截断（或有工具不便续写）：按原纪律标记，界面提示条照旧
    if (acc.truncatedHere) truncated = true;

    if (streamError !== null) {
      const msg = streamError as string;
      // 断流前已收到的部分正文/思考保留入库（与中止路径同一纪律：
      // 网络中断不是丢弃已生成内容的理由；空回合不产生空消息）
      const partial = acc.message();
      // B12-8（断流路径补回填）：本回合的 toolCalls 一个都没执行过 —— 必须像中止路径
      // 那样给它们回填结果说明。否则下一轮请求序列化时 `result ?? ""` 会把它变成
      // "工具成功返回空字符串"，模型可能据此声称"已写入/已改好"，而磁盘上什么都没发生。
      for (const c of partial.toolCalls ?? []) {
        if (c.result === undefined) c.result = streamErrorToolResult();
      }
      if (partial.text !== "" || partial.thinking !== undefined || partial.toolCalls !== undefined) {
        added.push(partial);
      }
      emit({ type: "error", message: msg, detail: httpStatus === null ? undefined : `HTTP ${httpStatus}` });
      return { added, error: msg, usage, truncated };
    }

    // 回合结束：部分正文也保留（「停止生成」的语义是截断流，不是丢弃已收内容）
    const assistant = acc.message();
    added.push(assistant);
    history = [...history, assistant];

    // 中止传播：流被截断后不再执行工具（写入类工具有副作用）、不再开新回合；
    // 未执行的调用回填中止说明，保证会话里每条 toolCalls 都有 result
    if (opts.signal?.aborted) {
      for (const c of assistant.toolCalls ?? []) {
        if (c.result === undefined) c.result = abortedToolResult();
      }
      emit({ type: "error", message: "已中止" });
      return { added, error: "已中止", usage, truncated };
    }

    const calls = assistant.toolCalls ?? [];

    if (calls.length === 0) {
      emit({ type: "run_completed", message: assistant });
      return { added, usage, truncated };
    }

    emit({ type: "tool_calls_received", calls });

    for (const call of calls) {
      // 逐个执行前再查中止：question 挂起等待用户回答期间点「停止」，
      // 同轮剩余调用不再执行（回填中止说明后收尾）
      if (opts.signal?.aborted) {
        for (const c of calls) {
          if (c.result === undefined) c.result = abortedToolResult();
        }
        emit({ type: "error", message: "已中止" });
        return { added, error: "已中止", usage, truncated };
      }
      emit({ type: "tool_started", call });
      // currentCallId 注入：写前快照按调用 id 关联（既有快照格式）
      const ctx = { ...opts.toolCtx, currentCallId: call.callId };
      let resultJson: string;
      try {
        resultJson = await executeTool(ctx, call.name, call.arguments);
      } catch (e) {
        // 工具抛异常也要回填结果：每个 tool_call 必须有配对结果，
        // 否则下一轮请求会被严格上游拒绝（模型也需要看到失败原因才能自救）
        resultJson = JSON.stringify({ error: String(e instanceof Error ? e.message : e) });
      }
      call.result = resultJson;
      emit({ type: "tool_completed", call });
    }
  }

  // 轮次耗尽：最后一轮的工具已执行并回填，但不再开新回合让模型总结。
  // B12-8：同一失败只保留**一份**文案 —— 旧实现 emit 与 return.error 各写一句，
  // 界面按事件先后覆盖 chatError，用户看到的措辞会漂；RunResult.error 的契约是"逐字文案"。
  const roundsExceeded = `工具调用轮次超过上限（${maxRounds}），已停止`;
  emit({ type: "error", message: roundsExceeded });
  return { added, error: roundsExceeded, usage, truncated };
}

/** 供界面兜底：没有可用配置时给出逐字错误 */
export function missingConfigError(): string {
  return AI_ERRORS.invalidKey;
}

export type { QuestionItem };
export { executeTool };
