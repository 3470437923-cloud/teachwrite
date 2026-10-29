/**
 * 配置模型（键名保持既有格式，43 键中的非商业化部分）。
 *
 * 键名保留 `flutter.` 前缀：保持既有格式，用户可以直接沿用既有配置。
 * 商业化键（vip_* / device_id）**永不写入**。
 * 存储位置：%APPDATA%\com.writerd\writerD\shared_preferences.json。
 */

/** 既有配置键名统一前缀（磁盘契约：shared_preferences.json 里的键都长 `flutter.xxx`，不可改） */
export const PREFIX = "flutter.";

/**
 * 主题模式（DeepCompose 扩展）：
 *   dark   = 曜石黑（实色深色）
 *   light  = 晨雾白（实色浅色，冷调）
 * 键名 `theme_mode` 为 DeepCompose 自有扩展（既有格式中无此键，如实标注）；
 * 兼容策略：配置里没有 theme_mode 时按既有键 is_dark_mode 派生。
 * 注意：这两个字符串是**磁盘格式**，已经被写进用户的配置文件里，
 * 改字符串等于让老配置失效 —— 只能改注释，不能改值。
 * 2026-10-06 起 dsblue（DS 蓝）主题撤下（用户裁决：只留黑白两套）：旧配置里的
 * dsblue 值在解析时迁移为 dark（dsblue 本身是暗色主题，落 dark 语义最近）。
 */
export type ThemeMode = "dark" | "light";

/** DS 品牌蓝（0xAARRGGBB）：**历史默认值**，2026-10-06 起强调色默认改为「跟随主题」（ACCENT_AUTO）。
 *  保留此常量只为解析期识别老配置（读到的旧默认值一律迁移为 ACCENT_AUTO）。 */
export const DS_BLUE_ARGB = 4283263998; // 0xFF4D6BFE

/** 强调色「跟随主题」哨兵（0 = 主题自带的黑白墨：暗色主题近白、浅色主题近黑） */
export const ACCENT_AUTO = 0;

/** 供应商平台：两个内置预设 + 自定义（DeepCompose 扩展字段，磁盘上以字符串落库） */
export type ProviderPlatform = "deepseek" | "siliconflow" | "custom";

/** 思考强度：底层只有 low / high / max 三档真语义（别名映射见 docs/DECISIONS.md 附录 A §2） */
export type ReasoningEffort = "low" | "high" | "max";

/**
 * 思考内容回传策略（**仅兼容保留，引擎不读**，D-012 B5 实测后裁决）：
 * 本软件一律不回传历史 reasoning_content —— 官方不强求（带 tools 缺省回传实测 200），
 * 不回传更省 token 且不改写历史前缀（前缀缓存按完整匹配命中）。
 * 字段仅为旧配置的 round-trip 不丢数据而保留；auto 的旧语义（按平台 + 是否带工具
 * 自动决定）已作废。
 */
export type ReasoningReplay = "auto" | "always" | "never";

/**
 * AI 供应商条目（`saved_providers` 键 JSON 数组的元素；前 5 个字段名为既有格式，逐字保留）。
 *
 * 扩展字段**全部可选**：老配置没有这些字段，缺省即回落（`platform` 按 baseUrl 推断、
 * `id` 按 name + baseUrl 派生并写回），因此升级不改老配置文件也能正确工作。
 */
export interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  useAnthropicFormat: boolean;
  /** 稳定身份（DeepCompose 扩展）：具名配置切换用它，不再依赖「键匹配」 */
  id?: string;
  /** 平台（DeepCompose 扩展）：缺省按 baseUrl 推断，推断不出即 custom */
  platform?: ProviderPlatform;
  /** 思考模式默认开关（配置级默认；会话级临时开关只存内存，见 D-011） */
  thinking?: boolean;
  /** 思考强度档位（D-010：关闭 / 低 / 高 / 最高） */
  reasoningEffort?: ReasoningEffort;
  /** 回传策略覆盖（**仅兼容保留，引擎不读**：D-012 B5 实测裁决一律不回传，字段只为 round-trip） */
  reasoningReplay?: ReasoningReplay;
  /** 自定义端点显式声明「支持 thinking 参数」（内置预设不需要，D-007） */
  supportsThinking?: boolean;
}

/** 技能清单条目（`skill_list` 键 JSON 数组的元素；字段名为既有格式，逐字保留） */
export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  directoryPath: string;
  isBuiltIn: boolean;
  marketplaceSkillId: number | null;
  marketplaceVersion: number | null;
}

