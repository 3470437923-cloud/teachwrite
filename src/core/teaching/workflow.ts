import type { FsBridge } from "../fsbridge";
import { join } from "../dirs";
import { parseChapterName } from "../store/chapter";
import { AUTHOR_ONLY_RULES } from "../ai/writerPolicy";
import { computeReviewHash } from "./review";
import { assertTrustedTeachingPath } from "./path";

export interface ChapterArchive { chapter: number; content: string; archivedAt: string }
const archivePath = (root: string, chapter: number) => join(root, "writerd_oplog", "teachwrite", "第" + chapter + "章-归档.json");
export function nextChapter(names: string[]): number {
  return Math.max(0, ...names.map(name => parseChapterName(name)?.no ?? 0)) + 1;
}
export interface GuideChapterSnapshot { name: string; path: string; content: string }

/** 使用内存正文覆盖磁盘快照后再选择，已有空白稿与尚未建正文的导览优先复用。 */
export function selectGuideTarget(chapters: GuideChapterSnapshot[], activePath: string | null, guideChapters: number[]): number {
  const numbered = chapters.map(item => ({ ...item, no: parseChapterName(item.name)?.no ?? 0 })).filter(item => item.no > 0);
  const active = numbered.find(item => item.path === activePath);
  if (active && !active.content.trim()) return active.no;
  const pending = guideChapters.filter(no => Number.isSafeInteger(no) && no > 0 && !numbered.some(item => item.no === no && item.content.trim()));
  const blanks = numbered.filter(item => !item.content.trim()).map(item => item.no);
  if (pending.length || blanks.length) return Math.min(...pending, ...blanks);
  return nextChapter(chapters.map(item => item.name));
}

export function archiveMatches(archive: ChapterArchive | null, content: string): boolean {
  return !!archive?.archivedAt && computeReviewHash(archive.content) === computeReviewHash(content);
}

/** 包括非活动正文标签；任何未保存内容都不能借旧磁盘归档记录解锁。 */
export function archiveGateReason(archive: ChapterArchive | null, disk: string, open: string[]): string | null {
  const hash = computeReviewHash(disk);
  if (open.some(content => computeReviewHash(content) !== hash)) return "上一章有未保存修改，请先保存并重新归档";
  if (!archiveMatches(archive, disk)) return "上一章尚未完成资料归档，或正文在归档后发生了修改";
  return null;
}

export interface TeachingContextToken { root: string | null; rel: string | null; epoch: number }
export function sameTeachingContext(a: TeachingContextToken, b: TeachingContextToken): boolean {
  return a.root === b.root && a.rel === b.rel && a.epoch === b.epoch;
}

/** 最终确认弹窗返回后再次检查，停止、失败、切章与正文变动都不得封存。 */
export function canConfirmArchive(input: { aborted: boolean; failed: boolean; contextMatches: boolean; source: string; disk: string; open: string[] }): boolean {
  const hash = computeReviewHash(input.source);
  return !input.aborted && !input.failed && input.contextMatches && computeReviewHash(input.disk) === hash && input.open.every(content => computeReviewHash(content) === hash);
}
export async function loadArchive(fs: FsBridge, root: string, chapter: number): Promise<ChapterArchive | null> {
  const file = archivePath(root, chapter);
  await assertTrustedTeachingPath(fs, root, file);
  if (!(await fs.exists(file))) return null;
  const value = JSON.parse(await fs.readText(file));
  if (value.chapter !== chapter || typeof value.content !== "string" || typeof value.archivedAt !== "string") throw new Error("归档记录损坏，请重新完成资料回流。");
  return value;
}
export async function saveArchive(fs: FsBridge, root: string, archive: ChapterArchive, stillConfirmed: () => boolean = () => true): Promise<void> {
  const file = archivePath(root, archive.chapter);
  await assertTrustedTeachingPath(fs, root, file);
  if (!stillConfirmed()) throw new Error("归档确认已失效，未封存本章。");
  await fs.writeText(file, JSON.stringify(archive));
}

export const GUIDE_SYSTEM = AUTHOR_ONLY_RULES +
  '你只返回 JSON 对象 {"steps":[{"title":"场景名","goal":"叙事任务","actions":["人物需要完成的行动"],"facts":["必须遵守的事实"],"turn":"冲突或转折任务","transition":"与下一片段衔接要求","completion":"作者自行判断完成的条件"}]}。' +
  "一次生成本章完整写作顺序，每步对应一个场景或连续片段，共1到30步。每个字段只能是写作任务说明，绝无示范正文、对白或替代句。不以字数作为完成门槛。不要Markdown代码围栏。";
export const REVIEW_SYSTEM = AUTHOR_ONLY_RULES +
  '审读作者现有正文，只返回 JSON 数组 [{"category":"问题类别","quote":"逐字原文引用或空字符串","startLine":1,"problem":"问题","basis":"资料依据","impact":"影响","direction":"修改方向"}]。' +
  "没有问题返回[]。startLine只在确切引用定位时给出，按正文1-based行号。不臆造引文，不给修改后正文、替代句或示范写法。";

/** 显式读取必要资料；独立任务绝不向模型暴露文件写入工具。 */
export async function teachingContext(fs: FsBridge, root: string): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  async function visit(dir: string, depth: number) {
    for (const entry of await fs.list(dir)) {
      if (entry.isLink || entry.name.startsWith(".") || ["审核", "写作导览", "个人改稿"].includes(entry.name)) continue;
      if (entry.isDir) { if (depth < 2) await visit(entry.path, depth + 1); continue; }
      if (!entry.name.endsWith(".md")) continue;
      const content = await fs.readText(entry.path);
      total += content.length;
      if (total > 180000) throw new Error("资料超过本次读取预算，请先整理资料或缩小细纲范围；没有静默截断。");
      parts.push("【资料：" + entry.name + "】\n" + content);
    }
  }
  const materialsRoot = join(root, "小说资料");
  if ((await fs.stat(materialsRoot))?.isLink) throw new Error("小说资料根目录是链接，拒绝读取教学上下文。");
  await visit(materialsRoot, 0);
  if (!parts.length) throw new Error("没有可读的小说资料，请先完善开书资料和细纲。");
  return parts.join("\n\n");
}
