/**
 * 目录权威（唯一真源）。作品内冻结名保持兼容，应用数据独立于 DeepCompose。
 * Windows: %APPDATA%/com.teachwrite.desktop/
 * macOS: ~/Library/Application Support/com.teachwrite.desktop/
 * Linux: $XDG_DATA_HOME/com.teachwrite.desktop/（缺省 ~/.local/share/）
 * prefs、窗口状态、会话、快照、备忘录、技能、快捷提示词、统计和日志均在此根下。
 * 不读取或迁移 com.writerd/writerD 配置或 Documents 中的旧应用数据。
 */
export { IS_WINDOWS, PATH_SEP } from "./platform";
import { IS_WINDOWS, PATH_SEP } from "./platform";

/** 作品目录协议里用到的固定名（3.0 起含候选区与回流日志；旧名保留兼容） */
export const PROJECT_DIRS = {
  /** 维护文档目录 */
  docs: "小说资料",
  /** 章节目录（正式正文） */
  chapters: "章节内容",
  /** 候选稿目录（初稿/候选，采用后进正文） */
  pending: "待确认",
  /** 已处理旧稿归档（位于 待确认 下） */
  processed: "已处理",
  /** 冷读等审读报告（位于 小说资料 下） */
  review: "审核",
  /** 个人改稿学习记录（位于 小说资料 下） */
  revisions: "个人改稿",
  /** 用户操作日志（位于作品根下，系统级，左栏不显示） */
  oplog: "writerd_oplog",
  /** 回收站根（位于作品根下） */
  recycle: ".openwrite_recycle",
  /** 作品清单（显示名/排序） */
  manifest: ".openwrite_manifest.json",
  /** 回收站清单 */
  recycleManifest: "recycle_manifest.json",
} as const;

/** 系统级条目的判定规则表（**单一真源**：新增系统文件/目录时只在这里加一条，
 *  左栏目录树、内容扫描、回收站安全门全部走这张表，不再各写一份判定）。
 *  注意："writerd_" 前缀与 recycle_manifest.json 是磁盘契约判定，不可改名。 */
const SYSTEM_ENTRY_RULES: readonly { test: (name: string) => boolean; why: string }[] = [
  // '.' 开头：隐藏条目（含 .openwrite_recycle / .openwrite_manifest.json 两种身份文件）
  { test: (n) => n.startsWith("."), why: "隐藏条目（.openwrite_* 等）" },
  // writerd_ 前缀：应用数据（writerd_oplog 等，磁盘契约）
  { test: (n) => n.startsWith("writerd_"), why: "应用数据前缀（磁盘契约）" },
  // 回收站清单：位于回收站根、不带前缀的普通文件名，必须单列
  { test: (n) => n === PROJECT_DIRS.recycleManifest, why: "回收站清单（磁盘契约）" },
];

/** 系统级条目（左栏目录树与内容扫描一律排除；判定规则见 SYSTEM_ENTRY_RULES） */
export function isSystemEntryName(name: string): boolean {
  return SYSTEM_ENTRY_RULES.some((r) => r.test(name));
}

/** 应用数据保留兼容叶名，由 TeachWrite 专属根隔离；作品内冻结名不受影响。 */
export const APP_DATA_NAMES = {
  sessions: "writerd_sessions",
  snapshots: "writerd_snapshots",
  memos: "writerd_memos.json",
  skills: "skills",
  /** token 统计（DeepCompose 新增契约：additive，可随时删除，见 DECISIONS D-023） */
  usageStats: "usage_stats.json",
  /** 快捷提示词清单（B17，2026-10-06 新增契约：additive，可随时删除） */
  quickPrompts: "writerd_quick_prompts.json",
  prefsDir: ["com.teachwrite.desktop"],
  logDir: "diagnostics",
  logFile: "diagnostic.log",
} as const;

/** 默认作品根：%USERPROFILE%\AI写小说（实测路径，非推测） */
export const DEFAULT_BOOKS_DIR_NAME = "AI写小说";

export interface AppDirs {
  /** 作品根（用户可改，见 prefs `custom_novels_dir`） */
  booksRoot: string;
  /** 技能根 */
  skillsDir: string;
  /** 会话根 */
  sessionsDir: string;
  /** 快照根 */
  snapshotsDir: string;
  /** 备忘录单文件 */
  memosFile: string;
  /** 配置单文件 */
  prefsFile: string;
  /** 配置目录 */
  prefsDir: string;
  /** token 统计文件（`%APPDATA%\com.writerd\writerD\usage_stats.json`；additive 契约） */
  usageStatsFile: string;
  /** 快捷提示词清单（`<Documents>\writerd_quick_prompts.json`；additive 契约，B17） */
  quickPromptsFile: string;
  /** 诊断日志目录 */
  logDir: string;
  /** 诊断日志文件 */
  logFile: string;
}

