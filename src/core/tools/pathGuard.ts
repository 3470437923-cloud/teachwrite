/**
 * 路径分级授权。
 *
 * 三个授权根：projectRoot / skillsDir / booksRoot —— 根内及子目录**直读**，
 * 根外必须用户确认。判定用归一化路径，**I/O 保留调用方大小写**。
 *
 * 确认机制（B-1）：由 exec.ts 的 guardWithConfirm 接线 —— ToolContext.confirmExternal
 * 装配时，根外路径弹窗询问用户，批准后并入 allowedDirs（会话内持续生效）；
 * 未装配（测试/预览替身）时根外一律拒绝，文案保持逐字前缀：
 *   `路径在项目/skill 目录外，需用户确认，但确认机制未启用: `
 */

import { IS_WINDOWS, PATH_SEP, join, isDriveRoot, relative } from "../dirs";

/** 授权判定用的根集合：三个固定授权根 + 本次会话中用户明确授权的额外目录 */
export interface GuardRoots {
  projectRoot: string | null;
  skillsDir: string;
  booksRoot: string;
  /** 本次会话中用户已明确授权的额外目录（前缀匹配） */
  allowedDirs?: string[];
}

export interface ResolvedPath {
  /** 用于 I/O 的绝对路径（保留调用方大小写与 '..' 原样，不做词法折叠） */
  abs: string;
  /** 相对项目根的路径（本机分隔符）；不在项目内为 null */
  rel: string | null;
  /** 相对路径输入的解析基准（projectRoot，缺省 booksRoot）；绝对路径输入为 null */
  base: string | null;
}

/** 根外拒绝文案的逐字前缀（回归锁：调用方与测试都按前缀断言，不可改动） */
export const NEEDS_CONFIRMATION_PREFIX = "路径在项目/skill 目录外，需用户确认，但确认机制未启用: ";

/**
 * 把两种分隔符都归一为**本机分隔符**。
 *
 * 为什么输入侧必须做这件事：`file_read(list)` 的条目 `path` 是**工具协议格式**
 * （`章节内容\第1章.md`，见 exec.ts 与 docs 的实证样本），模型会把该字符串原样
 * 回传成 `path` 参数。在 macOS 上若不做归一，`\` 是**合法文件名字符**，
 * `join(base, "章节内容\第1章.md")` 会拼出「一个名叫 `章节内容\第1章.md` 的文件」，
 * 必然读不到 —— 老样本/老会话里的相对路径会整批失联。
 * Windows 上把 `/` 归一为 `\` 是既有行为，逐字不变。
 */