/** WebDAV 配置（`webdav_config` 键的 JSON 形态；同步 UI 已下线，字段保留仅为往返不丢数据） */
export interface WebdavConfig {
  url: string;
  username: string;
  password: string;
  remotePath: string;
  lastSyncTime: string;
}

/** 应用配置全集：内部字段名 ↔ `flutter.*` 磁盘键一一对应（映射见 KEY_MAP） */
export interface Prefs {
  // —— AI 接入（11 键中的非商业化部分）——
  llmBaseUrl: string;
  apiKey: string;
  officialApiKey: string;
  model: string;
  temperature: number;
  contextLimit: number;
  useAnthropicFormat: boolean;
  savedProviders: Provider[];
  /** 当前生效的具名配置 id（DeepCompose 扩展键 `active_api_profile`；空串 = 回退到「键匹配」旧语义） */
  activeApiProfile: string;
  /** 平台选择提示已关闭（DeepCompose 扩展键 `platform_notice_dismissed`；D-022 的「不再提示」） */
  platformNoticeDismissed: boolean;
  /** 首启弹窗永久关闭（DeepCompose 扩展键 `welcome_dismissed`；2026-10-06 新增，弹窗左下「永久关闭」落点） */
  welcomeDismissed: boolean;
  /** 闲置时停下游动（DeepCompose 扩展键 `whale_idle_pause`；默认开，D-030） */
  whaleIdlePause: boolean;
  systemPrompt: string;
  reservedOutputTokens: number;
  autoClearContext: boolean;
  /** 工具调度轮次上限（委托方要求可调；既有格式中无此键，键名 [待实测]） */
  toolRoundLimit: number;
  /** 单次回复 max_tokens（既有参数页「最大输出(K)·仅 Anthropic」有文案实证，键名 [待实测]） */
  maxOutputTokens: number;

  // —— 界面面板（7 键）——
  panelSessionWidth: number;
  panelChatWidth: number;
  panelDirectoryWidth: number;
  panelMemoWidth: number;
  panelShowSession: boolean;
  panelShowDirectory: boolean;
  panelShowMemo: boolean;

  // —— 技能（3 键）——
  skillList: SkillMeta[];
  activeSkillIds: string[];
  defaultSkillsInitialized: boolean;

  // —— 同步（3 键）——
  // 同步 UI 已下线（传输层从未实现）；键保留仅为旧配置往返不丢数据。
  isConnected: boolean;
  webdavConfig: WebdavConfig;
  webdavSyncMeta: Record<string, unknown>;

  // —— 外观主题（既有 2 键 + DeepCompose 扩展 1 键）——
  customAccentColor: number;
  isDarkMode: boolean;
  /** 主题模式（DeepCompose 扩展键 theme_mode；缺省按 is_dark_mode 派生） */
  themeMode: ThemeMode;

  // —— 路径（2 键）——
  customNovelsDir: string;
  customSkillsDir: string;

  // —— 会话（2 键）——
  currentNovelProject: string;
  novelProjects: string[];

  // —— 字体（2 键）——
  chatFontSize: number;
  editorFontSize: number;
}

/**
 * 默认系统提示词。
 *
 * ⚠️ 提示词来源说明（不复制第三方产品的提示词原文）：
 * TeachWrite 的正文由作者手写；AI 只负责导览、审读意见和资料回流。
 * 默认提示词明确这一边界，不把用户确认或技能指令当作代写正文的例外。
 */
export const DEFAULT_SYSTEM_PROMPT =
  "你是 TeachWrite 的中文长篇小说作者指导助手。正文完全由作者手写；你只负责逐场景写作导览、审读意见和小说资料回流。" +
  "禁止生成或续写小说正文、对白、段落、示范写法、仿写和替代句，不得以示例、润色、修复或用户确认作为例外；禁止写入或改动 章节内容/ 与 待确认/ 中的正文文件。" +
  "先用可用工具读取相关章节与设定，按当前任务最小读取，与既有故事线、人物设定和世界观保持一致。" +
  "导览只说明场景目标、冲突、信息安排、作者行动与自检问题，不提供可直接粘贴进正文的文字；每一步是否完成只由作者手动判断和勾选，不替作者完成或推进。" +
  "审读只报告位置、问题、依据和修改方向，正文由作者自行修改；资料回流只依据作者已完成并明确指定的正式正文维护小说资料，不把导览设想、候选稿件或未确认讨论当成既成事实；归档完成仍须作者核对确认。" +
  "请使用与用户相同的语言回复。";

