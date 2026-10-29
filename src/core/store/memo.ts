/**
 * 备忘录（单文件 writerd_memos.json，格式取自实测样本）：
 *   {
 *     "categories": ["默认", "灵感", "大纲"],
 *     "memos": [{
 *       "id": "1779819137257",                       // 毫秒时间戳字符串
 *       "title": "无标题",
 *       "content": "...",
 *       "created_at": "2026-05-27T02:12:17.257787",  // 本地时间 ISO，6 位微秒
 *       "updated_at": "...",
 *       "project_id": "C:\\...\\某本书"               // 绝对路径；空串=全局
 *     }]
 *   }
 * 实测样本：<Documents>\writerd_memos.json（2026-09-28）。
 */

import type { FsBridge } from "../fsbridge";
import { isoMicros } from "../ids";

/** 备忘录单条（字段名为磁盘契约：created_at/updated_at/project_id 下划线风格保持原样） */
export interface Memo {
  id: string;
  title: string;
  content: string;
  /** 所属分类（实测样本中 memo 均带此键，值如「默认」） */
  category: string;
  created_at: string;
  updated_at: string;
  project_id: string;
}

/** writerd_memos.json 整体结构（文件名为磁盘契约，不随产品改名） */
export interface MemoFile {
  categories: string[];
  memos: Memo[];
}

/** 默认分类（实测文件含 默认/灵感/大纲；新装默认只有 默认） */
export const DEFAULT_CATEGORY = "默认";

/** 空备忘录文件结构（只含默认分类） */
export function emptyMemoFile(): MemoFile {
  return { categories: [DEFAULT_CATEGORY], memos: [] };
}

/** 去 UTF-8 BOM（历史上 PowerShell 写过的文件可能带 BOM，JSON.parse 会因此失败） */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * 读取备忘录：文件缺失 → 空结构；损坏 JSON → 空结构（**不覆写磁盘文件**，
 * 是否用空结构落盘由调用方决定，避免读失败反而吞掉用户数据）。
 * 字段级容错：categories 缺失/为空回退 [默认]；memos 非数组回退 []。
 * 已知边界：memos 数组内条目不逐条校验字段（畸形条目原样透传给 UI）。
 */
export async function loadMemos(fs: FsBridge, file: string): Promise<MemoFile> {
  if (!(await fs.exists(file))) return emptyMemoFile();
  try {
    const raw = stripBom(await fs.readText(file));
    const j = JSON.parse(raw) as Partial<MemoFile>;
    return {
      categories: Array.isArray(j.categories) && j.categories.length > 0 ? j.categories : [DEFAULT_CATEGORY],
      memos: Array.isArray(j.memos) ? j.memos : [],
    };
  } catch {
    // 文件损坏时不吞掉用户数据：按空处理但由调用方决定是否覆写
    return emptyMemoFile();
  }
}

/** 保存备忘录（两空格缩进 JSON——单文件全量覆写，写前容错由调用方 loadMemos 保证） */
export async function saveMemos(fs: FsBridge, file: string, data: MemoFile): Promise<void> {
  await fs.writeText(file, JSON.stringify(data, null, 2));
}

/**
 * 新建备忘录：id = 毫秒时间戳字符串（实测契约）。
 * 已知边界：同一毫秒内连建两条会撞 id——人工点击场景实际不可达，不额外加随机后缀（保持契约格式）。
 */
export function newMemo(projectId: string, now = new Date()): Memo {
  return {
    id: String(now.getTime()),
    title: "无标题",
    content: "",
    category: DEFAULT_CATEGORY,
    created_at: isoMicros(now),
    updated_at: isoMicros(now),
    project_id: projectId,
  };
}

/**
 * 删除分类：默认分类不可删除（实测界面 chips 中「默认」无 ×）。
 *
 * 该分类下的备忘录**迁移到默认分类**，不留孤儿。早先只删分类名，声称
 * 「由 UI 按『未归类』兜底展示」—— 但 UI 根本没有这个兜底：过滤只看当前
 * chips（`MemoModal` 的 visible 用 `m.category === cat`），分类名一消失，
 * 那些条目就再也点不到，行内还挂着一个已经不存在的分类名（KL-ST-09）。
 * 迁移保数据、可回退（重建同名分类再把条目挪回去即可），不删任何内容。
 */
export function removeCategory(data: MemoFile, name: string): MemoFile {
  if (name === DEFAULT_CATEGORY) return data;
  if (!data.categories.includes(name)) return data;
  return {
    ...data,
    categories: data.categories.filter((c) => c !== name),
    memos: data.memos.map((m) =>
      (m.category ?? DEFAULT_CATEGORY) === name ? { ...m, category: DEFAULT_CATEGORY } : m,
    ),
  };
}

/** 新增分类：trim 后为空或重名时原样返回（幂等） */
export function addCategory(data: MemoFile, name: string): MemoFile {
  const n = name.trim();
  if (n === "" || data.categories.includes(n)) return data;
  return { ...data, categories: [...data.categories, n] };
}
