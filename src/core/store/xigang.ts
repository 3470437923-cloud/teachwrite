/**
 * 细纲栏目（D-043）：小说资料/细纲/ 下的弧段施工图。
 *
 * 文件名契约（逐字）：
 *  - 进行中/未启动：`第N-M章细纲.md`
 *  - 已完成（归档态）：`第N-M章细纲（已完成）.md`
 * 每份固定覆盖 3 章（临近结尾按实际剩余）；同一时刻最多一份「进行中」。
 * 已完成细纲即章节摘要的替身：起草第 N 章只读「上一段已完成细纲 + 当前细纲」。
 */

import { join, projectDocsDir, PROJECT_DIRS } from "../dirs";
import type { FsBridge } from "../fsbridge";
import { parseCnNumber } from "./chapter";
import { XIGANG_DIR } from "./templates";

export interface XigangRef {
  /** 文件名（含 .md） */
  name: string;
  /** 相对作品根的路径（'\' 分隔，形如 小说资料\细纲\第1-3章细纲.md） */
  rel: string;
  /** 绝对路径 */
  path: string;
  /** 覆盖首章号 */
  from: number;
  /** 覆盖末章号 */
  to: number;
  /** 文件名带（已完成）后缀 */
  done: boolean;
  mtimeMs: number;
}

/** 章号字符类（与 chapter.CHAPTER_RE 同一口径：半角/全角阿拉伯数字 + 中文数字含大写） */
const CN = "0-9０-９零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟萬";
const XIGANG_RE = new RegExp(`^第\\s*([${CN}]+)\\s*[-–—~～]\\s*([${CN}]+)\\s*章细纲(（已完成）)?$`);

/** 解析细纲文件名（不带扩展名或带 .md 均可）；区间非法（to < from）同样拒绝 */
export function parseXigangName(fileName: string): { from: number; to: number; done: boolean } | null {
  const base = fileName.replace(/\.md$/i, "");
  const m = XIGANG_RE.exec(base);
  if (!m) return null;
  const from = parseCnNumber(m[1]);
  const to = parseCnNumber(m[2]);
  if (from === null || to === null || to < from) return null;
  return { from, to, done: m[3] !== undefined };
}

/** 生成细纲文件名（与 XIGANG_RE 互逆） */
export function xigangFileName(from: number, to: number, done = false): string {
  return `第${from}-${to}章细纲${done ? "（已完成）" : ""}.md`;
}

/** 细纲目录（<作品根>\小说资料\细纲） */
export function xigangDir(projectRoot: string): string {
  return join(projectDocsDir(projectRoot), XIGANG_DIR);
}

/** 读文件内的 `- 状态：` 字段（首个命中即返回；没有为 null） */
export function xigangStatusOf(text: string): string | null {
  for (const raw of text.split("\n")) {
    const m = /^-\s*状态\s*[：:]\s*(.*)$/.exec(raw.replace(/\r$/, ""));
    if (m) return m[1].trim();
  }
  return null;
}

/** 列出细纲栏目（按首章号排序；非细纲命名的文件跳过，不报错） */
export async function listXigang(fs: FsBridge, projectRoot: string): Promise<XigangRef[]> {
  const entries = await fs.list(xigangDir(projectRoot));
  const out: XigangRef[] = [];
  for (const e of entries) {
    if (e.isDir) continue;
    const p = parseXigangName(e.name);
    if (!p) continue;
    out.push({
      name: e.name,
      rel: join(PROJECT_DIRS.docs, XIGANG_DIR, e.name),
      path: e.path,
      from: p.from,
      to: p.to,
      done: p.done,
      mtimeMs: e.mtimeMs,
    });
  }
  out.sort((a, b) => a.from - b.from);
  return out;
}

/**
 * 起草第 N 章时的最小细纲读取集（D-043 的 token 纪律）：
 * 当前细纲（覆盖第 N 章的「进行中/未启动」）+ 紧邻的上一段已完成细纲。
 * 老作品（没有细纲栏目）返回空数组，调用方按旧结构回落。
 */
export function xigangReadSet(list: XigangRef[], chapterNo: number): { current: XigangRef | null; prior: XigangRef | null } {
  const current = list.find((x) => !x.done && chapterNo >= x.from && chapterNo <= x.to) ?? null;
  const prior = [...list].reverse().find((x) => x.done && x.to < chapterNo) ?? null;
  return { current, prior };
}
