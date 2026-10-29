/**
 * 回流任务装配（结束编辑 → 自动保存 → 回流）。
 *
 * 回流在专属会话中运行（不切换用户当前会话视图，会话列表可见可追溯）。
 * 本模块只负责把「被编辑对象 + diff 摘要」装配成一段任务文本；
 * 执行走 controller.send 的资料白名单与逐项确认；提示词不授权任何正文变更。
 *
 * 两路语义（方案 P4）：
 *  - 候选稿（待确认\）：不回写事实（候选情节不提前入账），只审稿 + 学习记录；
 *  - 正式正文（章节内容\）：审稿 + 按 diff 增量回写追踪表/摘要 + 学习记录。
 * 审稿一律只出报告，用户确认也不代改正文；question 只用于资料变更与规则晋升。
 *
 * 路径口径：任务文本里的 小说资料/个人改稿、小说资料/06-写作规则.md、
 * 小说资料/00-项目状态.md、待确认/、章节内容/ 都是磁盘契约目录名（逐字，不得改）。
 */

import { diffSummaryText, type DiffResult } from "../store/oplog";
import { pairedDiffSummary, type PairedDiff } from "../store/pairedDiff";

/** 解析持久化的回流模式；非法值返回 null（调用方回落默认 all） */
export function normalizeReflowMode(v: unknown): ReflowMode | null {
  return typeof v === "string" && REFLOW_MODES.some((m) => m.id === v) ? (v as ReflowMode) : null;
}