/** 默认配置：解析时缺失/非法的键一律回落到这里（也是"恢复默认"的基准） */
export const DEFAULT_PREFS: Prefs = {
  llmBaseUrl: "",
  apiKey: "",
  officialApiKey: "",
  model: "",
  temperature: 0.8,
  contextLimit: 1000000,
  useAnthropicFormat: false,
  savedProviders: [],
  activeApiProfile: "",
  platformNoticeDismissed: false,
  welcomeDismissed: false,
  whaleIdlePause: true,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  reservedOutputTokens: 16000,
  autoClearContext: true,
  toolRoundLimit: 12,
  // D-040：默认 128K（上限非目标，按实际产出计费；让长章/长复盘一次写完）
  maxOutputTokens: 128000,

  panelSessionWidth: 220.0,
  panelChatWidth: 523.0,
  panelDirectoryWidth: 200.0,
  panelMemoWidth: 320.0,
  panelShowSession: true,
  panelShowDirectory: true,
  panelShowMemo: false,

  skillList: [],
  activeSkillIds: [],
  defaultSkillsInitialized: false,

  isConnected: false,
  webdavConfig: { url: "", username: "", password: "", remotePath: "", lastSyncTime: "" },
  webdavSyncMeta: {},

  customAccentColor: ACCENT_AUTO,
  isDarkMode: true,
  themeMode: "dark",

  customNovelsDir: "",
  customSkillsDir: "",

  currentNovelProject: "",
  novelProjects: [],

  chatFontSize: 15.0,
  editorFontSize: 15.0,
};

/** 键名映射：内部字段 → 既有键名（去掉 flutter. 前缀后的部分） */
const KEY_MAP: Record<keyof Prefs, string> = {
  llmBaseUrl: "llm_base_url",
  apiKey: "api_key",
  officialApiKey: "official_api_key",
  model: "model",
  temperature: "temperature",
  contextLimit: "context_limit",
  useAnthropicFormat: "use_anthropic_format",
  savedProviders: "saved_providers",
  activeApiProfile: "active_api_profile", // DeepCompose 扩展键（既有格式无此键，见 DECISIONS D-007）
  platformNoticeDismissed: "platform_notice_dismissed", // DeepCompose 扩展键（D-027）
  welcomeDismissed: "welcome_dismissed", // DeepCompose 扩展键（2026-10-06 首启弹窗，D-053）
  whaleIdlePause: "whale_idle_pause", // DeepCompose 扩展键（D-030）
  systemPrompt: "system_prompt",
  reservedOutputTokens: "reserved_output_tokens",
  autoClearContext: "auto_clear_context",
  toolRoundLimit: "tool_round_limit",
  maxOutputTokens: "max_output_tokens",

  panelSessionWidth: "panel_session_width",
  panelChatWidth: "panel_chat_width",
  panelDirectoryWidth: "panel_directory_width",
  panelMemoWidth: "panel_memo_width",
  panelShowSession: "panel_show_session",
  panelShowDirectory: "panel_show_directory",
  panelShowMemo: "panel_show_memo",

  skillList: "skill_list",
  activeSkillIds: "active_skill_ids",
  defaultSkillsInitialized: "default_skills_initialized",

  // 同步 UI 已下线（传输层从未实现）；键保留仅为旧配置往返不丢数据。
  isConnected: "is_connected",
  webdavConfig: "webdav_config",
  webdavSyncMeta: "webdav_sync_meta",

  customAccentColor: "custom_accent_color",
  isDarkMode: "is_dark_mode",
  themeMode: "theme_mode", // DeepCompose 扩展键（既有格式无此键）

  customNovelsDir: "custom_novels_dir",
  customSkillsDir: "custom_skills_dir",

  currentNovelProject: "current_novel_project",
  novelProjects: "novel_projects",

  chatFontSize: "chat_font_size",
  editorFontSize: "editor_font_size",
};

/** 需要按 JSON 字符串存取的键（既有格式即以字符串形式落在 shared_preferences 里） */
const JSON_KEYS: ReadonlySet<keyof Prefs> = new Set<keyof Prefs>([
  "savedProviders",
  "skillList",
  "activeSkillIds",
  "webdavConfig",
  "webdavSyncMeta",
]);

