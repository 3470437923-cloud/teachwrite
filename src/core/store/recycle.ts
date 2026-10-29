/**
 * 作品回收站（两段式删除）。纯逻辑 + fs 原语，不碰 UI。
 *
 * 磁盘契约（**保持既有格式，不随产品改名**）：
 *   <booksRoot>\.openwrite_recycle\<id>\...        被删除的作品目录整体搬进来
 *   <booksRoot>\.openwrite_recycle\recycle_manifest.json   条目清单
 * id 形态见 ids.newRecycleId：`20260704170528_1783155928889255`（本地时间 + 微秒纪元，
 * 肉眼可读可排序）。
 *
 * 两段式的意义：**移入回收站**是日常动作、可还原；**彻底删除**是不可逆动作，
 * 因此后者额外过四道安全门（见 `checkPurgeTarget`）并需要用户手打作品名确认。
 *
 * 裁决依据：D-032（设计） / KL-DF-10（路径安全边界）。
 * 与原版的差异：原版只有「移至回收站 + 清空回收站」，没有单条彻底删除；
 * 本实现补上单条彻底删除（用户要求），并保留清空回收站。
 *
 * 纪律：本模块**不自行决定**"作品是不是正被用着"（那需要 UI 状态），
 * 由调用方在动作前给出一份 ActivitySnapshot —— 见 `checkActivity`。
 */

import type { FsBridge } from "../fsbridge";
import { isSystemEntryName, join, recycleManifestFile, recycleRoot } from "../dirs";
import { newRecycleId } from "../ids";
import { childNameProblem } from "./names";

/** 清单版本（与既有格式一致：version=1，items 数组） */
export const RECYCLE_VERSION = 1;

/** 一个回收站条目 */
export interface RecycleItem {
  /** 回收站目录名（= ids.newRecycleId()） */
  id: string;
  /** 作品显示名 */
  name: string;
  /** 原路径（还原回这里） */
  originalPath: string;
  /** 移入时间（ISO） */
  movedAt: string;
  /** 目录字节数（移入时统计，展示用；统计失败为 0） */
  sizeBytes: number;
}

export interface RecycleManifest {
  version: number;
  items: RecycleItem[];
}

export function emptyManifest(): RecycleManifest {
  return { version: RECYCLE_VERSION, items: [] };
}

/** 容错解析：坏 JSON / 类型不符一律回落空清单（回收站清单损坏不该让功能瘫痪） */
export function parseManifest(text: string): RecycleManifest {
  const out = emptyManifest();
  const cleaned = text.replace(/^\uFEFF/, "");
  if (!cleaned.trim()) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  const items = o.items;
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const r = it as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    if (id === "") continue;
    out.items.push({
      id,
      name: typeof r.name === "string" ? r.name : id,
      originalPath: typeof r.originalPath === "string" ? r.originalPath : "",
      movedAt: typeof r.movedAt === "string" ? r.movedAt : "",
      sizeBytes: typeof r.sizeBytes === "number" && r.sizeBytes >= 0 ? Math.floor(r.sizeBytes) : 0,
    });
  }
  return out;
}

/** 单行 JSON（与 prefs / usage 的落盘风格一致：无缩进、便于 diff） */
export function serializeManifest(m: RecycleManifest): string {
  return JSON.stringify({ version: RECYCLE_VERSION, items: m.items });
}

export async function loadManifest(fs: FsBridge, booksRoot: string): Promise<RecycleManifest> {
  const file = recycleManifestFile(booksRoot);
  try {
    if (!(await fs.exists(file))) return emptyManifest();
    return parseManifest(await fs.readText(file));
  } catch {
    return emptyManifest();
  }
}

export async function saveManifest(fs: FsBridge, booksRoot: string, m: RecycleManifest): Promise<void> {
  await fs.writeText(recycleManifestFile(booksRoot), serializeManifest(m));
}

/** 回收站里某个条目的目录路径 */
export function itemPath(booksRoot: string, id: string): string {
  return join(recycleRoot(booksRoot), id);
}

/* ────────────────────────── 安全门 ────────────────────────── */

// 名字规则与「新建作品」共用一份实现（单一来源，见 names.ts）
export { childNameProblem, isReservedDeviceName } from "./names";

