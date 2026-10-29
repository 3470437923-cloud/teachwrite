/**
 * 作品清单 `.openwrite_manifest.json`（保持既有格式）。
 *
 * 实测样本（C:\Users\Administrator\AI写小说\测试书籍\.openwrite_manifest.json）：
 * {"version":1,"updatedAt":"2026-09-27T22:00:35.918741",
 *  "items":{"item_1790517635918741_g2mpat":{"id":"item_1790517635918741_g2mpat","kind":"file",
 *    "physicalPath":"章节内容/1.md","displayName":"1.md",
 *    "createdAt":"2026-09-27T22:00:35.918741","updatedAt":"2026-09-27T22:00:35.918741"}},
 *  "orders":{"章节内容":["legacy:章节内容/1.md","item_1790517635918741_g2mpat"]},
 *  "manualOrderParents":[]}
 *
 * 作用：把「物理文件名」与「显示名/排序」解耦——用户改名只动 displayName，
 * 磁盘上的物理路径保持不变（这正是「格式优先」能成立的前提）。
 */

import { isoMicros, newItemId } from "../ids";

export type ManifestKind = "file" | "directory";

export interface ManifestItem {
  id: string;
  kind: ManifestKind;
  /** 相对作品根的路径，'/' 分隔（实测为 '/'） */
  physicalPath: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectManifest {
  version: number;
  updatedAt: string;
  items: Record<string, ManifestItem>;
  /** 父目录相对路径 → 有序的条目引用（条目 id 或 "legacy:<物理路径>"） */
  orders: Record<string, string[]>;
  manualOrderParents: string[];
  /** 该书的回流模式（D-043：all/facts/style/off；缺省 = 老作品，按 all 处理） */
  reflowMode?: string;
  /** 该书的资料默认视图（B7：original/table；缺省 = 按文件类型的默认） */
  viewMode?: string;
}

/** 清单版本号（磁盘契约：实测样本 version=1，不随产品演进改动） */
export const MANIFEST_VERSION = 1;

/** 构造空清单（version=1，items/orders 为空对象，时间戳取 now 的微秒 ISO） */
export function emptyManifest(now: Date = new Date()): ProjectManifest {
  return {
    version: MANIFEST_VERSION,
    updatedAt: isoMicros(now),
    items: {},
    orders: {},
    manualOrderParents: [],
  };
}

/**
 * 解析清单文本：空串/纯空白 → 空清单（缺失文件视为空清单的既有行为）。
 * 注意：**损坏 JSON 会抛错**（不静默吞掉），由调用方兜底——
 * loadProject 已 try/catch 回退空清单；直接调用本函数时需自行处理异常。
 * 字段级容错：version/updatedAt 类型不对时取默认值，items/orders/manualOrderParents 缺失时取空。
 */
export function parseManifest(text: string, now: Date = new Date()): ProjectManifest {
  if (!text || !text.trim()) return emptyManifest(now);
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) throw new Error("manifest 不是对象");
  const m = raw as Partial<ProjectManifest>;
  const out: ProjectManifest = {
    version: typeof m.version === "number" ? m.version : MANIFEST_VERSION,
    updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : isoMicros(now),
    items: (m.items as Record<string, ManifestItem>) ?? {},
    orders: (m.orders as Record<string, string[]>) ?? {},
    manualOrderParents: Array.isArray(m.manualOrderParents) ? m.manualOrderParents : [],
  };
  // 扩展字段（D-043）：类型不对一律丢弃（宁缺毋滥，不把垃圾写回磁盘）
  if (typeof m.reflowMode === "string" && m.reflowMode !== "") out.reflowMode = m.reflowMode;
  if (typeof m.viewMode === "string" && m.viewMode !== "") out.viewMode = m.viewMode;
  return out;
}

/** 序列化为单行 JSON（实测样本即单行，无缩进——磁盘契约） */
export function serializeManifest(m: ProjectManifest): string {
  return JSON.stringify(m);
}

/** 旧系统遗留的条目引用格式：`legacy:<物理路径>`（磁盘契约，逐字保持） */
export function legacyRef(physicalPath: string): string {
  return `legacy:${physicalPath}`;
}