export interface DirsInput {
  /** 用户主目录（Rust 侧 home_dir） */
  home: string;
  /** 文档目录（Rust 侧 document_dir） */
  documents: string;
  /** 漫游配置目录（Rust 侧 config_dir = %APPDATA%） */
  appData: string;
  /** 覆盖项：来自 prefs */
  booksRoot?: string | null;
  skillsDir?: string | null;
}

/* ─────────────────────────── 平台分隔符 ───────────────────────────
 * 磁盘契约名一个字不改，**只换基目录与分隔符**。
 * 本模块是全仓库唯一的路径拼接权威：所有派生路径（booksRoot / sessionsDir /
 * snapshotsDir / skillsDir / memosFile / prefsDir / usageStatsFile / 回收站）
 * 都经 `join` 产出，所以分隔符只在这里定一次。
 *
 * 平台判定本身在 `platform.ts`（唯一真源），这里只取用（并转发导出）—— 两处口径必须同源。
 */

/**
 * 路径拼接（平台分隔符）：去掉重复分隔符与尾部分隔符。
 * 首段保留前导分隔符（UNC 根 `\\server\share`、盘内绝对 `\a` 原样带过）；
 * 后续段剥掉首尾分隔符，剥空的段直接丢弃（否则 `join("a","\\","b")` 会拼出双分隔符）；
 * 结果以裸盘符结尾时补回盘符根形态 `C:\`（**仅 Windows** —— POSIX 上文件名可以
 * 以 `C:` 结尾，补 `\` 会把一个正常文件名弄坏）。
 *
 * 另有一条防御：首段是 `/` 开头的 POSIX 绝对路径时无条件用 `/` 拼。
 * 这样即使平台识别失败（未知 UA），Rust 侧递过来的 `/Users/...` 也不会被拼成
 * `/Users/me\AI写小说` —— 那是**单个目录名**，`create_dir_all` 会在家目录下
 * 建一个带反斜杠的怪目录，而全部派生路径同时失效。
 */
export function join(...parts: string[]): string {
  const first = parts.find((p) => p !== undefined && p !== null && p !== "");
  const sep = first && first.startsWith("/") ? "/" : PATH_SEP;
  return joinWith(sep, ...parts);
}

/** `join` 的显式分隔符版本（导出供测试在任意平台上验证另一种平台的拼法） */
export function joinWith(sep: string, ...parts: string[]): string {
  const cleaned: string[] = [];
  for (const p of parts) {
    if (p === undefined || p === null || p === "") continue;
    const isFirst = cleaned.length === 0;
    const seg = isFirst
      ? p.replace(/[\\/]+$/, "")
      : p.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
    if (seg === "" && !isFirst) continue;
    cleaned.push(seg);
  }
  const joined = cleaned.join(sep);
  // 保留盘符根的形态 C:\（Windows 专有：POSIX 上 "C:" 只是个合法文件名）
  return sep === "\\" ? joined.replace(/([A-Za-z]:)$/, "$1\\") : joined;
}

/**
 * 校验：不得选择磁盘根/系统根目录（逐字文案的判定条件）。
 *  - `C:` / `C:\` 盘符根与 `/`、`\\` 这类裸根形态；
 *  - POSIX 上追加两类"范围过大"的根（卷根/系统根）：文件系统根之下的**顶层目录**
 *    （`/Users`、`/Volumes`、`/Applications`…，其父目录就是 `/`）与**挂载卷根**
 *    （`/Volumes/<卷名>`）。判定纯词法、不做 I/O，只可能更严不可能更松。
 */
export function isDriveRoot(path: string, windows: boolean = IS_WINDOWS): boolean {
  const p = path.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(p) || /^[\\/]{1,2}$/.test(path)) return true;
  if (windows) return false;
  if (!p.startsWith("/")) return false; // 相对路径（"Users"）不是根
  const segs = p.split("/").filter(Boolean);
  if (segs.length === 1) return true; // "/Users"
  if (segs.length === 2 && segs[0] === "Volumes") return true; // "/Volumes/Backup"
  return false;
}

