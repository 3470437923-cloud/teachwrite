/**
 * AI 三态模式（2026-10-06 用户裁决）：只读 / 写作 / 开发。
 *
 * 语义（逐字裁决）：
 *  - 只读：AI 只能读，不能改——不写任何文件；
 *  - 写作：只能改正文与候选稿（章节内容/、待确认/），不能动 小说资料/；
 *  - 开发：完全权限（现状）。
 * 默认开发模式；按会话存内存、不持久化、重启回开发（用户裁决「不记住」）。
 *
 * 双闸（策略唯一真源在本模块，两处消费）：
 *  1. controller.send 按模式过滤发给模型的 tools（只读模式连 file_write 都不发）；
 *  2. exec.ts 执行层再按路径硬拦一次——模型幻觉调用或旧会话里的工具请求也过不去。
 *
 * 采用门与回流（都要 AI 写 小说资料/）只在开发模式可用：
 * 只读/写作模式下 UI 弹窗告知「需要开发模式」（用户裁决，弹窗而不是静默）。
 */
import { IMPLEMENTED_TOOLS } from "../tools/spec";
import type { ToolSchema } from "./protocol";

export type AiMode = "readonly" | "writing" | "dev";

/** 三态的展示信息（顺序即界面顺序） */
export const AI_MODES: readonly { id: AiMode; label: string; hint: string }[] = [
  { id: "readonly", label: "只读", hint: "AI 只能读，不能改任何文件" },
  { id: "writing", label: "指导", hint: "只提供写作指导，不写正文，不修改资料" },
  { id: "dev", label: "资料维护", hint: "经作者确认维护小说资料；正文始终由作者手写" },
];

/** 默认模式（用户裁决：默认开发 = 完全权限，不记住） */
export const DEFAULT_AI_MODE: AiMode = "dev";

/** 按模式过滤发给模型的工具清单（dev = 全量，现状） */
export function toolsForMode(mode: AiMode): ToolSchema[] {
  if (mode === "dev") return IMPLEMENTED_TOOLS;
  // 只读/写作都不发 create_project（建仓是开发动作）；
  // file_manage 保留（search 是纯读），写操作由 exec 层硬拦。
  return IMPLEMENTED_TOOLS.filter((t) => t.name !== "create_project" && t.name !== "file_write");
}

/** 写入类操作的模式门槛文案（逐字，测试锁定） */
export const MODE_READONLY_TEXT =
  "当前是只读模式：AI 只能读取文件，不能修改任何内容。需要维护资料请切到资料维护模式。";
export const MODE_WRITING_TEXT =
  "当前是指导模式：AI 不修改任何正文或资料。需要维护资料请切到资料维护模式。";
export const MODE_DEV_ONLY_TEXT =
  "当前模式不能创建作品。需要创建请切到资料维护模式。";

/**
 * 执行层门槛：这次工具调用在该模式下是否放行。
 * writeKind: "write" = file_write 全操作与 file_manage 的 delete/rename/copy；
 *            "create" = create_project；其余（read/search/question/skill_lookup）不进这个门。
 * rel：目标相对项目根的路径（'\' 分隔；不在项目内为 null）。rename/copy 的两侧都要过。
 * 放行返回 null，拦截返回逐字文案。
 */
export function modeGate(mode: AiMode, writeKind: "write" | "create", rel: string | null): string | null {
  if (mode === "dev") return null;
  if (writeKind === "create") return MODE_DEV_ONLY_TEXT;
  if (mode === "readonly") return MODE_READONLY_TEXT;
  // 指导模式不写文件；资料维护模式也受 writerPolicy 正文禁令约束。
  return MODE_WRITING_TEXT;
}
