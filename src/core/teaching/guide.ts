import type { FsBridge } from "../fsbridge";
import { join, PROJECT_DIRS } from "../dirs";
import { contentHash } from "../store/snapshot";
import { assertTrustedTeachingPath } from "./path";

/** AI 只能返回指导步骤；不提供正文或文件写入字段。长度按 JS UTF-16 计。 */
export interface GuideStep {
  title: string;
  goal: string;
  actions: string[];
  facts: string[];
  turn: string;
  transition: string;
  completion: string;
}

export interface ChapterGuide {
  schemaVersion: 1;
  id: string;
  chapter: number;
  version: number;
  createdAt: string;
  steps: GuideStep[];
  /** 从零开始、连续递增的已完成步骤索引。 */
  completed: number[];
}

function fail(field: string, message: string): never {
  throw new Error("导览 " + field + "：" + message);
}

function object(value: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "必须是对象");
  const raw = value as Record<string, unknown>;
  for (const field of fields) if (!Object.hasOwn(raw, field)) fail(path + "." + field, "缺少字段");
  for (const field of Object.keys(raw)) if (!fields.includes(field)) fail(path + "." + field, "不允许额外字段");
  return raw;
}

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(field, "必须是 1.." + max + " 字符的非空字符串");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(field, "不允许控制字符");
  return value;
}

function strings(value: unknown, min: number, max: number, field: string): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(field, "必须是 " + min + ".." + max + " 项的字符串数组");
  return Array.from(value, (item, index) => text(item, 1000, field + "[" + index + "]"));
}

function steps(value: unknown): GuideStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) fail("steps", "必须包含 1..30 个步骤");
  return Array.from(value, (item, index) => {
    const path = "steps[" + index + "]";
    const raw = object(item, ["title", "goal", "actions", "facts", "turn", "transition", "completion"], path);
    return {
      title: text(raw.title, 120, path + ".title"),
      goal: text(raw.goal, 2000, path + ".goal"),
      actions: strings(raw.actions, 1, 12, path + ".actions"),
      facts: strings(raw.facts, 0, 20, path + ".facts"),
      turn: text(raw.turn, 2000, path + ".turn"),
      transition: text(raw.transition, 2000, path + ".transition"),
      completion: text(raw.completion, 2000, path + ".completion"),
    };
  });
}

function json(value: string): unknown {
  try { return JSON.parse(value); } catch { return fail("JSON", "语法无效；必须仅返回 JSON 对象"); }
}

/** 严格接受 {steps:[...]}；不剥围栏、不补字段、不从正文中提取 JSON。 */
export function parseGuideResponse(value: string): GuideStep[] {
  return steps(object(json(value), ["steps"], "response").steps);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(field, "必须是正安全整数");
  return value;
}

function validate(value: unknown): ChapterGuide {
  const raw = object(value, ["schemaVersion", "id", "chapter", "version", "createdAt", "steps", "completed"], "guide");
  if (raw.schemaVersion !== 1) fail("schemaVersion", "仅支持 1");
  const id = text(raw.id, 128, "id");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail("id", "仅允许字母、数字、下划线与连字符");
  const createdAt = text(raw.createdAt, 40, "createdAt");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) fail("createdAt", "必须是有效的 ISO UTC 时间戳（毫秒）");
  const validatedSteps = steps(raw.steps);
  if (!Array.isArray(raw.completed) || raw.completed.length > validatedSteps.length || Array.from(raw.completed).some((item, index) => item !== index)) fail("completed", "必须是从 0 开始的连续已完成索引");
  return { schemaVersion: 1, id, chapter: positiveInteger(raw.chapter, "chapter"), version: positiveInteger(raw.version, "version"), createdAt, steps: validatedSteps, completed: [...raw.completed] as number[] };
}

function checkedIndex(guide: ChapterGuide, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= guide.steps.length) fail("index", "步骤索引越界");
}

export function completeGuideStep(guide: ChapterGuide, index: number): ChapterGuide {
  const next = validate(guide);
  checkedIndex(next, index);
  if (index !== next.completed.length) fail("index", "只能完成下一个待写步骤");
  return { ...next, completed: [...next.completed, index] };
}

export function reopenGuideStep(guide: ChapterGuide, index: number): ChapterGuide {
  const next = validate(guide);
  checkedIndex(next, index);
  return { ...next, completed: next.completed.filter(item => item < index) };
}

