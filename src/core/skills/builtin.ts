/**
 * A-8：内置技能资产（`assets/builtin-skills/`）的发布链路。
 *
 * 为什么必须内联：交付产物是**单文件 exe**（`release\DeepCompose.exe`，无安装目录、
 * 无随行资源目录），运行时磁盘上根本不存在 `assets/`。所以内置技能只能由构建期
 * 经 Vite 的 `import.meta.glob(..., { query: "?raw", eager: true })` 读成字符串
 * 打进 JS 包里 —— 这也是此前"5 个随包技能其实是死资产"（A-8）的根因：
 * 资产在仓库里齐全，却没有任何一条路径把它送到用户的技能根。
 *
 * 释放纪律（D-037）：
 *  - **只补缺失，绝不覆盖**：目标技能目录已存在 `SKILL.md` 就整体跳过。
 *    用户手改过的副本是最高权威（README 改代码前必读第 9 条），程序不覆盖；
 *    代价是内置技能升级不会自动替换旧副本，需要用户自行删除旧目录后重启。
 *  - 单个技能写失败不阻断其余技能：启动期尽力而为，缺哪个由扫描结果体现。
 *  - `__pycache__/` 与 `.pyc` 排除在外：它们是本机 gitignore 的编译产物，
 *    二进制按文本读出来只会是垃圾。
 */

import type { FsBridge } from "../fsbridge";
import { join } from "../dirs";

/** 资产在仓库中的位置前缀（glob 键以本文件为基准的相对路径） */
const ASSET_PREFIX = "assets/builtin-skills/";

const modules = import.meta.glob(["../../../assets/builtin-skills/**/*", "!**/__pycache__/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 资产相对路径是否为可释放的文本条目：段级安全检查（拒绝 `..`/`.`/空段，防目录穿越）
 *  + 排除本机编译产物（`__pycache__/`、`.pyc`）。 */
function isReleasableRel(rel: string): boolean {
  if (rel === "") return false;
  const segs = rel.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return false;
  if (segs.some((s) => s === "__pycache__")) return false;
  if (rel.toLowerCase().endsWith(".pyc")) return false;
  return true;
}

/** 相对 `<skillsDir>` 的资产路径（'/' 分隔，形如 `novel-writer/SKILL.md`）→ 文本内容 */
export const BUILTIN_SKILL_FILES: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [key, content] of Object.entries(modules)) {
    const norm = key.replace(/\\/g, "/");
    const at = norm.indexOf(ASSET_PREFIX);
    if (at < 0) continue;
    const rel = norm.slice(at + ASSET_PREFIX.length);
    if (!isReleasableRel(rel)) continue;
    out[rel] = content;
  }
  return out;
})();

/**
 * 把内置技能释放到技能根：只补齐缺失的技能目录，返回本次实际释放的技能名。
 * `files` 可注入（测试用）；默认用构建期内联的真实资产。
 */
export async function releaseBuiltinSkills(
  fs: FsBridge,
  skillsDir: string,
  files: Record<string, string> = BUILTIN_SKILL_FILES,
): Promise<string[]> {
  // 先按技能目录分组：`<技能名>/<技能内相对路径>`
  const bySkill = new Map<string, { rel: string; content: string }[]>();
  for (const [rel, content] of Object.entries(files)) {
    const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!isReleasableRel(norm)) continue;
    const slash = norm.indexOf("/");
    if (slash <= 0 || slash === norm.length - 1) continue; // 技能根下的散文件不算技能
    const name = norm.slice(0, slash);
    const inner = norm.slice(slash + 1);
    const list = bySkill.get(name);
    if (list) list.push({ rel: inner, content });
    else bySkill.set(name, [{ rel: inner, content }]);
  }

  const released: string[] = [];
  for (const [name, entries] of [...bySkill.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    try {
      // 用户副本优先：已存在即整体跳过（含升级场景，见文件头 D-037）
      if (await fs.exists(join(skillsDir, name, "SKILL.md"))) continue;
      for (const { rel, content } of entries) {
        // fs.writeText 契约：自动递归创建父目录
        await fs.writeText(join(skillsDir, name, ...rel.split("/")), content);
      }
      released.push(name);
    } catch {
      // 单个技能写失败（磁盘满/占用）不阻断其余技能
    }
  }
  return released;
}
