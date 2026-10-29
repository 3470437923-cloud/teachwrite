/**
 * 具名接口配置（`saved_providers` 数组）的纯逻辑：保存 / 覆盖 / 删除 / 应用。
 *
 * 裁决依据：`docs/DECISIONS.md` D-007（具名配置可保存多个并随时切换；新增配置键
 * `active_api_profile` 存 id）、D-011（配置级默认值随档位走，会话级临时值只存内存）。
 *
 * 身份规则：`id = deriveProfileId(name, baseUrl)`（FNV-1a）。因此**改名即新档位**——
 * 这不是缺陷而是刻意的：档位名是用户给的语义标签，改名后按名字派生新身份，
 * 避免"名字改了但身份没变"这种看不见的耦合。
 */

import {
  activeProfile,
  deriveProfileId,
  platformOfUrl,
  type Prefs,
  type Provider,
  type ProviderPlatform,
} from "../prefs";
import { platformLabel } from "./platforms";

/** 由当前全局键生成一条档位（保存为新配置时用）。
 *  思考相关字段（thinking / reasoningEffort / supportsThinking）不在全局键里，
 *  若当前生效档位的地址与全局键一致则**继承**过来 —— 否则「保存当前配置为档位」
 *  会把自定义端点的 supportsThinking 声明丢掉，应用该档位后思考参数静默停发。 */
export function profileFromPrefs(prefs: Prefs, name: string): Provider {
  const trimmed = name.trim();
  const baseUrl = prefs.llmBaseUrl.trim();
  const cur = activeProfile(prefs);
  const inherit = cur && cur.baseUrl.trim() === baseUrl ? cur : null;
  return {
    name: trimmed,
    baseUrl,
    apiKey: prefs.apiKey.trim(),
    model: prefs.model.trim(),
    useAnthropicFormat: prefs.useAnthropicFormat,
    id: deriveProfileId(trimmed, baseUrl),
    platform: platformOfUrl(baseUrl),
    ...(inherit?.thinking !== undefined ? { thinking: inherit.thinking } : {}),
    ...(inherit?.reasoningEffort !== undefined ? { reasoningEffort: inherit.reasoningEffort } : {}),
    ...(inherit?.supportsThinking !== undefined ? { supportsThinking: inherit.supportsThinking } : {}),
  };
}

/**
 * 新增或覆盖一条档位（按 id 判断）。
 * 名字为空视为无效输入返回原数组——空名档位在列表里无法辨认，不如不存。
 */
export function upsertProfile(list: Provider[], entry: Provider): Provider[] {
  if (entry.name.trim() === "" || entry.baseUrl.trim() === "") return list;
  const idx = list.findIndex((p) => p.id === entry.id);
  if (idx < 0) return [...list, entry];
  const next = [...list];
  next[idx] = entry;
  return next;
}

/** 删除一条档位（按 id） */
export function removeProfile(list: Provider[], id: string): Provider[] {
  return list.filter((p) => p.id !== id);
}

/**
 * 把档位写回全局键（「应用」动作）。
 * `activeApiProfile` 一并指向该档位，这样判定"当前生效档位"不依赖键匹配（D-007）。
 */
export function profilePatch(entry: Provider): Partial<Prefs> {
  return {
    llmBaseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    model: entry.model,
    useAnthropicFormat: entry.useAnthropicFormat,
    activeApiProfile: entry.id ?? "",
  };
}

/**
 * 该档位是否为当前生效档位。**与 `activeProfile` 同口径**（唯一权威就是它）：
 * ① id 命中优先；② id 悬空/为空时回退「地址 + 模型」键匹配。
 * 不自己再写一套判断——两处口径迟早会漂移。
 */
export function isActiveProfile(prefs: Prefs, entry: Provider): boolean {
  const active = activeProfile(prefs);
  if (!active) return false;
  if (active.id !== undefined && entry.id !== undefined) return active.id === entry.id;
  return active.baseUrl === entry.baseUrl && active.model === entry.model;
}

/** 切换平台时写入的全局键补丁：地址取内置预设（自定义平台留白），协议格式随平台回落 */
export function platformPatch(
  platform: ProviderPlatform,
  preset: { baseUrl: string; anthropicBaseUrl: string },
  current: Pick<Prefs, "useAnthropicFormat">,
): Partial<Prefs> {
  // 自定义平台没有内置地址：保留用户已填内容，不做任何"清空"动作（清空等于毁数据）
  if (platform === "custom") return {};
  const patch: Partial<Prefs> = { llmBaseUrl: preset.baseUrl, activeApiProfile: "" };
  // 该平台没有 Anthropic 端点时把协议拨回 OpenAI：留着 Anthropic 会必然 404（见 KL-DF-04）
  if (current.useAnthropicFormat && preset.anthropicBaseUrl === "") patch.useAnthropicFormat = false;
  return patch;
}

/** 建议档位名：`平台名`、`平台名 2`、`平台名 3`…（避免列表里出现同名档位） */
export function suggestProfileName(list: Provider[], platform: ProviderPlatform): string {
  const base = platformLabel(platform);
  const taken = new Set(list.map((p) => p.name.trim()));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/** 平台是否已有一条同名档位（用于「覆盖」还是「新建」的文案判断） */
export function hasProfileNamed(list: Provider[], name: string): boolean {
  const n = name.trim();
  return n !== "" && list.some((p) => p.name.trim() === n);
}