/** 取路径最后一段（先剥尾部分隔符；盘符根 "C:\" 返回 "C:"，UNC 根返回末级共享名） */
export function basename(path: string): string {
  const p = path.replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * 取父目录（盘符下第一段返回盘符根 "C:\"；无分隔符可剥时返回 ""）。
 * POSIX 顶层补正：`dirname("/Users")` 必须是 `/` 而不是空串 ——
 * 空串会污染 pathGuard 的授权目录上溯（exec.ts guardWithConfirm）与
 * rename/delete 的父目录计算，`dirname("/")` 同理。
 */
export function dirname(path: string): string {
  const p = path.replace(/[\\/]+$/, "");
  if (p === "") return path.startsWith("/") ? "/" : "";
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (i < 0) return "";
  if (i === 2 && /^[A-Za-z]:/.test(p)) return p.slice(0, 3);
  const parent = p.slice(0, i);
  if (parent === "" && path.startsWith("/")) return "/";
  return parent;
}

/**
 * 计算 target 相对 base 的路径（本机分隔符，保留调用方大小写）；不在 base 内返回 null。
 * 前缀比较大小写不敏感（Windows 语义；macOS 默认 APFS 也是大小写不敏感卷，
 * 保持一致更安全）；截取长度用**原串**而不是小写串——
 * toLowerCase 对个别 Unicode 字符（如 'İ'）会变长，拿小写长度切片会错位。
 */
export function relative(base: string, target: string): string | null {
  return relativeWith(PATH_SEP, base, target);
}

/** `relative` 的显式分隔符版本（导出供测试在任意平台上验证另一种平台的行为） */
export function relativeWith(sep: string, base: string, target: string): string | null {
  // 比较前把两种分隔符都归一为本机分隔符：与本模块 basename/dirname/join 接受
  // 两种分隔符的口径一致，混合分隔符输入（如 base 用 '\'、target 用 '/'）
  // 不该被误判成"不在 base 内"
  const canon = (s: string) => (sep === "\\" ? s.replace(/\//g, "\\") : s.replace(/\\/g, "/"));
  const bRaw = base.replace(/[\\/]+$/, "");
  const b = canon(bRaw).toLowerCase();
  const t = target.replace(/[\\/]+$/, "");
  const tl = canon(t).toLowerCase();
  if (tl === b) return "";
  if (!tl.startsWith(b + sep)) return null;
  return t.slice(bRaw.length + 1);
}

/** 由系统目录 + prefs 覆盖项推导全部应用目录（覆盖项为空/缺失时走默认路径） */
export function resolveDirs(input: DirsInput): AppDirs {
  const prefsDir = join(input.appData, ...APP_DATA_NAMES.prefsDir);
  const logDir = join(prefsDir, APP_DATA_NAMES.logDir);
  return {
    booksRoot: input.booksRoot || join(input.home, DEFAULT_BOOKS_DIR_NAME),
    skillsDir: input.skillsDir || join(prefsDir, APP_DATA_NAMES.skills),
    sessionsDir: join(prefsDir, APP_DATA_NAMES.sessions),
    snapshotsDir: join(prefsDir, APP_DATA_NAMES.snapshots),
    memosFile: join(prefsDir, APP_DATA_NAMES.memos),
    prefsDir,
    prefsFile: join(prefsDir, "shared_preferences.json"),
    usageStatsFile: join(prefsDir, APP_DATA_NAMES.usageStats),
    quickPromptsFile: join(prefsDir, APP_DATA_NAMES.quickPrompts),
    logDir,
    logFile: join(logDir, APP_DATA_NAMES.logFile),
  };
}

/** 维护文档目录（<作品根>\小说资料） */
export function projectDocsDir(projectRoot: string): string {
  return join(projectRoot, PROJECT_DIRS.docs);
}

/** 正式章节目录（<作品根>\章节内容，唯一事实源） */
export function projectChaptersDir(projectRoot: string): string {
  return join(projectRoot, PROJECT_DIRS.chapters);
}

/** 候选稿目录（<作品根>\待确认） */
export function projectPendingDir(projectRoot: string): string {
  return join(projectRoot, PROJECT_DIRS.pending);
}

/** 已处理旧稿归档（<作品根>\待确认\已处理） */
export function projectProcessedDir(projectRoot: string): string {
  return join(projectRoot, PROJECT_DIRS.pending, PROJECT_DIRS.processed);
}

/** 审读报告目录（<作品根>\小说资料\审核） */
export function projectReviewDir(projectRoot: string): string {
  return join(projectRoot, PROJECT_DIRS.docs, PROJECT_DIRS.review);
}

/** 个人改稿学习记录（<作品根>\小说资料\个人改稿） */
export function projectRevisionsDir(projectRoot: string): string {
  return join(projectRoot, PROJECT_DIRS.docs, PROJECT_DIRS.revisions);
}

/** 用户操作日志目录（<作品根>\writerd_oplog，系统级，左栏不显示；名为磁盘契约） */
export function projectOplogDir(projectRoot: string): string {
  return join(projectRoot, PROJECT_DIRS.oplog);
}

/** 作品清单文件（<作品根>\.openwrite_manifest.json） */
export function projectManifestFile(projectRoot: string): string {
  return join(projectRoot, PROJECT_DIRS.manifest);
}

/** 回收站根（作品根级：<booksRoot>\.openwrite_recycle） */
export function recycleRoot(booksRoot: string): string {
  return join(booksRoot, PROJECT_DIRS.recycle);
}

/** 回收站清单文件（<回收站根>\recycle_manifest.json） */
export function recycleManifestFile(booksRoot: string): string {
  return join(recycleRoot(booksRoot), PROJECT_DIRS.recycleManifest);
}