/** 归一化路径（小写、统一分隔符、去尾部分隔符），用于比较而**不是**用于拼路径 */
function normPath(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 彻底删除前的四道安全门（纯函数，返回第一条不通过的原因）：
 *   ① 必须是作品根的**直接子项**（回收站条目还允许位于回收站目录下）；
 *   ② 名字必须是单个合法路径段（childNameProblem）；
 *   ③ 不能是系统条目（.openwrite_* / writerd_* / recycle_manifest.json）；
 *   ④ 不能是链接 / junction（isLink，防穿透；调用方从 fs.stat 取）。
 * 第 4 项的 isLink 由调用方传入 —— 本函数保持无 IO。
 */
export function checkPurgeTarget(opts: {
  booksRoot: string;
  /** 待删目录的完整路径 */
  target: string;
  /** 目标是否为链接/junction（fs.stat().isLink） */
  isLink: boolean;
}): string | null {
  const { booksRoot, target, isLink } = opts;
  const trimmed = target.replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).pop() ?? "";
  const parent = trimmed.slice(0, Math.max(0, trimmed.length - name.length - 1));

  if (name === "") return "路径不合法";

  const parentIsBooksRoot = normPath(parent) === normPath(booksRoot);
  const parentIsRecycle = normPath(parent) === normPath(recycleRoot(booksRoot));
  if (!parentIsBooksRoot && !parentIsRecycle) {
    return "只能删除作品根的直接子项或回收站内的条目";
  }
  const problem = childNameProblem(name);
  if (problem) return problem;
  if (isSystemEntryName(name)) return "这是软件的系统目录/文件，不能删除";
  if (isLink) return "目标是链接或 junction（可能指向别处），拒绝删除";
  return null;
}

/** 活动快照：调用方（UI）把"现在正忙什么"告诉本模块 */
export interface ActivitySnapshot {
  /** 是否正在生成（AI 请求在途） */
  busy: boolean;
  /** 当前会话关联的作品路径（可能为 null） */
  sessionProjectPath: string | null;
  /** 编辑器里打开的文件路径（可能为 null） */
  openFilePath: string | null;
}

/** 该作品是否正被占用（删除前必须为 null；busy 时一律拒绝） */
export function checkActivity(snapshot: ActivitySnapshot, targetPath: string): string | null {
  if (snapshot.busy) return "正在生成内容，请先停止或等这一轮结束";
  const t = normPath(targetPath);
  const inTarget = (p: string | null) => {
    if (!p) return false;
    const n = normPath(p);
    return n === t || n.startsWith(t + "/");
  };
  if (inTarget(snapshot.sessionProjectPath)) return "当前对话属于这部作品，请先切到别的作品或新建对话";
  if (inTarget(snapshot.openFilePath)) return "编辑器里打开着这部作品的文件，请先关闭它";
  return null;
}

/* ────────────────────────── 动作 ────────────────────────── */

/** 目录字节数（递归；任何失败按 0 计，只用于展示） */
export async function dirSize(fs: FsBridge, dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: Awaited<ReturnType<FsBridge["list"]>>;
    try {
      entries = await fs.list(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDir) await walk(e.path);
      else total += e.size;
    }
  };
  await walk(dir);
  return total;
}

/**
 * 移入回收站：`<booksRoot>\<name>` → `<booksRoot>\.openwrite_recycle\<id>`，并记清单。
 * 先建回收站目录再改名（同一卷内 rename 是原子的）；改名前做存在性检查。
 * 返回新条目。失败抛错（调用方展示原因）。
 */
export async function moveToRecycle(
  fs: FsBridge,
  booksRoot: string,
  opts: { name: string; originalPath: string; id?: string; when?: Date },
): Promise<RecycleItem> {
  const problem = childNameProblem(opts.name);
  if (problem) throw new Error(`不能删除这个名字：${problem}`);
  if (normPath(parentOfPath(opts.originalPath)) !== normPath(booksRoot)) {
    throw new Error("只能删除作品根的直接子项");
  }
  const id = opts.id ?? newRecycleId(opts.when ?? new Date());
  const dest = itemPath(booksRoot, id);
  if (await fs.exists(dest)) throw new Error(`回收站里已有同名条目：${id}`);

  const sizeBytes = await dirSize(fs, opts.originalPath);
  await fs.mkdir(recycleRoot(booksRoot));

  const item: RecycleItem = {
    id,
    name: opts.name,
    originalPath: opts.originalPath,
    movedAt: (opts.when ?? new Date()).toISOString(),
    sizeBytes,
  };
  // 顺序纪律：**先记清单再搬目录**。反过来（先 rename 后 saveManifest）在清单写失败时，
  // 作品目录已经躺在回收站里但两套列表（左栏/回收站界面）都看不到它 —— 用户视角等于丢稿。
  const manifest = await loadManifest(fs, booksRoot);
  manifest.items = [item, ...manifest.items.filter((i) => i.id !== id)];
  await saveManifest(fs, booksRoot, manifest);
  try {
    await fs.rename(opts.originalPath, dest);
  } catch (e) {
    // 搬移失败：回滚刚记的清单条目（清单与磁盘不得各说各话），再把原始错误抛给调用方
    try {
      const rollback = await loadManifest(fs, booksRoot);
      rollback.items = rollback.items.filter((i) => i.id !== id);
      await saveManifest(fs, booksRoot, rollback);
    } catch {
      // 回滚失败不掩盖原始的 rename 错误
    }
    throw e;
  }
  return item;
}

