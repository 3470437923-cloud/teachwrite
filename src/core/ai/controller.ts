/**
 * 对话控制器：把配置 / 目录 / 工具 / 会话串成一次可用对话。
 * 界面只需要调用 send()，把事件流渲染出来即可。
 *
 * 装配顺序（send）：系统提示词（含项目块/技能块）→ 上下文自动压缩（可选）→
 * runAgent 工具循环 → 会话落盘。压缩只影响发给 AI 的请求序列，
 * 落盘的 messages 始终是完整原始记录（会话文件不删任何消息）。
 *
 * 落盘时机：runAgent 返回后一次性 saveSession（正常/出错/中止都会落盘，
 * 因为 runAgent 保证不 reject 且 added 始终含本轮新消息）。**配置缺失**的早退路径
 * 同样把用户消息落盘（B12-8：否则界面乐观气泡被返回值替换后，刚敲的字两处皆无）。
 * saveSession 自身失败（磁盘错误）**折算成 SendResult.error**（带 usage 与截断标记），
 * 不让 promise reject —— reject 会把用量回执与截断提示一起丢掉。
 */

import type { AppDirs } from "../dirs";
import { AUTHOR_ONLY_RULES } from "./writerPolicy";
import { getFs, type FsBridge } from "../fsbridge";
import type { Prefs } from "../prefs";
import { lookupSkill } from "../skills/registry";
import type { QuestionItem } from "../tools/exec";
import { IMPLEMENTED_TOOLS } from "../tools/spec";
import { runAgent, type AgentEvent, type StreamTransport } from "./agent";
import { AI_ERRORS } from "./errors";
import { buildSystemPrompt } from "./prompt";
import { maybeCompress } from "./compress";
import type { ChatMessage, ProviderConfig } from "./protocol";
import {
  loadIndex,
  newSession,
  saveSession,
  titleFromText,
  uuid,
  type SessionFile,
} from "../store/session";
import { isoMicros } from "../ids";
import { recordUsage } from "../usage/persist";
import { ZERO_USAGE, type UsageTotals } from "../usage/stats";
import { choiceOfLevel, effectiveThinking, thinkingSupportedFor, type ThinkingLevel } from "./thinking";
import { DEFAULT_AI_MODE, toolsForMode, type AiMode } from "./mode";

/** 当前注册给模型的工具（web_search/terminal/rank_data_query 尚未实现，故不在其中） */
export const ENABLED_TOOLS = IMPLEMENTED_TOOLS.map((t) => t.name);

/** token 统计落盘（usage_stats.json，D-023）。统计是**旁路**：写失败不阻断对话主流程。 */
async function recordUsageSafe(fs: FsBridge, usageStatsFile: string, usage: UsageTotals): Promise<void> {
  try {
    await recordUsage(fs, usageStatsFile, usage);
  } catch {
    // 静默：统计文件损坏/拒绝写入都不阻断对话
  }
}

/**
 * 把本轮用户消息并进会话并派生标题（B12-8：正常路径与「配置缺失」早退路径共用）。
 * 消息 id 用 store/session 的 uuid，与界面乐观气泡同一形态。
 */
function withUserMessage(
  session: SessionFile,
  userText: string,
  projectRoot: string | null,
): SessionFile {
  const messages: ChatMessage[] = [
    ...session.messages,
    { id: uuid(), role: "user", text: userText, createdAt: isoMicros() },
  ];
  const firstUser = messages.find((m) => m.role === "user");
  const title =
    session.title.startsWith("New Chat") && firstUser
      ? titleFromText(firstUser.text) || session.title
      : session.title;
  return {
    ...session,
    title,
    projectPath: session.projectPath || projectRoot || "",
    updatedAt: isoMicros(),
    messages,
  };
}

/**
 * 从用户配置装配供应商参数；三要素（baseUrl/apiKey/model）缺一即返回 null，
 * 调用方须以 AI_ERRORS.invalidKey 逐字文案拒绝发送。
 *
 * `sessionThinking` 是**会话级临时档位**（D-011，只存内存）：显式传入则覆盖配置级默认；
 * `null`/`undefined` 都表示"按配置默认"。思考参数只发给支持的平台，
 * 不支持的平台一个字段都不写（发了就是 422，见 KL-DF-07）。
 */
