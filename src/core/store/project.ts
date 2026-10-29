/**
 * 作品目录协议（DeepCompose 单主线工作流）。
 *
 *   <booksRoot>\<书名>\小说资料\*.md        ← 维护文档（14 件套 + 用户自建 + 审核\ + 个人改稿\）
 *   <booksRoot>\<书名>\章节内容\第N章.md    ← 正式正文（唯一事实源）
 *   <booksRoot>\<书名>\待确认\第N章-v*.md   ← 初稿与候选（采用后进正文，旧稿归档 已处理\）
 *   <booksRoot>\<书名>\writerd_oplog\       ← 用户操作日志（系统级，左栏不显示）
 *   <booksRoot>\<书名>\.openwrite_manifest.json
 *   <booksRoot>\.openwrite_recycle\          ← 回收站（作品根级）
 *
 * 「格式优先」在这一层的含义：**只读不判**。读取时不解释、不纠正、不补模板，
 * 用户自建的任何文档一律平级列出。旧布局作品（三件套）同样原样展示，不做迁移。
 */

import type { FsBridge } from "../fsbridge";
import {
  isSystemEntryName,
  PROJECT_DIRS,
  join,
  projectChaptersDir,
  projectDocsDir,
  projectManifestFile,
  projectPendingDir,
  projectProcessedDir,
  recycleRoot,
} from "../dirs";
import { parseManifest, serializeManifest, type ProjectManifest } from "./manifest";
import { compareChapterFiles, parseChapterName, stripMd } from "./chapter";
import {
  ALL_TRACKER_MODULES,
  CORE_DOC_TEMPLATES,
  DOC_TEMPLATES,
  FORESHADOW_DOC,
  LEGACY_DOC_TEMPLATES,
  ROUGH_DOC,
  STATE_DOC,
  STATE_MODULES_LINE,
  TRACKER_MODULES,
  XIGANG_DIR,
  renderTemplate,
  type TrackerModule,
} from "./templates";
import { childNameProblem } from "./names";
import { parseProjectStatus, statusChapterNo, type ProjectStatus } from "./status";
import { countForeshadowing } from "./tracking";
import { auditMaterials } from "./style";

export interface ProjectRef {
  /** 作品根绝对路径 */
  root: string;
  /** 作品名（目录名） */
  name: string;
  /** 最后修改时间（毫秒） */
  mtimeMs: number;
}

export interface FileRef {
  /** 文件名（含扩展名） */
  name: string;
  /** 相对作品根的路径，'\' 分隔 */
  rel: string;
  /** 绝对路径 */
  path: string;
  size: number;
  mtimeMs: number;
}

/** 文件类别：决定标签页行为（堆叠/单槽、只读默认、回流路径） */
export type FileKind = "doc" | "chapter" | "candidate";