function guideDir(root: string): string {
  if (typeof root !== "string" || !root.trim()) fail("root", "作品根目录不能为空");
  return join(root, PROJECT_DIRS.docs, "写作导览");
}

function file(root: string, chapter: number): string {
  return join(guideDir(root), "第" + positiveInteger(chapter, "chapter") + "章-导览.md");
}

/** 防止模型字符串变成 HTML 或机器元数据边界；可读区的控制语法由程序生成。 */
function readable(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\*_{}\[\]()#+.!|~-])/g, "\\$1").replace(/\r?\n/g, "\n    ");
}

const marker = "<!-- teachwrite-guide:v1\n";
function render(guide: ChapterGuide): string {
  const sections = guide.steps.map((step, index) => [
    "## " + (index + 1) + ". " + readable(step.title),
    "- [" + (index < guide.completed.length ? "x" : " ") + "] 作者确认完成",
    "目标：" + readable(step.goal),
    "行动：\n" + step.actions.map(item => "- " + readable(item)).join("\n"),
    "已知事实：\n" + (step.facts.length ? step.facts.map(item => "- " + readable(item)).join("\n") : "无"),
    "转折：" + readable(step.turn),
    "衔接：" + readable(step.transition),
    "完成标准：" + readable(step.completion),
  ].join("\n\n")).join("\n\n");
  const metadata = JSON.stringify(guide).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return "# 第" + guide.chapter + "章 — 写作导览\n\n版本：" + guide.version + "\n\n进度：" + guide.completed.length + "/" + guide.steps.length + "\n\n" + sections + "\n\n" + marker + metadata + "\n-->\n";
}

function parseStored(value: string, chapter: number): ChapterGuide {
  const start = value.lastIndexOf(marker);
  if (start < 0 || value.indexOf(marker) !== start || !value.endsWith("\n-->\n")) fail("metadata", "导览机器元数据缺失或损坏");
  const guide = validate(json(value.slice(start + marker.length, -"\n-->\n".length)));
  if (guide.chapter !== chapter) fail("chapter", "文件章节号与元数据不匹配");
  // 手改可读区不能悄悄被下一次保存覆盖，先报错让作者保留并处理差异。
  if (render(guide) !== value) fail("metadata", "导览可读内容与机器元数据不一致，请先保留并处理手动修改");
  return guide;
}

export async function loadGuide(fs: FsBridge, root: string, chapter: number): Promise<ChapterGuide | null> {
  const path = file(root, chapter);
  await assertTrustedTeachingPath(fs, root, path);
  if (!(await fs.exists(path))) return null;
  await assertTrustedTeachingPath(fs, root, path);
  return parseStored(await fs.readText(path), chapter);
}

// 与 snapshot 同一边界：进程内串行，FsBridge 无排他创建，跨进程并发须由上层隔离。
let writes: Promise<unknown> = Promise.resolve();

/** 调用方分配生成版本；同版本只允许手动进度变化。写前归档失败则不覆盖当前文件。 */
export async function saveGuide(fs: FsBridge, root: string, guide: ChapterGuide): Promise<void> {
  const next = validate(guide);
  const path = file(root, next.chapter);
  const operation = writes.then(async () => {
    await assertTrustedTeachingPath(fs, root, path);
    const exists = await fs.exists(path);
    await assertTrustedTeachingPath(fs, root, path);
    const previous = exists ? await fs.readText(path) : null;
    const rendered = render(next);
    if (previous !== null) {
      const old = parseStored(previous, next.chapter);
      if (next.version < old.version || next.version > old.version + 1) fail("version", "新版本必须逐次递增");
      if (next.version === old.version && JSON.stringify({ ...next, completed: [] }) !== JSON.stringify({ ...old, completed: [] })) fail("version", "同版本只能更新手动完成状态");
      if (previous === rendered) return;
      const history = join(guideDir(root), ".history", "第" + old.chapter + "章-v" + old.version + "-" + await contentHash(previous) + ".md");
      await assertTrustedTeachingPath(fs, root, history);
      if (await fs.exists(history)) {
        await assertTrustedTeachingPath(fs, root, history);
        if (await fs.readText(history) !== previous) fail("history", "历史文件冲突，拒绝覆盖");
      } else {
        await assertTrustedTeachingPath(fs, root, history);
        await fs.writeText(history, previous);
      }
    } else if (next.version !== 1) fail("version", "首个导览版本必须为 1");
    await assertTrustedTeachingPath(fs, root, path);
    await fs.writeText(path, rendered);
  });
  writes = operation.catch(() => undefined);
  return operation;
}
