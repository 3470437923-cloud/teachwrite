import type { FsBridge } from "../fsbridge";
import { joinWith, PROJECT_DIRS } from "../dirs";

const trustedDirectories = [
  [PROJECT_DIRS.docs, "写作导览"],
  [PROJECT_DIRS.docs, PROJECT_DIRS.review, "审读"],
  [PROJECT_DIRS.oplog, "teachwrite"],
];

function fail(reason: string): never {
  throw new Error("教学路径不可信：" + reason);
}

// 不折叠 . 或 .. 后再授权：调用方仍用原串做 I/O，检查和实际访问必须是同一条路径。
function canonicalPath(value: string) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) fail("需要规范绝对路径");
  let anchor: string;
  let separator: string;
  if (/^[A-Za-z]:\\/.test(value)) { anchor = value.slice(0, 3); separator = "\\"; }
  else if (value.startsWith("\\\\")) { anchor = "\\\\"; separator = "\\"; }
  else if (value.startsWith("/") && !value.startsWith("//")) { anchor = "/"; separator = "/"; }
  else fail("需要规范绝对路径");
  const remainder = value.slice(anchor.length);
  const segments = remainder ? remainder.split(separator) : [];
  if (anchor === "\\\\" && segments.length < 2) fail("UNC 路径缺少共享目录");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || (separator === "/" && segment.includes("\\"))) fail("不允许空段、穿越或非规范分隔符");
    if (separator === "\\" && (/[<>:"/|?*]/.test(segment) || /[ .]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) fail("不允许 Windows 路径别名或数据流");
  }
  return { anchor, separator, segments };
}

/**
 * 仅供教学类型化保存/读取调用，三个专用目录自身或其后代才允许访问。
 * 从作品根到目标逐层 lstat；目录不存在可由正常保存创建，已存在的链接（包括悬空链接）一律拒绝。
 * FsBridge 没有 no-follow 原子打开；此检查不替代跨进程恶意并发改路径的原语级防护。
 */
export async function assertTrustedTeachingPath(fs: FsBridge, root: string, target: string): Promise<void> {
  const base = canonicalPath(root);
  const destination = canonicalPath(target);
  const compare = (value: string) => base.separator === "\\" ? value.toLowerCase() : value;
  if (base.separator !== destination.separator || compare(base.anchor) !== compare(destination.anchor) || base.segments.some((segment, index) => compare(segment) !== compare(destination.segments[index] ?? ""))) fail("目标不在当前作品内");
  const relative = destination.segments.slice(base.segments.length);
  const typed = trustedDirectories.find(directory => directory.every((segment, index) => compare(segment) === compare(relative[index] ?? "")));
  if (!typed) fail("目标不在导览、审读或归档专用目录");
  let current = root;
  const rootStat = await fs.stat(current);
  if (rootStat?.isLink) fail("作品根是链接");
  if (rootStat && !rootStat.isDir) fail("作品根必须为目录");
  for (let index = 0; index < relative.length; index++) {
    current = joinWith(base.separator, current, relative[index]);
    const stat = await fs.stat(current);
    if (stat?.isLink) fail("目标或祖先目录是链接");
    if (stat && !stat.isDir && (index < relative.length - 1 || relative.length === typed.length)) fail("祖先或专用目录不是目录");
  }
}