/** 按相对路径判定类别（'\' 或 '/' 分隔都接受） */
export function kindForRel(rel: string): FileKind {
  const r = rel.replace(/\//g, "\\");
  if (r.startsWith(PROJECT_DIRS.chapters + "\\")) return "chapter";
  if (r.startsWith(PROJECT_DIRS.pending + "\\")) return "candidate";
  return "doc";
}

/** 列出作品根下的全部作品（跳过系统条目：隐藏目录、`writerd_*` 与回收站清单） */
export async function scanBooksRoot(fs: FsBridge, booksRoot: string): Promise<ProjectRef[]> {
  const entries = await fs.list(booksRoot);
  const out: ProjectRef[] = [];
  for (const e of entries) {
    if (!e.isDir) continue;
    // 只跳 `.` 前缀是不够的：作品根下出现 writerd_* 目录时会被当成作品列出来
    if (isSystemEntryName(e.name)) continue;
    out.push({ root: e.path, name: e.name, mtimeMs: e.mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** 维护文档（小说资料\*.md，不含子目录），按文件名排序 */
export async function listDocs(fs: FsBridge, projectRoot: string): Promise<FileRef[]> {
  const dir = projectDocsDir(projectRoot);
  const entries = await fs.list(dir);
  return entries
    .filter((e) => !e.isDir && /\.md$/i.test(e.name))
    .map((e) => ({
      name: e.name,
      rel: join(PROJECT_DIRS.docs, e.name),
      path: e.path,
      size: e.size,
      mtimeMs: e.mtimeMs,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/** 正式章节（章节内容\*.md），按章号数值排序 */
export async function listChapters(fs: FsBridge, projectRoot: string): Promise<FileRef[]> {
  const dir = projectChaptersDir(projectRoot);
  const entries = await fs.list(dir);
  return entries
    .filter((e) => !e.isDir && /\.md$/i.test(e.name))
    .map((e) => ({
      name: e.name,
      rel: join(PROJECT_DIRS.chapters, e.name),
      path: e.path,
      size: e.size,
      mtimeMs: e.mtimeMs,
    }))
    .sort((a, b) => compareChapterFiles(a.name, b.name));
}

/** 候选稿（待确认\*.md，不含 已处理 子目录），按章号排序 */
export async function listPending(fs: FsBridge, projectRoot: string): Promise<FileRef[]> {
  const dir = projectPendingDir(projectRoot);
  const entries = await fs.list(dir);
  return entries
    .filter((e) => !e.isDir && /\.md$/i.test(e.name))
    .map((e) => ({
      name: e.name,
      rel: join(PROJECT_DIRS.pending, e.name),
      path: e.path,
      size: e.size,
      mtimeMs: e.mtimeMs,
    }))
    .sort((a, b) => compareChapterFiles(a.name, b.name));
}

/** 已处理旧稿（待确认\已处理\*.md），按名称排序 */
export async function listProcessed(fs: FsBridge, projectRoot: string): Promise<FileRef[]> {
  const dir = projectProcessedDir(projectRoot);
  const entries = await fs.list(dir);
  return entries
    .filter((e) => !e.isDir && /\.md$/i.test(e.name))
    .map((e) => ({
      name: e.name,
      rel: join(PROJECT_DIRS.pending, PROJECT_DIRS.processed, e.name),
      path: e.path,
      size: e.size,
      mtimeMs: e.mtimeMs,
    }))
    .sort((a, b) => compareChapterFiles(a.name, b.name));
}

/** 作品内的全部根级 md 文件（旧布局兼容展示用） */
export async function listProjectRootFiles(fs: FsBridge, projectRoot: string): Promise<FileRef[]> {
  const entries = await fs.list(projectRoot);
  return entries
    .filter((e) => !e.isDir && /\.md$/i.test(e.name))
    .map((e) => ({
      name: e.name,
      rel: e.name,
      path: e.path,
      size: e.size,
      mtimeMs: e.mtimeMs,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

// ────────────────────────────── 通用内容树 ──────────────────────────────

/** 内容树节点：目录或文件的统一形态（children 仅目录非空） */
export interface ContentNode {
  name: string;
  /** 相对作品根路径，'\' 分隔；根为 '' */
  rel: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  children: ContentNode[];
  /**
   * 该目录的子树因深度上限被截断（I-7：不再静默消失，界面须给出可见标记）。
   * 仅目录节点可能出现；未截断时字段缺省。
   */
  truncated?: boolean;
}

/** 目录树排序：已知内容目录按固定次序在前，其余按名称；文件按类别排序 */
const DIR_ORDER: Record<string, number> = {
  [PROJECT_DIRS.docs]: 0,
  [PROJECT_DIRS.chapters]: 1,
  [PROJECT_DIRS.pending]: 2,
};

/**
 * 自然序比较：把名称按「数字段 / 非数字段」切开逐段比较，数字段按数值比。
 * 纯字典序在跨数量级时会把「第102-106章细纲」排到「第7-9章细纲」前面
 * （'1' < '7'），细纲栏目因此乱序（用户实测：第1-6章下面紧跟着第102-106章）。
 * 章节目录仍走 compareChapterFiles（识别全角/中文数字），这里是其余目录的通用序。
 */
export function naturalCompareNames(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [a];
  const tb = b.match(/\d+|\D+/g) ?? [b];
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const x = ta[i];
    const y = tb[i];
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      // 超长数字段先按长度比，避免 Number 精度丢失（文件名里几乎遇不到，防御性兜底）
      if (x.length !== y.length && (x.length > 15 || y.length > 15)) return x.length - y.length;
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) return nx - ny;
      if (x.length !== y.length) return x.length - y.length; // 「1」在「01」前，稳定可预期
      continue;
    }
    const c = x.localeCompare(y, "zh-Hans-CN");
    if (c !== 0) return c;
  }
  return ta.length - tb.length || a.localeCompare(b, "zh-Hans-CN");
}

function compareNodes(a: ContentNode, b: ContentNode, parentRel: string): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // 目录在前
  if (a.isDir) {
    const oa = DIR_ORDER[a.name] ?? 99;
    const ob = DIR_ORDER[b.name] ?? 99;
    if (oa !== ob) return oa - ob;
    return naturalCompareNames(a.name, b.name);
  }
  if (parentRel === PROJECT_DIRS.chapters || parentRel.startsWith(PROJECT_DIRS.pending)) {
    return compareChapterFiles(a.name, b.name);
  }
  return naturalCompareNames(a.name, b.name);
}

/**
 * 递归构建作品内容树（左栏数据源）。
 * 排除系统条目（.openwrite_* / writerd_* / recycle_manifest.json，见 isSystemEntryName）；
 * 深度上限 maxDepth 层（作品根直接子级为第 1 层，默认 10）——防御异常嵌套与
 * 符号链接成环：即使目录互相链接，递归也会在深度上限处截断，不会无限展开。
 * 截断**不再静默**：被截断的目录节点带 truncated:true，界面必须给出可见标记（I-7），
 * 用户不会再以为深层文件丢了。
 * fs.list 对不存在/不可读的目录返回 []，残缺作品不会抛错。
 */
export async function buildContentTree(
  fs: FsBridge,
  projectRoot: string,
  maxDepth = 10,
): Promise<ContentNode[]> {
  const walk = async (dir: string, rel: string, depth: number): Promise<ContentNode[]> => {
    if (depth > maxDepth) return [];
    const entries = await fs.list(dir);
    const nodes: ContentNode[] = [];
    for (const e of entries) {
      if (isSystemEntryName(e.name)) continue;
      const childRel = rel === "" ? e.name : join(rel, e.name);
      // 导览与审读由专用面板呈现，普通文件树不能提前展示后续场景或直接编辑作者状态。
      const teachingRel = childRel.replace(/\\/g, "/");
      if (teachingRel === "小说资料/写作导览" || teachingRel === "小说资料/审核/审读") continue;
      if (e.isDir) {
        const atLimit = depth + 1 > maxDepth;
        nodes.push({
          name: e.name,
          rel: childRel,
          path: e.path,
          isDir: true,
          size: 0,
          mtimeMs: e.mtimeMs,
          children: atLimit ? [] : await walk(e.path, childRel, depth + 1),
          // 下一层会被深度上限截掉 → 给本目录打截断标记（只有真有内容被藏时才打）
          ...(atLimit && (await fs.list(e.path)).some((x) => !isSystemEntryName(x.name))
            ? { truncated: true }
            : {}),
        });
      } else {
        nodes.push({
          name: e.name,
          rel: childRel,
          path: e.path,
          isDir: false,
          size: e.size,
          mtimeMs: e.mtimeMs,
          children: [],
        });
      }
    }
    nodes.sort((a, b) => compareNodes(a, b, rel));
    return nodes;
  };
  return walk(projectRoot, "", 1);
}

// ────────────────────────────── 作品装载 ──────────────────────────────

export interface ProjectData {
  ref: ProjectRef;
  docs: FileRef[];
  chapters: FileRef[];
  pending: FileRef[];
  processed: FileRef[];
  rootFiles: FileRef[];
  /** 通用内容树（左栏渲染数据源） */
  tree: ContentNode[];
  manifest: ProjectManifest;
}

/**
 * 读一个作品的全部索引信息。
 * 容错约定：清单缺失/损坏按空清单处理（不抛错）；各子目录缺失时对应列表为空
 * （fs.list 契约：目录不存在返回 []）；stat 失败时 mtimeMs 记 0。
 * 只读不判——不补模板、不迁移旧布局，读到什么展示什么。
 */
export async function loadProject(fs: FsBridge, projectRoot: string, name?: string): Promise<ProjectData> {
  const st = await fs.stat(projectRoot);
  const manifestPath = projectManifestFile(projectRoot);
  let manifest: ProjectManifest;
  try {
    manifest = parseManifest((await fs.exists(manifestPath)) ? await fs.readText(manifestPath) : "");
  } catch {
    manifest = parseManifest("");
  }
  return {
    ref: {
      root: projectRoot,
      name: name ?? projectRoot.split(/[\\/]+/).filter(Boolean).pop() ?? projectRoot,
      mtimeMs: st?.mtimeMs ?? 0,
    },
    docs: await listDocs(fs, projectRoot),
    chapters: await listChapters(fs, projectRoot),
    pending: await listPending(fs, projectRoot),
    processed: await listProcessed(fs, projectRoot),
    rootFiles: await listProjectRootFiles(fs, projectRoot),
    tree: await buildContentTree(fs, projectRoot),
    manifest,
  };
}

/**
 * 新建作品（D-043）：核心 7 件模板 + 三个基础目录（小说资料/章节内容/待确认）
 * + 细纲目录 + 空清单；追踪表按 modules 勾选生成（缺省 = 全部启用，
 * 与 AI create_project 工具的现状一致）。
 * 模板经 renderTemplate 替换 {书名} 占位并统一 CRLF 落盘（既有磁盘格式）。
 * 「审核」「个人改稿」「待确认\已处理」按首次使用创建，不预建。
 * 名字走 names.childNameProblem（与删除路径同一份规则）：保留设备名、冒号(ADS)、
 * 尾随空格/点、控制字符都在建目录之前挡掉，错误信息是人话而不是系统报错。
 * exists→mkdir 非原子，双开应用同时建同名作品属未定义行为（单机单实例场景可接受）。
 *
 * overrides：开书引导的定向填充结果（onboarding.onboardingOverrides），
 * key = 模板文件名，value = 已把「待填写」行替换成作者答案的模板正文。
 * 覆盖内容仍是模板格式（\n 行尾、{书名} 占位仍在），因此走同一个
 * renderTemplate 出口 —— 磁盘格式只有一条生产线。
 *
 * modules === undefined（未勾选，AI 工具路径）时 00 的「启用模块」行保持模板默认
 * （全部五个），与所建文件一致；显式给了就替换整行（全不启用写「无」）。
 */
export async function createProject(
  fs: FsBridge,
  booksRoot: string,
  name: string,
  overrides?: ReadonlyMap<string, string>,
  modules?: readonly TrackerModule[],
): Promise<ProjectRef> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("书名不能为空");
  const problem = childNameProblem(trimmed);
  if (problem) throw new Error(`书名不合法：${problem}`);

  const root = join(booksRoot, trimmed);
  if (await fs.exists(root)) throw new Error(`作品已存在：${trimmed}`);

  const enabled: readonly TrackerModule[] = modules ?? ALL_TRACKER_MODULES;
  const enabledSet = new Set<string>(enabled);
  const modulesLine =
    modules === undefined
      ? null // 工具路径：保持模板默认（全启用），与所建文件一致
      : `- 启用模块：${enabled.length > 0 ? enabled.join("、") : "无"}`;

  await fs.mkdir(projectDocsDir(root));
  await fs.mkdir(projectChaptersDir(root));
  await fs.mkdir(projectPendingDir(root));
  await fs.mkdir(join(projectDocsDir(root), XIGANG_DIR));
  for (const tpl of DOC_TEMPLATES) {
    if (TRACKER_MODULES.some((m) => m.template === tpl) && !enabledSet.has(trackerKeyOf(tpl.name))) {
      continue; // 未启用的追踪模块不创建
    }
    let content = overrides?.get(tpl.name) ?? tpl.content;
    if (tpl.name === STATE_DOC && modulesLine !== null) {
      content = content.replace(STATE_MODULES_LINE, modulesLine);
    }
    await fs.writeText(
      join(projectDocsDir(root), tpl.name),
      renderTemplate(content, trimmed),
    );
  }
  await fs.writeText(projectManifestFile(root), serializeManifest(parseManifest("")));
  const st = await fs.stat(root);
  return { root, name: trimmed, mtimeMs: st?.mtimeMs ?? Date.now() };
}

/** 追踪表文件名 → 模块键（未知名返回空串，调用方按"非追踪件"处理） */
function trackerKeyOf(fileName: string): string {
  return TRACKER_MODULES.find((m) => m.template.name === fileName)?.key ?? "";
}

/** 读取任意作品内文件（只走 fs 原语，不做内容加工） */
export async function readProjectFile(fs: FsBridge, path: string): Promise<string> {
  return fs.readText(path);
}

/** 写入作品内文件（写前快照由上层调用 snapshot 模块负责） */
export async function writeProjectFile(fs: FsBridge, path: string, content: string): Promise<void> {
  await fs.writeText(path, content);
}

/**
 * 是否为受管作品。判据与 scanBooksRoot / loadProject 的可见性口径统一（I-1）：
 * 清单 .openwrite_manifest.json 存在 → 受管；清单缺失但内容目录（小说资料/章节内容）
 * 存在 → 同样算受管（手工建目录/旧版产物的"半受管"作品，能列出能打开，就不能在
 * 删除/打开判定时又说它不存在）。
 */
export async function projectExists(fs: FsBridge, root: string): Promise<boolean> {
  if (await fs.exists(projectManifestFile(root))) return true;
  return (await fs.exists(projectDocsDir(root))) || (await fs.exists(projectChaptersDir(root)));
}

/** 附加文档登记（I-6）：14 件套之外、既有作品中真实存在并被工作流引用的文档。
 *  createProject 不生成（它们不是每本书都必须的），但校验与文档以此清单为准，
 *  不再"存在于作品中却在代码里没有任何登记"。 */
export const KNOWN_EXTRA_DOCS: readonly { name: string; why: string }[] = [
  { name: "世界观.md", why: "世界观设定长文（超出 02-核心设定 字段容量的部分）" },
  { name: "写作禁忌.md", why: "作者禁忌清单（年代错误/题材红线等，供起草与审读核对）" },
  { name: "风格规范.md", why: "文风与措辞规范（人称/视角/句式偏好）" },
] as const;

/** 作品回收站根（作品根级，保持既有格式） */
export function booksRecycleRoot(booksRoot: string): string {
  return recycleRoot(booksRoot);
}

// ────────────────────────────── 作品校验（I-12） ──────────────────────────────

/** 一条校验发现 */
export interface ProjectIssue {
  /** error = 影响正常使用（文件读不出/清单损坏）；warn = 结构不完整；info = 提示 */
  level: "error" | "warn" | "info";
  /** 机器可读的检查名（稳定字符串，测试按它断言） */
  check: string;
  /** 人话描述（界面直接展示） */
  message: string;
}

/**
 * 作品结构校验（I-12：把外部内容放进作品根之后，软件第一次有了"看一看"的入口）。
 * **只读不判**的纪律不变：本函数只报告、不修复、不补建任何文件。
 * 覆盖：清单存在性与可解析性、基础目录、14 件套、章节文件可读性与编号连续性、
 * 状态文档与正文的进度一致性（I-3）、伏笔自述统计与条目数的一致性（I-4）、
 * 资料形态体检（L2 / D-038：体量预算、装饰符号、表格占比、过程标注 —— 只报告不改写）。
 */
export async function validateProject(fs: FsBridge, projectRoot: string): Promise<ProjectIssue[]> {
  const issues: ProjectIssue[] = [];
  const st = await fs.stat(projectRoot);
  if (!st || !st.isDir) {
    return [{ level: "error", check: "root-missing", message: `作品目录不存在：${projectRoot}` }];
  }

  // 清单：缺失 → 半受管警告；损坏 → error（loadProject 会按空清单容错，但用户该知道）
  const manifestPath = projectManifestFile(projectRoot);
  if (!(await fs.exists(manifestPath))) {
    issues.push({
      level: "warn",
      check: "manifest-missing",
      message: "缺少作品清单 .openwrite_manifest.json（半受管状态：能列出，但显示名/排序等受管信息缺失）",
    });
  } else {
    try {
      const m = parseManifest(await fs.readText(manifestPath));
      if (m.version !== 1) {
        issues.push({ level: "info", check: "manifest-version", message: `清单版本为 ${m.version}（当前协议版本 1）` });
      }
    } catch {
      issues.push({ level: "error", check: "manifest-unreadable", message: "作品清单无法读取（非 UTF-8 或已损坏）" });
    }
  }

  // 基础目录
  for (const [dir, label] of [
    [projectDocsDir(projectRoot), "小说资料"],
    [projectChaptersDir(projectRoot), "章节内容"],
    [projectPendingDir(projectRoot), "待确认"],
  ] as const) {
    const d = await fs.stat(dir);
    if (!d || !d.isDir) issues.push({ level: "warn", check: "dir-missing", message: `缺少基础目录：${label}` });
  }

  // 文档完备性（只报告缺失，不补建）。D-043：按结构分两路——
  // 新结构（00 声明了「启用模块」，或 04-粗纲 / 细纲 存在）：核心 7 件 + 启用模块各自的追踪表；
  // 旧结构（老作品）：旧 14 件套口径原样保留，绝不把新结构的文件名当成老书的缺失项。
  const docsDir = projectDocsDir(projectRoot);
  const docNames = new Set((await fs.list(docsDir)).filter((e) => !e.isDir).map((e) => e.name));
  const status = await readProjectStatus(fs, projectRoot);
  const xigangDirExists = (await fs.stat(join(docsDir, XIGANG_DIR)))?.isDir === true;
  const isNewStructure = status?.modules != null || docNames.has(ROUGH_DOC) || xigangDirExists;
  if (isNewStructure) {
    const missing = CORE_DOC_TEMPLATES.filter((t) => !docNames.has(t.name)).map((t) => t.name);
    if (missing.length > 0) {
      issues.push({
        level: "info",
        check: "templates-missing",
        message: `核心文档缺 ${missing.length} 份：${missing.slice(0, 3).join("、")}${missing.length > 3 ? " 等" : ""}`,
      });
    }
    if (!xigangDirExists) {
      issues.push({ level: "warn", check: "dir-missing", message: `缺少细纲目录：${XIGANG_DIR}` });
    }
    // 启用了模块但盘上缺文件 → 结构不一致（AI 会按 00 的声明去维护一张不存在的表）
    for (const m of status?.modules ?? []) {
      const tpl = TRACKER_MODULES.find((t) => t.key === m);
      if (tpl && !docNames.has(tpl.template.name)) {
        issues.push({
          level: "warn",
          check: "module-file-missing",
          message: `启用了「${m}」模块但缺少 ${tpl.template.name}（要么建仓补建，要么从 00 的启用模块里去掉）`,
        });
      }
    }
  } else {
    const missing = LEGACY_DOC_TEMPLATES.filter((t) => !docNames.has(t.name)).map((t) => t.name);
    if (missing.length > 0) {
      issues.push({
        level: "info",
        check: "templates-missing",
        message: `14 件套缺 ${missing.length} 份：${missing.slice(0, 3).join("、")}${missing.length > 3 ? " 等" : ""}`,
      });
    }
  }

  // L2 资料形态体检（D-038 / docs/MATERIALS-STYLE.md）：体量、装饰符号、表格占比、过程标注。
  // 纪律与「格式优先」一致：**只报告、绝不改写**；单个文件读不出就跳过，不阻断体检。
  const materialFiles: { name: string; text: string }[] = [];
  for (const name of docNames) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    try {
      materialFiles.push({ name, text: await fs.readText(join(docsDir, name)) });
    } catch {
      /* 读失败静默：可读性本身由 chapter/doc 检查负责，形态体检不因一个坏文件中断 */
    }
  }
  issues.push(...auditMaterials(materialFiles));

  // 章节：文件必须可读（非 UTF-8 会在编辑回路里炸）；编号只报告断档，不判对错
  const chapters = await listChapters(fs, projectRoot);
  for (const c of chapters) {
    try {
      await fs.readText(c.path);
    } catch {
      issues.push({ level: "error", check: "chapter-unreadable", message: `章节文件无法按 UTF-8 读取：${c.name}（可能是 GBK/UTF-16 旧稿）` });
    }
  }
  const nos = chapters
    .map((c) => parseChapterName(stripMd(c.name))?.no)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  for (let i = 1; i < nos.length; i++) {
    if (nos[i] === nos[i - 1]) {
      issues.push({ level: "warn", check: "chapter-duplicate", message: `章号重复：第${nos[i]}章` });
    } else if (nos[i] > nos[i - 1] + 1) {
      issues.push({
        level: "info",
        check: "chapter-gap",
        message: `章节编号断档：第${nos[i - 1]}章 → 第${nos[i]}章`,
      });
    }
  }

  // I-3：00-项目状态.md 的结构化读取 —— 应用第一次能自己判断"写作进度到哪一步"，
  // 而不是把整份文档丢给模型读。模板口径：当前章节 = **下一个要写的章**，
  // 所以"状态声明第N章"意味着正文应该已有 N-1 章；声明的进度跑在磁盘前面就是漂移。
  //（status 在上面的结构判定处已读过一次，这里复用同一结果）
  if (status) {
    const declared = statusChapterNo(status);
    const maxNo = nos.length > 0 ? nos[nos.length - 1] : 0;
    if (declared !== null && declared - 1 > maxNo) {
      issues.push({
        level: "warn",
        check: "status-chapter-ahead",
        message: `00-项目状态.md 记「${status.chapter}」，但 章节内容 里最大只到第${maxNo}章（状态比正文快）`,
      });
    }
  }
  // I-4：伏笔自述统计必须与条目数一致 —— 作者自述第一次可以被软件核对。
  // 自述留空（模板默认「待填写」）＝没有自述，不报；只提示，不改写用户文档。
  try {
    const fp = join(projectDocsDir(projectRoot), FORESHADOW_DOC);
    if (await fs.exists(fp)) {
      const counts = countForeshadowing(await fs.readText(fp));
      if (counts.mismatches.length > 0) {
        issues.push({
          level: "warn",
          check: "foreshadow-count-mismatch",
          message: `追踪-伏笔.md 自述统计与条目数不一致：${counts.mismatches[0]}`,
        });
      }
    }
  } catch {
    /* 读失败（占用/非 UTF-8）不阻断校验 */
  }
  return issues;
}

/**
 * 读取并解析作品的 00-项目状态.md（I-3）。
 * 文件不存在 / 读不出 / 形态不认（解析出空字段）→ null：调用方按"没有状态信息"处理。
 */
export async function readProjectStatus(
  fs: FsBridge,
  projectRoot: string,
): Promise<ProjectStatus | null> {
  const p = join(projectDocsDir(projectRoot), STATE_DOC);
  if (!(await fs.exists(p))) return null;
  try {
    const st = parseProjectStatus(await fs.readText(p));
    return Object.keys(st.fields).length > 0 ? st : null;
  } catch {
    return null; // 读失败（占用/非 UTF-8）按"没有状态信息"处理，绝不抛给调用方
  }
}

/**
 * 从候选/章节文件名提取章号标签（如 `第3章-v2-候选.md` → `第3章`）；无法识别返回 null。
 * 数字字符类与 chapter.ts 的 CHAPTER_RE 保持一致（含中文数字与繁体大写 壹贰叁…），
 * 标签按文件名原文截取（全角数字不做半角化），仅去除内部空白。
 */
export function chapterLabelOf(fileName: string): string | null {
  const m = /^第\s*[0-9０-９零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟萬]+\s*[章节卷回部集]/.exec(stripMd(fileName));
  return m ? m[0].replace(/\s+/g, "") : null;
}
