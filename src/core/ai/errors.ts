/**
 * 错误分类（文案逐字，保持既有格式）。
 * 九条全部经逐字复核（EXACT）。
 *
 * 分类入口有两个：
 *  - classifyHttpError：Rust 侧回传的 `__HTTP_ERROR__<status>|<body>`（见 transport.ts）；
 *  - classifyStreamError：流式过程中的网络层中断消息。
 * 分类结果直接展示给用户（UI 不做二次加工），因此文案必须自解释、可行动。
 */

/** 逐字错误文案（键名为内部分类标识，值为面向用户的最终文案）
 *
 * 原有九条经逐字复核（EXACT）不得改动；B5 按 DeepSeek 官方错误码表（附录 A §7）
 * 补三条 + 改写 404 一条：
 *  - 402 余额不足（官方专门列出的码，之前会落到"保留上游原文"）；
 *  - 422 参数无效（思考档位/采样参数不被支持时上游给的就是 422，不是 400）；
 *  - 404 改写：官方错误码表里**没有 404** → 它基本等价于"接口地址写错"，
 *    原文案只说"模型不存在"，会把用户引向错误的方向。
 */
export const AI_ERRORS = {
  invalidKey: "API Key 无效或未提供，请检查Key是否正确",
  expiredKey: "API Key 已过期，请更换Key后重试",
  noPermission: "令牌无权访问该模型，请检查Key权限设置",
  rateLimited:
    "429错误，可能是当前模型算力紧张，使用人数过多，建议先更换为其他模型使用，或稍后再进行尝试",
  insufficientBalance: "402错误，账户余额不足：本软件显示的余额就是官方账户余额，请充值后再试",
  invalidParam: "422错误，上游拒绝了本次请求参数：请检查思考档位、温度与最大输出长度是否符合该模型要求",
  contextTooLong: "对话内容过长，超出了上游模型的上下文限制，请压缩旧上下文或新建对话",
  noResponse: "未收到AI响应，服务器可能暂时不可用或Key已失效",
  badMaxTokens: "max_tokens 参数无效，请检查模型设置中的最大输出长度",
  modelNotFound:
    "接口地址或模型不存在：DeepSeek 官方错误码里没有 404，出现 404 基本都是接口地址（Base URL）写错了，请先核对地址，再确认模型名",
  temperatureUnsupported: "该模型不支持自定义温度，请将温度设为 1 或使用默认值",
} as const;

/** 小写化（关键词匹配一律大小写不敏感） */
function lower(s: string): string {
  return s.toLowerCase();
}

/** 响应体是否提到任一关键词（子串匹配，大小写不敏感） */
function mentions(body: string, needles: string[]): boolean {
  const b = lower(body);
  return needles.some((n) => b.includes(n));
}

/**
 * HTTP 状态码 + 响应体 → 逐字错误文案。
 * 判定优先级（自上而下短路）：
 *  - 401 一律 Key 无效；403 先看"过期"字样再落权限；429 限流；
 *  - 402 余额不足（附录 A §7：官方专门列出的码）；422 参数无效（同上）；
 *  - 404 → 地址/模型不存在：官方错误码表里没有 404，实务上等价于"URL 写错"；
 *  - 400 按响应体关键词细分：max_tokens → 参数无效；temperature → 不支持自定义温度；
 *    上下文超长字样 → contextTooLong（顺序即优先级，上游报文常同时带多个词）；
 *  - 413 请求体过大 → 按上下文超长处理；5xx → 服务器不可用；
 *  - 未归类：保留上游原文（截 400 字符），便于排查——不硬套错误文案。
 */
export function classifyHttpError(status: number, body: string): string {
  const text = body ?? "";
  if (status === 401) return AI_ERRORS.invalidKey;
  if (status === 402) return AI_ERRORS.insufficientBalance;
  if (status === 403) {
    if (mentions(text, ["expired", "过期"])) return AI_ERRORS.expiredKey;
    return AI_ERRORS.noPermission;
  }
  // 422 也按响应体细分：官方把"参数无效"和"上下文超长"都放在 422 上
  if (status === 422) {
    if (mentions(text, ["context length", "context_length", "too long", "maximum context", "token limit"])) {
      return AI_ERRORS.contextTooLong;
    }
    if (mentions(text, ["max_tokens", "max tokens", "max_completion_tokens"])) return AI_ERRORS.badMaxTokens;
    return AI_ERRORS.invalidParam;
  }
  if (status === 429) return AI_ERRORS.rateLimited;
  if (status === 404) return AI_ERRORS.modelNotFound;
  if (status === 400) {
    if (mentions(text, ["max_tokens", "max tokens", "max_completion_tokens"])) return AI_ERRORS.badMaxTokens;
    if (mentions(text, ["temperature"])) return AI_ERRORS.temperatureUnsupported;
    if (mentions(text, ["context length", "context_length", "too long", "maximum context", "token limit"])) {
      return AI_ERRORS.contextTooLong;
    }
  }
  if (status === 413) return AI_ERRORS.contextTooLong;
  if (status >= 500) return AI_ERRORS.noResponse;
  // 未归类：保留上游原文，便于排查（不套用错误文案）
  const trimmed = text.length > 400 ? text.slice(0, 400) + "…" : text;
  return trimmed || AI_ERRORS.noResponse;
}

/**
 * 流式过程中断（网络层）错误分类。
 * 中断消息没有状态码，只能按关键词归类；归不了类时保留原文
 * （如 "connection reset by peer"），空消息兜底 noResponse。
 */
export function classifyStreamError(message: string): string {
  if (mentions(message, ["context length", "too long", "maximum context"])) return AI_ERRORS.contextTooLong;
  if (mentions(message, ["401", "unauthorized", "invalid api key"])) return AI_ERRORS.invalidKey;
  if (mentions(message, ["429", "rate limit"])) return AI_ERRORS.rateLimited;
  return message || AI_ERRORS.noResponse;
}