/** 目录的父路径（保留原始分隔符风格的那一段） */
function parentOfPath(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i < 0 ? "" : s.slice(0, i);
}

/**
 * 从回收站还原：移回 originalPath。
 * 原路径已存在时不覆盖（返回原因），把选择权交回用户 —— 宁可不动，不可静默覆盖。
 */
export async function restoreFromRecycle(
  fs: FsBridge,
  booksRoot: string,
  id: string,
): Promise<{ ok: true; item: RecycleItem } | { ok: false; reason: string }> {
  const manifest = await loadManifest(fs, booksRoot);
  const item = manifest.items.find((i) => i.id === id);
  if (!item) return { ok: false, reason: "回收站条目不存在" };
  const src = itemPath(booksRoot, id);
  if (!(await fs.exists(src))) {
    // 目录没了（用户手工删过）：把死条目清掉，别留一个永远点不动的行
    manifest.items = manifest.items.filter((i) => i.id !== id);
    await saveManifest(fs, booksRoot, manifest);
    return { ok: false, reason: "回收站文件不存在（条目已清理）" };
  }
  if (await fs.exists(item.originalPath)) {
    return { ok: false, reason: `原位置已有同名作品：${item.originalPath}` };
  }
  await fs.rename(src, item.originalPath);
  manifest.items = manifest.items.filter((i) => i.id !== id);
  await saveManifest(fs, booksRoot, manifest);
  return { ok: true, item };
}

/**
 * 彻底删除一条：删回收站里的目录 + 去掉清单条目。
 * 四道安全门在**这里**也要过一遍（不只是 UI 层）：本模块可能被其它入口调用，
 * UI 层的确认只是体验，安全门才是边界。
 */
export async function purgeItem(
  fs: FsBridge,
  booksRoot: string,
  id: string,
): Promise<{ ok: true; item: RecycleItem } | { ok: false; reason: string }> {
  const manifest = await loadManifest(fs, booksRoot);
  const item = manifest.items.find((i) => i.id === id);
  if (!item) return { ok: false, reason: "回收站条目不存在" };
  const target = itemPath(booksRoot, id);
  const st = await fs.stat(target);
  if (st === null) {
    // 目录已不在（用户手工删过）：无需删除动作，直接清条目
    // （与 restoreFromRecycle 对缺失目录的自愈同口径；removeChild 对缺失目标的行为不做假设）
    manifest.items = manifest.items.filter((i) => i.id !== id);
    await saveManifest(fs, booksRoot, manifest);
    return { ok: true, item };
  }
  const problem = checkPurgeTarget({ booksRoot, target, isLink: st.isLink ?? false });
  if (problem) return { ok: false, reason: problem };

  // 受限删除：父目录 + 单个路径段（Rust 侧还会再校验一次名字）
  // B12-8：与 moveToRecycle 同一顺序纪律 —— **先写清单再动盘**。反过来（先删目录后写清单）
  // 一旦清单写失败，回收站里就留下一条"目录已不在、点彻底删除永远失败"的幽灵条目。
  const kept = manifest.items;
  manifest.items = manifest.items.filter((i) => i.id !== id);
  await saveManifest(fs, booksRoot, manifest);
  try {
    await fs.removeChild(recycleRoot(booksRoot), id, true);
  } catch (e) {
    // 删除失败：把条目放回清单（清单与磁盘不得各说各话），原始错误照抛给调用方
    manifest.items = kept;
    try {
      await saveManifest(fs, booksRoot, manifest);
    } catch {
      // 回滚失败不掩盖原始的删除错误
    }
    throw e;
  }
  return { ok: true, item };
}

/**
 * 清空回收站：逐个走 purgeItem（每一条都过安全门），返回已删数量与失败原因。
 * 一条失败不阻断其余条目 —— 用户点"清空"是要尽量清干净，不是要一个原子事务。
 */
export async function emptyRecycle(
  fs: FsBridge,
  booksRoot: string,
): Promise<{ removed: number; failed: { id: string; reason: string }[] }> {
  const manifest = await loadManifest(fs, booksRoot);
  let removed = 0;
  const failed: { id: string; reason: string }[] = [];
  for (const item of [...manifest.items]) {
    try {
      const r = await purgeItem(fs, booksRoot, item.id);
      if (r.ok) removed += 1;
      else failed.push({ id: item.id, reason: r.reason });
    } catch (e) {
      // 一条失败不阻断其余条目（含 purgeItem 内部抛出的路径：磁盘错误、占用等）
      failed.push({ id: item.id, reason: String(e instanceof Error ? e.message : e) });
    }
  }
  return { removed, failed };
}

/** 回收站条目数（书下拉菜单做角标用；读不到按 0） */
export async function recycleCount(fs: FsBridge, booksRoot: string): Promise<number> {
  return (await loadManifest(fs, booksRoot)).items.length;
}

/** 字节数 → 人话（列表展示用；只做 1024 进制粗粒度） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}