/** 需要切除的商业化键（永不写入；读到也忽略） */
export const CUT_KEYS = [
  "vip_phone",
  "vip_status",
  "vip_days_left",
  "vip_expire_time",
  "vip_is_lifetime",
  "vip_device_limit",
  "vip_device_count",
  "vip_last_check",
  "device_id",
] as const;

/** 数值键容错：非有限 number（含数字字符串）一律回落默认值，不做隐式转换 */
function asNumber(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}
/** 布尔键容错：非 boolean 一律回落默认值（"true" 字符串不算 true） */
function asBool(v: unknown, def: boolean): boolean {
  return typeof v === "boolean" ? v : def;
}
/** 字符串键容错：非 string 一律回落默认值 */
function asString(v: unknown, def: string): string {
  return typeof v === "string" ? v : def;
}

/** 枚举键容错：不在白名单内一律返回 undefined（宁可丢掉坏值，也不把垃圾写回磁盘） */
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

const PLATFORM_VALUES: readonly ProviderPlatform[] = ["deepseek", "siliconflow", "custom"];
const EFFORT_VALUES: readonly ReasoningEffort[] = ["low", "high", "max"];
const REPLAY_VALUES: readonly ReasoningReplay[] = ["auto", "always", "never"];

/**
 * 供应商条目的稳定身份：FNV-1a 32 位哈希（纯函数、跨进程稳定、不引入依赖）。
 * 老配置条目没有 id —— 按 name + baseUrl 派生并写回，使「具名配置切换」不依赖键匹配（D-007）。
 */