/** 按物理路径找条目（同一物理路径只允许一条） */
export function findByPhysicalPath(m: ProjectManifest, physicalPath: string): ManifestItem | null {
  for (const it of Object.values(m.items)) {
    if (it.physicalPath === physicalPath) return it;
  }
  return null;
}

/**
 * 新增或更新条目（按物理路径去重），并同步父目录 order。
 * order 维护规则（保持用户排定的显示顺序）：
 *  - 条目 id 已在 order 中 → 位置不动，只清理同路径的 legacy 引用与重复项；
 *  - 只有 legacy:<物理路径> 引用 → 原位替换为条目 id（不挪位置）；
 *  - 都不在 → 新文件，追加到父目录 order 末尾。
 */
export function upsertItem(
  m: ProjectManifest,
  input: { physicalPath: string; displayName?: string; kind?: ManifestKind },
  now: Date = new Date(),
): { manifest: ProjectManifest; item: ManifestItem } {
  const stamp = isoMicros(now);
  const parent = parentRel(input.physicalPath);
  const existing = findByPhysicalPath(m, input.physicalPath);

  const item: ManifestItem = existing
    ? {
        ...existing,
        displayName: input.displayName ?? existing.displayName,
        kind: input.kind ?? existing.kind,
        updatedAt: stamp,
      }
    : {
        id: newItemId(now),
        kind: input.kind ?? "file",
        physicalPath: input.physicalPath,
        displayName: input.displayName ?? basenameRel(input.physicalPath),
        createdAt: stamp,
        updatedAt: stamp,
      };

  const items = { ...m.items, [item.id]: item };
  const orders = { ...m.orders };
  const legacy = legacyRef(input.physicalPath);
  // 单次遍历完成：保留首个 id/legacy 出现的位置、去掉重复、legacy 原位换成 id
  const nextOrder: string[] = [];
  let placed = false;
  for (const r of orders[parent] ?? []) {
    if (r === item.id || r === legacy) {
      if (!placed) {
        nextOrder.push(item.id);
        placed = true;
      }
    } else {
      nextOrder.push(r);
    }
  }
  if (!placed) nextOrder.push(item.id);
  orders[parent] = nextOrder;

  return { manifest: { ...m, items, orders, updatedAt: stamp }, item };
}

/**
 * 删除条目：从 items 移除，并同步清掉父目录 order 里的条目 id
 * 与同物理路径的 legacy 引用（避免留下指向已删文件的幽灵引用）。
 * id 不存在时原样返回（幂等）。
 */
export function removeItem(m: ProjectManifest, id: string, now: Date = new Date()): ProjectManifest {
  const item = m.items[id];
  if (!item) return m;
  const items = { ...m.items };
  delete items[id];
  const parent = parentRel(item.physicalPath);
  const legacy = legacyRef(item.physicalPath);
  const orders = { ...m.orders };
  orders[parent] = (orders[parent] ?? []).filter((r) => r !== id && r !== legacy);
  return { ...m, items, orders, updatedAt: isoMicros(now) };
}

/** 重命名（只改显示名 displayName，物理路径不动——「格式优先」的前提；id 不存在时原样返回） */
export function renameItem(
  m: ProjectManifest,
  id: string,
  displayName: string,
  now: Date = new Date(),
): ProjectManifest {
  const item = m.items[id];
  if (!item) return m;
  return {
    ...m,
    items: { ...m.items, [id]: { ...item, displayName, updatedAt: isoMicros(now) } },
    updatedAt: isoMicros(now),
  };
}

/** 取父目录的显示顺序列表（无记录时返回空数组；返回值是内部数组引用，调用方不得原地修改） */
export function orderFor(m: ProjectManifest, parentRelPath: string): string[] {
  return m.orders[parentRelPath] ?? [];
}

/** 物理路径 → 父目录相对路径（'/' 与 '\' 都接受；根级文件返回 ''） */
export function parentRel(physicalPath: string): string {
  const p = physicalPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** 物理路径 → 末段名（文件名或目录名；'/' 与 '\' 都接受） */
export function basenameRel(physicalPath: string): string {
  const p = physicalPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