export function providerOf(prefs: Prefs, sessionThinking?: ThinkingLevel | null): ProviderConfig | null {
  if (!prefs.llmBaseUrl || !prefs.apiKey || !prefs.model) return null;
  const cfg: ProviderConfig = {
    baseUrl: prefs.llmBaseUrl,
    apiKey: prefs.apiKey,
    model: prefs.model,
    temperature: prefs.temperature,
    useAnthropicFormat: prefs.useAnthropicFormat,
    reservedOutputTokens: prefs.reservedOutputTokens,
    // maxOutputTokens <= 0 视为未设置：交给协议层用 DEFAULT_MAX_TOKENS
    maxTokens: prefs.maxOutputTokens > 0 ? prefs.maxOutputTokens : undefined,
  };
  if (thinkingSupportedFor(prefs)) {
    const level = effectiveThinking(prefs, sessionThinking ?? null);
    const choice = choiceOfLevel(level);
    cfg.thinking = choice.enabled;
    cfg.reasoningEffort = choice.effort;
  }
  return cfg;
}

/** send() 的输入（一次完整对话发送） */
export interface SendOptions {
  dirs: AppDirs;
  prefs: Prefs;
  /** 当前会话；null 时内部新建（首条用户消息触发标题派生） */
  session: SessionFile | null;
  projectRoot: string | null;
  userText: string;
  transport: StreamTransport;
  onEvent?: (e: AgentEvent) => void;
  /** question 工具的界面回调（弹窗提问 → 用户选择 → resolve 答案） */
  askQuestions?: (questions: QuestionItem[]) => Promise<string[][]>;
  /**
   * 会话内已授权的额外目录（B-1 确认机制的落点）：**按引用传入**——
   * 用户在工具执行期间批准的新目录会 push 进这个数组，同一会话后续请求持续生效。
   */
  allowedDirs?: string[];
  /** 根外路径的用户确认通道（B-1）：装配后「根外必须用户确认」真正生效；未装配时根外一律拒绝 */
  confirmExternal?: (absPath: string) => Promise<boolean>;
  signal?: { aborted: boolean };
  /**
   * 会话级临时思考档位（D-011，只存内存）；`null`/省略 = 跟随配置默认。
   * 回流这类后台任务由调用方显式传 `"off"`。
   */
  thinking?: ThinkingLevel | null;
  /**
   * AI 三态模式（只读/写作/开发；缺省开发 = 现状）。按它过滤发给模型的工具清单，
   * 并把模式交给 exec 执行层做路径级硬拦（双闸，见 core/ai/mode.ts）。
   */
  mode?: AiMode;
}

export interface SendResult {
  /** 已落盘的最新会话（含本轮全部新消息；即使 error 存在也已保存） */
  session: SessionFile;
  error?: string;
  /** 本次运行的 token 用量合计（面板「本次会话累计」据此累加，D-019） */
  usage: UsageTotals;
  /** 任一回合撞上 max_tokens 上限（界面须给可见提示：别让用户以为模型写完了） */
  truncated: boolean;
}

/**
 * 发送一条用户消息并跑完整工具循环。
 * 契约：runAgent 层面的失败/中止不抛异常，折算在 SendResult.error 里，
 * 会话（含用户消息与部分正文）照常落盘。
 */
