/**
 * 思考模式的档位模型（纯逻辑，零网络）。
 *
 * 裁决依据：`docs/DECISIONS.md` D-010（主界面思考开关 chip + 四档吸附滑轨）、
 * D-011（优先级：平台内置初值 → 配置级默认 → 会话级临时值；会话级**只存内存**）。
 * 接口事实来源：附录 A §2 —— 思考模式**默认开启**、默认 effort = `high`；
 * 真正有区分度的只有 `low / high / max` 三档（别名映射到这三档）。
 *
 * 四档与真语义的对应：`off` = 关闭（不发思考参数或发 none），`low / high / max` = 三档真实强度。
 * 之所以不做连续滑条：底层只有三档，连续值属于**假精度**。
 */

import {
  activeProfile,
  platformOfUrl,
  type Prefs,
  type Provider,
  type ReasoningEffort,
} from "../prefs";

/** 界面上的四个吸附档位 */
export type ThinkingLevel = "off" | "low" | "high" | "max";

/** 发给协议层的形态：开关 + 强度 */
export interface ThinkingChoice {
  enabled: boolean;
  effort: ReasoningEffort;
}

/** 四档的展示信息（顺序即界面顺序；提示里写清代价，不做模糊的"更强"） */
export const THINKING_STOPS: readonly { level: ThinkingLevel; label: string; hint: string }[] = [
  { level: "off", label: "关闭", hint: "不思考：最快、最省 token，适合改字句与套格式" },
  { level: "low", label: "低", hint: "轻量推理：适合局部改写、按设定核对细节" },
  { level: "high", label: "高", hint: "默认档：官方默认强度，推理与成本的平衡点" },
  { level: "max", label: "最高", hint: "最深推理：适合长篇结构与难题推演，token 消耗最大" },
];

/** 官方默认强度（附录 A §2：思考默认开启、effort 默认 high）。
 *  类型就写成 ReasoningEffort（而非 ThinkingLevel）—— 它不含 "off"，
 *  这样"关闭时兜底的 effort 值"与"配置默认档"两处都不需要再断言。 */
export const DEFAULT_THINKING_LEVEL: ReasoningEffort = "high";

const LEVELS: readonly ThinkingLevel[] = ["off", "low", "high", "max"];

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

/** 解析外部输入（配置/会话里的档位字符串）；非法返回 null 由调用方回落 */
export function normalizeThinkingLevel(v: unknown): ThinkingLevel | null {
  return isThinkingLevel(v) ? v : null;
}

/** 档位 → 协议层形态 */
export function choiceOfLevel(level: ThinkingLevel): ThinkingChoice {
  if (level === "off") return { enabled: false, effort: DEFAULT_THINKING_LEVEL };
  return { enabled: true, effort: level };
}

/** 协议层形态 → 档位（null 表示没有可用的显式设置） */
export function levelOfChoice(c: ThinkingChoice | null | undefined): ThinkingLevel | null {
  if (!c) return null;
  return c.enabled ? c.effort : "off";
}

/** 一条具名配置里表达的思考档位（未设置任何字段时为 null = 没有配置级默认） */
export function profileThinkingLevel(p: Provider): ThinkingLevel | null {
  if (p.thinking === undefined && p.reasoningEffort === undefined) return null;
  const enabled = p.thinking !== false;
  const effort: ReasoningEffort = p.reasoningEffort ?? DEFAULT_THINKING_LEVEL;
  return levelOfChoice({ enabled, effort });
}

/**
 * 本次会话最终生效的档位（D-011 的优先级）：
 *   ③ 会话级临时值（只存内存，`session` 非 null 时就是它）
 *   ② 配置级默认（当前生效具名配置的 `thinking` / `reasoningEffort`）
 *   ① 平台内置初值（官方默认：开启 + high）
 */
export function effectiveThinking(prefs: Prefs, session: ThinkingLevel | null): ThinkingLevel {
  if (session !== null) return session;
  const p = activeProfile(prefs);
  if (p) return profileThinkingLevel(p) ?? DEFAULT_THINKING_LEVEL;
  return DEFAULT_THINKING_LEVEL;
}

/**
 * 当前是否允许发送思考参数。判定基准是**请求真正发往的地址**（`llmBaseUrl`），
 * 不是"当前档位"——两者可能不一致（比如档位还停在 DeepSeek，地址已被改成聚合平台），
 * 而参数是跟着地址走的：发错了就是 422（KL-DF-07 `[待实测]`）。
 * 非官方地址只有在"当前正在用的那条档位显式声明 supportsThinking"时才放行。
 */
/** baseUrl 比较口径：忽略尾随 '/' 与大小写（用户手改地址多一个斜杠不该让思考参数静默停发） */
function sameBaseUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function thinkingSupportedFor(prefs: Prefs): boolean {
  if (platformOfUrl(prefs.llmBaseUrl) === "deepseek") return true;
  const p = activeProfile(prefs);
  return p?.supportsThinking === true && sameBaseUrl(p.baseUrl, prefs.llmBaseUrl);
}

/** 强制关闭形态（回流 / 上下文压缩这类后台任务用：它们不需要思考，也不该为此付费） */
export const FORCED_OFF: ThinkingChoice = { enabled: false, effort: DEFAULT_THINKING_LEVEL };