/** 回流任务 id（oplog 的 pending/完成两行按它配对） */
export function newReflowId(): string {
  return `rfl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 建仓任务文本（B8：中途启用追踪模块时的一次性重构；先报预估量经用户确认再动手） */
export function buildBootstrapPrompt(moduleKey: string, moduleFile: string): string {
  return (
    `【建仓】请为本书建仓「${moduleKey}」追踪模块：\n` +
    `1. 先报预估读取量与 token 量级，用 question 经我确认再动手。\n` +
    `2. 分段读取：00-项目状态 → 已完成细纲（细纲/，新结构）或 章节摘要.md（老作品）→ 人物库相关条目 → 按需回读正文（先用 file_manage 的 search 检索，不默认全量读）。\n` +
    `3. 把重构出的 小说资料/${moduleFile} 内容先写到 小说资料/审核/建仓-${moduleKey}-<今天YYYYMMDD>.md（格式见 novel-writer 技能的追踪表条目协议：标题 + 编号条目 + 固定字段；每条注明来源章节；只写有正文依据的内容，不推测）。\n` +
    `4. 不直接覆盖追踪表；写完后报告审核稿位置，等我过目。作者确认后才在 小说资料/${moduleFile} 增量维护条目，保留审核稿与来源，资料修改逐项通过 question 确认；核对 00 的「启用模块」行已包含「${moduleKey}」。正文、候选稿和归档凭据都不可改动，不替作者确认归档或推进章节。`
  );
}

/** 回流通道（D-043：facts = 审稿 + 事实回写；style = 对照学习，不动事实） */
export type ReflowTrack = "facts" | "style";

/** 用户可选的回流模式（编辑器四态；按书记住，默认 all） */
export type ReflowMode = "all" | "facts" | "style" | "off";

/** 四态的展示信息（顺序即界面顺序） */
export const REFLOW_MODES: readonly { id: ReflowMode; label: string; hint: string }[] = [
  { id: "all", label: "全部回流", hint: "审稿与事实回写 + 文风对照学习" },
  { id: "facts", label: "仅资料回流", hint: "只审稿与回写追踪表，不做文风学习" },
  { id: "style", label: "仅风格回流", hint: "只做文风对照学习，不动追踪表与事实" },
  { id: "off", label: "不回流保存", hint: "只保存与记日志，不触发任何回流" },
];

/**
 * 一次结束编辑该排哪些回流通道（D-043 路由表）：
 *  - off → 什么都不排；
 *  - facts → 只排资料回流；轻改动（≤24 字符且数字未变）不审事实，照旧不排；
 *  - style → 只排风格回流（轻改动也排——词级/标点级恰是最纯的文风证据）；
 *  - all → 实质改动双通道都排；轻改动只排风格通道。
 */
export function reflowTracksFor(mode: ReflowMode, light: boolean): ReflowTrack[] {
  if (mode === "off") return [];
  if (mode === "facts") return light ? [] : ["facts"];
  if (mode === "style") return ["style"];
  return light ? ["style"] : ["facts", "style"];
}

/** 回流任务的输入（由 UI 在「结束编辑」时装配） */
export interface ReflowInput {
  /** 被编辑文件相对作品根路径（'/' 分隔） */
  relPath: string;
  /** 文件类别 */
  kind: "candidate" | "chapter";
  /** 章号标签（如 第3章）；解析失败为 null */
  chapterLabel: string | null;
  diff: DiffResult;
  /**
   * 配对对照（B5：风格通道的主料）：段落级「原句 → 改后句」对齐结果。
   * 缺省时风格通道退回行级 diff 摘要（老调用方不变）。
   */
  paired?: PairedDiff;
  /**
   * 预留字段：编辑结束后磁盘上的最新全文。当前装配与调用方都未消费它——
   * 任务文本第一步已要求回流 AI 自行 file_read 全文；若将来要内联引用，
   * 需在 buildReflowPrompt 里显式拼入（并评估提示词长度）。
   */
  finalTextPreview?: string;
}

/**
 * 装配回流任务文本（资料通道，作为回流会话的首条用户消息）。
 * 结构：变更概况与 diff 摘要 → 审稿与按需学习→
 * 按候选/正文分路的第 3 步（事实回写纪律）→ 收尾汇报要求。
 */
export function buildReflowPrompt(input: ReflowInput): string {
  const label = input.chapterLabel ?? "（章号未识别）";
  const isCandidate = input.kind === "candidate";
  const summary = diffSummaryText(input.diff);

  // 头部：变更规模 + 数字变化点名（金额/数量/时间类事实是回流核对重点）
  const head =
    `【回流】${label} 用户已结束手动编辑并自动保存：${input.relPath}\n` +
    `变更规模：新增 ${input.diff.added.length} 行 / 删除 ${input.diff.removed.length} 行 / 变更 ${input.diff.changedChars} 字符` +
    `${input.diff.digitsChanged ? "（含数字变化，重点核对数量、金额、时间类事实）" : ""}\n\n` +
    `变更摘要（- 为删除行，+ 为新增行）：\n${summary}\n\n`;

  // 通用两步：正文只读审稿、有可复用判断才经确认维护学习资料
  const common =
    `请按 novel-writer 技能的「资料回流与作者归档」规则执行：\n` +
    `1. 自动审稿：读取该文件全文与相关追踪表（按变更涉及的人物/资源/伏笔做检索式最小读取），核对一致性——设定冲突、状态回退、指代断裂、承接断裂、资源重复累计。只输出审稿报告（位置+短引、问题类别、依据、作者修改方向）；不生成示范、对白或替代句，即使用户确认也不改写正文。正文文件只读，问题由作者自行修改；资料修改逐项通过 question 确认，不替作者操作导览进度、审读状态或归档凭据。\n` +
    `2. 按需学习：仅当旧版本与用户最终版之间有可复用改稿判断时，说明属于事实修正、编辑判断还是表达偏好，把判断追加到 小说资料/个人改稿/改稿对比-${label}.md（需要记录时才创建目录与文件；保留日期标题，用自然段记录，不用非必需列表、表格或箭头；不复制用户原句，只记录什么问题、何时用、怎样改、做到哪里为止；明确原因与推测原因分开标注）。没有可复用判断时不创建或追加学习记录，不逐处分类凑记录。跨章重复出现的同类判断，用 question 逐条请用户确认后，才合并进 小说资料/06-写作风格.md（禁用列表或风格规则，按条目性质；风格规则写成「### SR-编号」块加三行字段（规则分类/规则来源/具体内容），编号只增不复用，一条只讲一件事；老作品里是 06-写作规则.md 的「个人文风（学习沉淀）」节，按盘上实际文件工作）。\n`;

  // 第 3 步分路：候选稿禁止事实回写（采用后才入账）；正式正文按增量回写
  const path = isCandidate
    ? `\n3. 事实回写：本文件是候选稿，**禁止**把候选情节写入追踪表、章节摘要或任何当前事实记录（作者将其确认为正式正文并发起资料回流后才维护事实）。\n`
    : `\n3. 事实回写：本文件是作者手写并已保存的正式正文。只按变更增量更新 00 声明启用的追踪表（节内替换，注明来源章节；00 没有「启用模块」行的老作品按盘上实际存在的追踪表工作），写前系统自动落快照；只改发生变化的当前值，不重复累计；若变更与后续章节冲突，把冲突登记到 小说资料/00-项目状态.md 的「尚未解决的冲突」，不修改任何正文；不替作者确认归档或推进章节。\n`;

  const tail =
    `\n无问题时简短回执；有问题才列位置、依据与作者修改方向，不给改后稿。只汇报实际更新的文件、确实生成的学习记录与待我决定事项，不为凑报告创建记录。没有完成的步骤如实记录，不虚报。`;

  return head + common + path + tail;
}