export async function send(opts: SendOptions): Promise<SendResult> {
  const fs = getFs();
  const cfg = providerOf(opts.prefs, opts.thinking ?? null);
  const session = opts.session ?? newSession(opts.projectRoot ?? "");

  if (!cfg) {
    const message = AI_ERRORS.invalidKey;
    // B12-8：配置缺失也要把用户消息落盘。界面先做了乐观气泡，随后用返回值整体替换会话
    // （MainWorkbench 的 `setSession(res.session)`）—— 早退时不落盘，用户刚敲的整段
    // prompt 会同时在屏幕上和磁盘上蒸发，只剩一行错误提示。与 runAgent 的纪律一致：
    // 失败的回合也要把用户输入留在会话里。
    const withUser = withUserMessage(session, opts.userText, opts.projectRoot);
    try {
      await saveSession(fs, opts.dirs.sessionsDir, withUser);
    } catch {
      // 落盘失败不掩盖"配置缺失"这条用户真正要知道的原因
    }
    opts.onEvent?.({ type: "error", message });
    return { session: withUser, error: message, usage: { ...ZERO_USAGE }, truncated: false };
  }

  const systemPrompt = buildSystemPrompt({
    basePrompt: opts.prefs.systemPrompt,
    projectRoot: opts.projectRoot,
    skills: opts.prefs.skillList,
    activeSkillIds: opts.prefs.activeSkillIds,
    enabledTools: ENABLED_TOOLS,
    // I-10：技能根绝对路径随提示词下发（技能目录是独立授权根，模型自己推不出来）
    skillsDir: opts.dirs.skillsDir,
  });

  // 上下文自动压缩：只影响发给 AI 的请求序列，会话记录保持完整
  let requestMessages: ChatMessage[] = session.messages;
  if (opts.prefs.autoClearContext) {
    try {
      const compressed = await maybeCompress({
        // 压缩是后台任务：强制关闭思考（省 token，也避免思考内容混进摘要）
        cfg: { ...cfg, thinking: false },
        transport: opts.transport,
        messages: session.messages,
        contextLimit: opts.prefs.contextLimit,
        reservedOutputTokens: opts.prefs.reservedOutputTokens,
        sessionId: session.id,
        // 压缩的观测信息（失败/拒绝原因）借 error 事件通道浮出：非致命，对话继续
        onNotice: (m) => opts.onEvent?.({ type: "error", message: m }),
      });
      if (compressed) requestMessages = compressed.requestMessages;
    } catch {
      // 压缩失败不阻断对话：按完整上下文发送
    }
  }

  const result = await runAgent({
    cfg,
    systemPrompt,
    tools: toolsForMode(opts.mode ?? DEFAULT_AI_MODE), // 双闸之一：只读模式连 file_write 都不发给模型
    messages: requestMessages,
    userText: opts.userText,
    // 轮次上限来自用户设置（B16：滑杆 1–50 + 最右端「无上限」落盘 0）。
    // 0/负数 = 不限制（跑到模型自己停手为止；agent 循环的终止条件本就不是轮数而是
    // 「模型不再请求工具」）；正数即用其值，不再钳 50（一次完整回流/建仓可能远超 50）。
    maxToolRounds: opts.prefs.toolRoundLimit > 0 ? opts.prefs.toolRoundLimit : Number.MAX_SAFE_INTEGER,
    transport: opts.transport,
    onEvent: opts.onEvent,
    signal: opts.signal,
    toolCtx: {
      fs,
      roots: {
        projectRoot: opts.projectRoot,
        skillsDir: opts.dirs.skillsDir,
        booksRoot: opts.dirs.booksRoot,
        // 按引用透传：工具执行期间批准的根外目录要持续生效到会话结束
        allowedDirs: opts.allowedDirs,
      },
      booksRoot: opts.dirs.booksRoot,
      snapshotsDir: opts.dirs.snapshotsDir,
      sessionId: session.id,
      confirmWrites: true,
      askQuestions: opts.askQuestions,
      confirmExternal: opts.confirmExternal,
      lookupSkill: (name) => lookupSkill(fs, opts.prefs.skillList, name),
      mode: opts.mode ?? DEFAULT_AI_MODE, // 双闸之二：执行层按路径硬拦
    },
  });

  // 落盘用完整原始记录（session.messages）+ 本轮新增；压缩产物不进会话文件
  const messages: ChatMessage[] = [...session.messages, ...result.added];
  // 标题派生：仍是默认「New Chat …」时取首条用户消息前 30 字
  const firstUser = messages.find((m) => m.role === "user");
  const title =
    session.title.startsWith("New Chat") && firstUser
      ? titleFromText(firstUser.text) || session.title
      : session.title;

  const next: SessionFile = {
    ...session,
    title,
    projectPath: session.projectPath || opts.projectRoot || "",
    updatedAt: isoMicros(),
    messages,
  };

  try {
    await saveSession(fs, opts.dirs.sessionsDir, next);
  } catch (e) {
    // B12-8：落盘失败折算成 SendResult（带已算出的 usage 与截断标记），不让整个 promise
    // reject —— reject 会让调用方连 token 用量和截断提示一起丢掉，只剩一行 "Error: …"。
    const msg = `会话落盘失败：${e instanceof Error ? e.message : String(e)}`;
    opts.onEvent?.({ type: "error", message: msg });
    await recordUsageSafe(fs, opts.dirs.usageStatsFile, result.usage);
    return { session: next, error: msg, usage: result.usage, truncated: result.truncated };
  }

  // token 统计落盘（usage_stats.json，D-023）。统计是旁路：写失败不影响对话主流程。
  await recordUsageSafe(fs, opts.dirs.usageStatsFile, result.usage);

  return { session: next, error: result.error, usage: result.usage, truncated: result.truncated };
}

/** 重读会话索引（界面在落盘后刷新会话列表用） */
export async function reloadIndex(dirs: AppDirs) {
  return loadIndex(getFs(), dirs.sessionsDir);
}