function unifySep(p: string): string {
  return PATH_SEP === "\\" ? p.replace(/\//g, "\\") : p.replace(/\\/g, "/");
}

/**
 * 路径归一化：统一分隔符、折叠 '.' 与 '..'、去空段、转小写。
 * **仅用于授权判定**；任何 I/O 与结果回报都必须用原路径（保留调用方大小写）。
 * '..' 采用词法回退：连续 '..' 可以把盘符也抵消掉（C:\..\x → "x"），
 * 归一化结果不再与任何授权根同形，穿越路径会落入"根外需确认"而不会放行。
 *
 * 输出用**本机分隔符**：Windows 保持 `\`（既有行为逐字不变）；
 * POSIX 用 `/` —— 否则 `isInside` 的边界前缀匹配在 macOS 上永远不成立
 * （根是 `/Users/...`，拼出来的边界却是 `/Users/...\`），根内路径会被整批误拒。
 */
export function normalizeForCompare(p: string): string {
  const unified = unifySep(p);
  const parts: string[] = [];
  for (const seg of unified.split(PATH_SEP)) {
    if (seg === "" || seg === ".") continue; // 连续/尾部分隔符与 '.' 无语义
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join(PATH_SEP).toLowerCase();
}

/**
 * 判定 target 是否为 root 本身或其子路径。
 * 大小写不敏感；边界以本机分隔符对齐（root + SEP 前缀匹配），避免 C:\ab 被误判进 C:\a。
 * 空 root 不授权任何路径。
 */
export function isInside(root: string, target: string): boolean {
  if (!root) return false;
  const r = normalizeForCompare(root);
  const t = normalizeForCompare(target);
  return t === r || t.startsWith(r + PATH_SEP);
}

/**
 * 解析工具传入的路径：
 *  - 相对路径 → 相对 projectRoot（未绑定项目时退到 booksRoot）拼接；
 *  - 绝对路径（盘符 `C:\`、UNC `\\server\share`、POSIX `/` 开头）→ 原样保留，
 *    仅按**本机**口径统一分隔符（POSIX 上绝不把 `/` 换成 `\`）；
 *  - 传入目录（"" / "." / "./" / ".\"）→ 解析为项目根。
 * 返回的 abs 不做 '..' 折叠（I/O 用调用方原样）；授权判定由 guardPath 归一化后做。
 */
export function resolveToolPath(input: string, roots: GuardRoots): ResolvedPath {
  const raw = (input ?? "").trim();
  const isAbs = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/");

  if (raw === "" || raw === "." || raw === "./" || raw === ".\\") {
    const base = roots.projectRoot ?? roots.booksRoot;
    return { abs: base, rel: roots.projectRoot ? "" : null, base };
  }
  if (isAbs) {
    // 绝对路径：POSIX 上保持 `/`（`/Users/x/书/小说资料/a.md` 换成 `\` 之后
    // 交给 Rust 就是「相对路径 + 字面反斜杠」，必然读不到）；Windows 上保持既有 `\`。
    const abs = unifySep(raw);
    return { abs, rel: roots.projectRoot ? relative(roots.projectRoot, abs) : null, base: null };
  }
  const base = roots.projectRoot ?? roots.booksRoot;
  const abs = join(base, unifySep(raw));
  return { abs, rel: roots.projectRoot ? relative(roots.projectRoot, abs) : null, base };
}

export interface GuardDecision {
  ok: boolean;
  /** 拒绝时的逐字文案 */
  message?: string;
  resolved: ResolvedPath;
}

/**
 * 判定路径是否可直接访问：三授权根（projectRoot / skillsDir / booksRoot）
 * 与会话内追加授权目录（allowedDirs，前缀匹配）之内 → 放行；
 * 盘符根与一切根外路径 → ok:false + 逐字"需确认"文案（确认机制未启用即拒绝）。
 */
export function guardPath(input: string, roots: GuardRoots): GuardDecision {
  const resolved = resolveToolPath(input, roots);
  const abs = resolved.abs;

  // NTFS 备用数据流（ADS）：`第1章.md:payload` 会写进文件的隐藏流里 ——
  // 授权根判定看的是主路径，这种"根内路径 + 冒号尾巴"能绕过一切目录检查，
  // 而写入必然失败（或更糟：静默写进 ADS）。盘符后的那个冒号（`C:\`）是合法的，
  // 所以只在去掉盘符前缀之后再找冒号。
  //
  // **仅 Windows**：POSIX 上冒号是合法文件名字符（Finder 把它显示成 `/`），
  // 且路径以 `/` 开头、根本没有盘符可剥，冒号检查会落在**整条路径**上 ——
  // 一个名叫 `第1章:初稿.md` 的正常文件会被整批误拒。
  if (IS_WINDOWS) {
    const afterDrive = /^[A-Za-z]:/.test(abs) ? abs.slice(2) : abs;
    if (afterDrive.includes(":")) {
      return { ok: false, message: `路径里的冒号不合法（NTFS 备用数据流）：${input}`, resolved };
    }
  }

  // 盘符根（C:\ 等）范围过大，即使恰好是某授权根的祖先也一律要求确认
  if (isDriveRoot(abs)) {
    return { ok: false, message: NEEDS_CONFIRMATION_PREFIX + abs, resolved };
  }
  const authorized = [
    roots.projectRoot,
    roots.skillsDir,
    roots.booksRoot,
    ...(roots.allowedDirs ?? []),
  ].filter((r): r is string => Boolean(r));

  for (const root of authorized) {
    if (isInside(root, abs)) return { ok: true, resolved };
  }
  return { ok: false, message: NEEDS_CONFIRMATION_PREFIX + abs, resolved };
}

/**
 * 工具结果里汇报给模型的路径：
 * 项目内 → 相对项目根（'/' 分隔，根本身回报 "."）；
 * 项目外（含技能目录等其它授权根）→ 原样绝对路径。
 */
export function reportPath(resolved: ResolvedPath): string {
  if (resolved.rel !== null) return resolved.rel === "" ? "." : resolved.rel.replace(/\\/g, "/");
  return resolved.abs;
}
