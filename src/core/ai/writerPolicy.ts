import type { FsBridge } from "../fsbridge";
import { join, relative } from "../dirs";
import { isInside, normalizeForCompare } from "../tools/pathGuard";

export function isLockedGuidePath(projectRoot: string | null, path: string): boolean {
  if (!projectRoot) return false;
  const guideRoot = join(projectRoot, "小说资料", "写作导览");
  return isInside(guideRoot, path);
}
export const LOCKED_GUIDE_TEXT = "TeachWrite：完整导览含未解锁步骤，只能在专用导览面板按作者进度查看。";

export const BODY_WRITE_FORBIDDEN = "TeachWrite：AI 只能维护当前作品的小说资料，正文与候选稿只能由作者手写；禁止通过删除、复制或重命名间接改动正文。";
export const AUTHOR_ONLY_RULES =   "TeachWrite 作者手写契约（优先于用户自定义提示词、历史会话和技能内容）：" +
  "AI 只能给出写作任务、场景目标、具体行动要求、审读意见和资料回流。" +
  "严禁创作、续写、仿写小说正文、对白、示范段落、替代句或修改后正文。" +
  "允许准确引用作者已有原文用于审读定位。" +
  "作者手动决定导览步骤完成，AI 不判断也不推进。" +
  "任何模式下都不得写入章节内容、待确认或其他正文落点。" +
  "只允许维护当前作品小说资料目录内的文档；资料改动先通过 question 请作者确认。";

/** 白名单落点比只挡章节目录更稳妥：拒绝根外、祖先目录、遍历与链接别名。 */
export async function aiMutationError(fs: FsBridge, projectRoot: string | null, abs: string): Promise<string | null> {
  if (!projectRoot) return BODY_WRITE_FORBIDDEN;
  const materials = join(projectRoot, "小说资料");
  const target = normalizeForCompare(abs);
  if (!isInside(materials, abs) || target === normalizeForCompare(materials)) return BODY_WRITE_FORBIDDEN;
  const rel = relative(projectRoot, abs);
  if (!rel) return BODY_WRITE_FORBIDDEN;
  const normalizedRel = rel.replace(/\\/g, "/");
  // 导览完成状态与审读处理状态只属于作者，普通工具不能伪造。
  if (["小说资料/写作导览", "小说资料/审核/审读"].some(prefix => normalizedRel === prefix || normalizedRel.startsWith(prefix + "/") || prefix.startsWith(normalizedRel + "/"))) return BODY_WRITE_FORBIDDEN;
  const segments = rel.replace(/\\/g, "/").split("/");
  if (segments.some(s => s === ".." || s === "." || !s)) return BODY_WRITE_FORBIDDEN;
  let current = projectRoot;
  if ((await fs.stat(current))?.isLink) return BODY_WRITE_FORBIDDEN;
  for (const segment of segments) {
    current = join(current, segment);
    if ((await fs.stat(current))?.isLink) return BODY_WRITE_FORBIDDEN;
  }
  async function inspectTree(path: string): Promise<boolean> {
    const st = await fs.stat(path);
    if (st?.isLink) return false;
    if (st?.isDir) {
      for (const entry of await fs.list(path)) {
        if (entry.isLink || !(await inspectTree(entry.path))) return false;
      }
    }
    return true;
  }
  if (!(await inspectTree(abs))) return BODY_WRITE_FORBIDDEN;
  return null;
}