export function deriveProfileId(name: string, baseUrl: string): string {
  let h = 0x811c9dc5;
  const s = `${name}\u0000${baseUrl}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "p" + h.toString(16).padStart(8, "0");
}

/** 按 baseUrl 推断平台：识别不出即自定义（老配置升级时用，避免让 DeepSeek 用户丢思考控件） */
function inferPlatform(baseUrl: string): ProviderPlatform {
  const u = baseUrl.toLowerCase();
  if (u.includes("api.deepseek.com")) return "deepseek";
  if (u.includes("siliconflow.cn") || u.includes("siliconflow.com")) return "siliconflow";
  return "custom";
}

/**
 * 规范化一条供应商条目：补齐扩展字段、丢弃非法枚举值、保留未知字段。
 *
 * - 非对象元素返回 null（坏数据不进运行期，调用方过滤掉）
 * - 未知字段（第三方写的键）**原样保留**，保证 round-trip 不丢数据
 * - `id` 缺失才派生；`platform` 缺失才按 baseUrl 推断
 */
export function normalizeProvider(entry: unknown): Provider | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  const out: Record<string, unknown> = { ...e };
  const name = asString(e.name, "");
  const baseUrl = asString(e.baseUrl, "");
  out.name = name;
  out.baseUrl = baseUrl;
  out.apiKey = asString(e.apiKey, "");
  out.model = asString(e.model, "");
  out.useAnthropicFormat = asBool(e.useAnthropicFormat, false);
  const id = asString(e.id, "");
  out.id = id !== "" ? id : deriveProfileId(name, baseUrl);
  out.platform = oneOf(e.platform, PLATFORM_VALUES) ?? inferPlatform(baseUrl);

  const setOptional = (key: string, value: unknown): void => {
    if (value === undefined) delete out[key];
    else out[key] = value;
  };
  setOptional("thinking", typeof e.thinking === "boolean" ? e.thinking : undefined);
  setOptional("reasoningEffort", oneOf(e.reasoningEffort, EFFORT_VALUES));
  setOptional("reasoningReplay", oneOf(e.reasoningReplay, REPLAY_VALUES));
  setOptional("supportsThinking", typeof e.supportsThinking === "boolean" ? e.supportsThinking : undefined);

  return out as unknown as Provider;
}

/** 规范化整份清单（非对象元素被丢弃） */
export function normalizeProviders(list: Provider[]): Provider[] {
  return list.map(normalizeProvider).filter((x): x is Provider => x !== null);
}

/**
 * 解析以 JSON 字符串落盘的键（见 JSON_KEYS）。
 * shape 声明期望形态：坏 JSON、null、数组键收到非数组（或反之）都回落默认值——
 * 否则坏数据会带着错误形态进入运行期（如 skill_list 是对象时 .filter 直接崩）。
 */
function parseJsonField<T>(v: unknown, def: T, shape: "array" | "object" | "any" = "any"): T {
  if (typeof v !== "string" || v.trim() === "") return def;
  try {
    const parsed: unknown = JSON.parse(v);
    if (parsed === null || parsed === undefined) return def;
    if (shape === "array" && !Array.isArray(parsed)) return def;
    if (shape === "object" && (typeof parsed !== "object" || Array.isArray(parsed))) return def;
    return parsed as T;
  } catch {
    return def;
  }
}

/** 解析配置原文（容错：BOM / 缺失 / 类型不符一律回落默认值，绝不抛） */
export function parsePrefs(text: string): Prefs {
  let raw: Record<string, unknown> = {};
  // 去掉 UTF-8 BOM：外部编辑器与 Windows PowerShell 都可能写进 BOM，
  // 而 JSON.parse 遇到 BOM 会直接抛错（曾导致整份配置被静默忽略）。
  const cleaned = text.replace(/^\uFEFF/, "");
  if (cleaned.trim()) {
    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
    } catch {
      raw = {};
    }
  }
  const get = (k: keyof Prefs): unknown => raw[PREFIX + KEY_MAP[k]];
  const p: Prefs = { ...DEFAULT_PREFS };

  p.llmBaseUrl = asString(get("llmBaseUrl"), p.llmBaseUrl);
  p.apiKey = asString(get("apiKey"), p.apiKey);
  p.officialApiKey = asString(get("officialApiKey"), p.officialApiKey);
  p.model = asString(get("model"), p.model);
  p.temperature = asNumber(get("temperature"), p.temperature);
  p.contextLimit = asNumber(get("contextLimit"), p.contextLimit);
  p.useAnthropicFormat = asBool(get("useAnthropicFormat"), p.useAnthropicFormat);
  // saved_providers 元素的前 5 个字段是既有格式（逐字保留）；扩展字段缺失时在此补齐
  // （老配置平滑升级），未知字段原样保留。
  p.savedProviders = normalizeProviders(
    parseJsonField<Provider[]>(get("savedProviders"), p.savedProviders, "array"),
  );
  p.activeApiProfile = asString(get("activeApiProfile"), p.activeApiProfile);
  p.platformNoticeDismissed = asBool(get("platformNoticeDismissed"), p.platformNoticeDismissed);
  p.welcomeDismissed = asBool(get("welcomeDismissed"), p.welcomeDismissed);
  p.whaleIdlePause = asBool(get("whaleIdlePause"), p.whaleIdlePause);
  p.systemPrompt = asString(get("systemPrompt"), p.systemPrompt);
  p.reservedOutputTokens = asNumber(get("reservedOutputTokens"), p.reservedOutputTokens);
  p.autoClearContext = asBool(get("autoClearContext"), p.autoClearContext);
  // toolRoundLimit / maxOutputTokens 是既有可写键：序列化会写出，解析也必须读回，
  // 否则用户改过的值重启后会静默丢回默认（round-trip 断裂）。
  p.toolRoundLimit = asNumber(get("toolRoundLimit"), p.toolRoundLimit);
  p.maxOutputTokens = asNumber(get("maxOutputTokens"), p.maxOutputTokens);

  p.panelSessionWidth = asNumber(get("panelSessionWidth"), p.panelSessionWidth);
  p.panelChatWidth = asNumber(get("panelChatWidth"), p.panelChatWidth);
  p.panelDirectoryWidth = asNumber(get("panelDirectoryWidth"), p.panelDirectoryWidth);
  p.panelMemoWidth = asNumber(get("panelMemoWidth"), p.panelMemoWidth);
  p.panelShowSession = asBool(get("panelShowSession"), p.panelShowSession);
  p.panelShowDirectory = asBool(get("panelShowDirectory"), p.panelShowDirectory);
  p.panelShowMemo = asBool(get("panelShowMemo"), p.panelShowMemo);

  p.skillList = parseJsonField<SkillMeta[]>(get("skillList"), p.skillList, "array");
  p.activeSkillIds = parseJsonField<string[]>(get("activeSkillIds"), p.activeSkillIds, "array");
  p.defaultSkillsInitialized = asBool(get("defaultSkillsInitialized"), p.defaultSkillsInitialized);

  p.isConnected = asBool(get("isConnected"), p.isConnected);
  p.webdavConfig = parseJsonField<WebdavConfig>(get("webdavConfig"), p.webdavConfig, "object");
  p.webdavSyncMeta = parseJsonField<Record<string, unknown>>(get("webdavSyncMeta"), p.webdavSyncMeta, "object");

  p.customAccentColor = asNumber(get("customAccentColor"), p.customAccentColor);
  // 旧默认强调色迁移为「跟随主题」：这两个值当年是默认色（DS 蓝 / 2.x 紫罗兰），
  // 不是用户的刻意选择；2026-10-06 起产品只给灰阶色板（用户裁决）。
  if (p.customAccentColor === DS_BLUE_ARGB || p.customAccentColor === 4286343935) {
    p.customAccentColor = ACCENT_AUTO;
  }
  p.isDarkMode = asBool(get("isDarkMode"), p.isDarkMode);
  // theme_mode 为 DeepCompose 扩展键：合法值直接采用；缺失/非法时按既有键
  // is_dark_mode 派生（旧配置文件平滑升级，两个键独立往返以保 round-trip）
  const tm = get("themeMode");
  // dsblue 已于 2026-10-06 撤下（用户裁决：只留黑白两套）：旧配置里的 dsblue
  // 落 dark（它本身是暗色主题，语义最近）
  p.themeMode = tm === "dark" || tm === "light" ? tm : tm === "dsblue" ? "dark" : p.isDarkMode ? "dark" : "light";

  p.customNovelsDir = asString(get("customNovelsDir"), p.customNovelsDir);
  p.customSkillsDir = asString(get("customSkillsDir"), p.customSkillsDir);

  p.currentNovelProject = asString(get("currentNovelProject"), p.currentNovelProject);
  // novel_projects 在既有格式里是 '\n' 分隔的绝对路径，不是 JSON
  const nps = get("novelProjects");
  p.novelProjects =
    typeof nps === "string" && nps.trim() !== ""
      ? nps.split("\n").map((s) => s.trim()).filter(Boolean)
      : p.novelProjects;

  p.chatFontSize = asNumber(get("chatFontSize"), p.chatFontSize);
  p.editorFontSize = asNumber(get("editorFontSize"), p.editorFontSize);

  return p;
}

/** 序列化为保持既有格式的 JSON（单行；商业化键不写） */
export function serializePrefs(p: Prefs): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(KEY_MAP) as (keyof Prefs)[]) {
    const realKey = PREFIX + KEY_MAP[key];
    const value = p[key];
    out[realKey] = JSON_KEYS.has(key) ? JSON.stringify(value) : value;
  }
  // novel_projects 是 '\n' 分隔文本（保持既有格式）
  out[PREFIX + KEY_MAP.novelProjects] = p.novelProjects.join("\n");
  return JSON.stringify(out);
}

/** 平台取值（缺省视为自定义） */
export function platformOf(p: Provider): ProviderPlatform {
  return p.platform ?? "custom";
}

/**
 * 由任意 Base URL 推断平台（设置页用它判断「当前填的地址属于哪个平台」）。
 * 与 `normalizeProvider` 落库时用的推断是同一条规则，避免两处口径漂移。
 */
export function platformOfUrl(baseUrl: string): ProviderPlatform {
  return inferPlatform(baseUrl);
}

/**
 * 该配置是否可发思考参数：DeepSeek 官方原生支持，自定义端点需显式 `supportsThinking`。
 * 硅基流动等聚合平台默认不发（会 422，见 KL-DF-07 `[待实测]`）。
 */
export function nativeThinkingSupported(p: Provider): boolean {
  return platformOf(p) === "deepseek" || p.supportsThinking === true;
}

/**
 * 当前生效的具名配置：
 *   ① 优先 `activeApiProfile` 指定的 id；② 找不到就回退到「baseUrl + model 键匹配」旧语义；
 *   ③ 都没有则返回 null（未选用任何已保存配置）。
 */
export function activeProfile(p: Prefs): Provider | null {
  const id = p.activeApiProfile;
  if (id !== "") {
    const byId = p.savedProviders.find((s) => s.id === id);
    if (byId) return byId;
  }
  return p.savedProviders.find((s) => s.baseUrl === p.llmBaseUrl && s.model === p.model) ?? null;
}

/** 旧名保留（既有键匹配语义的调用方）：等价于 `activeProfile` */
export function activeProvider(p: Prefs): Provider | null {
  return activeProfile(p);
}

/** 0xAARRGGBB → #RRGGBB */
export function accentHex(color: number): string {
  const rgb = color & 0xffffff;
  return "#" + rgb.toString(16).padStart(6, "0").toUpperCase();
}