/**
 * 风格回流任务文本（D-043：与资料回流分离的独立通道）。
 * 只做对照学习：不审稿、不动事实、不写追踪表——把「AI/旧版 → 用户最终版」的
 * 改动翻译成可复用的改稿判断，沉淀进 个人改稿/规则台账.md。
 */
export function buildStyleReflowPrompt(input: ReflowInput): string {
  const label = input.chapterLabel ?? "（章号未识别）";
  // 配对对照是风格学习的主料（B5）：「原句 → 改后句」才谈得上"改了什么"；
  // 拿不到配对（老调用方）时退随行级 diff 摘要，语义弱一档但不至于空转。
  const changes = input.paired
    ? `配对改动（「原」→「改」，按出现顺序）：\n${pairedDiffSummary(input.paired)}\n`
    : `变更摘要（- 为删除行，+ 为新增行）：\n${diffSummaryText(input.diff)}\n`;
  return (
    `【风格回流】${label} 用户已结束手动编辑并自动保存：${input.relPath}\n` +
    `变更规模：新增 ${input.diff.added.length} 行 / 删除 ${input.diff.removed.length} 行 / 变更 ${input.diff.changedChars} 字符\n\n` +
    `${changes}\n` +
    `请按 novel-writer 技能的作者改稿判断归纳规则执行：\n` +
    `1. 逐条判断配对改动属于事实修正、编辑判断还是表达偏好；拿不准的读该文件全文与上下文再判断，不要为了凑记录硬找。\n` +
    `2. 仅当存在可复用改稿判断时更新 小说资料/个人改稿/规则台账.md：已有同类条目则补证据并把「命中章节数」加 1，没有同类条目才新建（GL 编号只增不复用）。不复制用户原句，只记「什么问题、何时用、怎样改、做到哪里为止」，明确原因与推测原因分开标注。\n` +
    `3. 台账里「命中章节数」达到 2 的候选条目，用 question 逐条请用户确认；确认的并入 小说资料/06-写作风格.md（禁用列表或风格规则，按条目性质；风格规则写成「### SR-编号」块加三行字段（规则分类/规则来源/具体内容），编号只增不复用；老作品里是 06-写作规则.md 的「个人文风（学习沉淀）」节），台账标「已晋升」；被否决的标「已否决」留档。\n` +
    `4. 不做审稿、不改写用户文字、不更新追踪表与任何事实记录。不生成正文、对白、示范或替代句；即使用户确认也不改写正文，资料修改逐项通过 question 确认。不要修改导览进度、审读状态或归档凭据，不替作者确认归档或推进章节。没有可复用判断时只回一句简短回执，不创建或追加任何文件。\n`
  );
}

/** 回流会话标题（facts 通道沿用旧格式；style 通道标「风格」） */
export function reflowSessionTitle(
  chapterLabel: string | null,
  kind: ReflowInput["kind"],
  track: ReflowTrack = "facts",
): string {
  const kindLabel = kind === "candidate" ? "候选" : "正文";
  return track === "style"
    ? `风格回流 - ${chapterLabel ?? "稿件"}（${kindLabel}）`
    : `回流 - ${chapterLabel ?? "稿件"}（${kindLabel}）`;
}