// ────────────────────────────── 隔离会话（冷读） ──────────────────────────────

/** sendIsolated() 的输入（冷读专用；调用方负责新建会话与装配隔离系统提示词） */
export interface IsolatedSendOptions {
  dirs: AppDirs;
  prefs: Prefs;
  /** 调用方新建的会话（标题已设好，不会走 New Chat 派生） */
  session: SessionFile;
  /** 隔离系统提示词（不装配项目块/技能块） */
  systemPrompt: string;
  userText: string;
  transport: StreamTransport;
  onEvent?: (e: AgentEvent) => void;
  signal?: { aborted: boolean };
  /**
   * 会话级临时思考档位（D-014：冷读跟随用户开关）；`null`/省略 = 跟随配置默认。
   * 旧实现不传会话级档位，用户在主界面关掉思考后冷读仍按配置默认开思考。
   */
  thinking?: ThinkingLevel | null;
  /**
   * 会话是否落盘（默认 true）。D-045 起冷读是悬浮面板里的**一次性**审读：
   * 用户裁示"退出冷读窗口，材料不保留"，会话与报告都不落盘（oplog 仍记一行）。
   */
  persistSession?: boolean;
}

/**
 * 隔离会话：零工具、零技能、零项目上下文（冷读专用）。
 * 隔离由代码保证——不注册任何文件工具，模型物理上无法读取项目文件。
 * 回归锁：tests/ai/coldread.test.ts 锁定「tools=[] 时请求体不含 tools 键」，
 * 本函数不得传入任何工具、不得经 buildSystemPrompt 装配项目块/技能块。
 */
export async function sendIsolated(opts: IsolatedSendOptions): Promise<SendResult> {
  const fs = getFs();
  const cfg = providerOf(opts.prefs, opts.thinking ?? null);

  if (!cfg) {
    const message = AI_ERRORS.invalidKey;
    // B12-8：与 send() 同一条纪律 —— 会话要落盘（除非调用方明示一次性，见 persistSession）。
    const withUser = withUserMessage(opts.session, opts.userText, null);
    if (opts.persistSession !== false) {
      try {
        await saveSession(fs, opts.dirs.sessionsDir, withUser);
      } catch {
        // 落盘失败不掩盖"配置缺失"这条用户真正要知道的原因
      }
    }
    opts.onEvent?.({ type: "error", message });
    return { session: withUser, error: message, usage: { ...ZERO_USAGE }, truncated: false };
  }

  const result = await runAgent({
    cfg,
    systemPrompt: AUTHOR_ONLY_RULES + "\n\n" + opts.systemPrompt,
    tools: [], // 零工具：请求体无 tools 键（隔离的物理保证）
    messages: [], // 零上下文：不继承任何历史对话
    userText: opts.userText,
    maxToolRounds: 1, // 单回合：无工具可循环
    transport: opts.transport,
    onEvent: opts.onEvent,
    signal: opts.signal,
    toolCtx: {
      fs,
      // projectRoot: null —— 路径守卫不放行任何项目内路径
      roots: { projectRoot: null, skillsDir: opts.dirs.skillsDir, booksRoot: opts.dirs.booksRoot },
      booksRoot: opts.dirs.booksRoot,
      snapshotsDir: opts.dirs.snapshotsDir,
      sessionId: opts.session.id,
      confirmWrites: true,
      snapshot: false, // 冷读不写文件，也就不产生快照
    },
  });

  const messages: ChatMessage[] = [...opts.session.messages, ...result.added];
  const next: SessionFile = {
    ...opts.session,
    updatedAt: isoMicros(),
    messages,
  };
  if (opts.persistSession !== false) {
    try {
      await saveSession(fs, opts.dirs.sessionsDir, next);
    } catch (e) {
      // B12-8：同 send() —— 落盘失败折算成结果，不让 promise reject 掉用量回执
      const msg = `会话落盘失败：${e instanceof Error ? e.message : String(e)}`;
      opts.onEvent?.({ type: "error", message: msg });
      await recordUsageSafe(fs, opts.dirs.usageStatsFile, result.usage);
      return { session: next, error: msg, usage: result.usage, truncated: result.truncated };
    }
  }
  // 冷读同样消耗 token，一并计入统计（旁路，失败静默）
  await recordUsageSafe(fs, opts.dirs.usageStatsFile, result.usage);
  return { session: next, error: result.error, usage: result.usage, truncated: result.truncated };
}
