/**
 * 技能扫描：读取技能根目录（即 Documents\skills），解析 SKILL.md frontmatter，
 * 生成 skill_list（prefs 键，既有格式：元素含 id/name/description/directoryPath/
 * isBuiltIn/marketplaceSkillId/marketplaceVersion）。
 *
 * frontmatter 实测格式（Documents\skills\novel-writer\SKILL.md）：
 *   ---\nname: novel-writer\ndescription: …\n---
 * id 取目录名（稳定、可复现）。isBuiltIn = name 属于「内置」组
 * （设置页实测：内置 2 = novel-writer / skill-creator）。
 * 扫描为只读；写入 skillsDir 属于后续批次（资产释放）。
 */

import type { FsBridge } from "../fsbridge";
import type { SkillMeta } from "../prefs";

/** 内置技能名单（A-8）：必须与 `assets/builtin-skills/` 实际随包的 5 个目录一致 ——
 *  少一个就会有随包技能落进「自定义」分组（与 README 的「内置技能（5 个）」自相矛盾）。
 *  回归锁 `tests/core/skillsBuiltin.test.ts` 把这份名单与真实资产目录钉在一起。
 *  （旧注释记的「设置页实测内置 2 个」是更名前的旧产品口径：那时资产没有发布链路，
 *  用户机上只有 2 个技能目录，所以只看到 2 个内置。） */
export const BUILTIN_SKILL_NAMES = new Set([
  "novel-writer",
  "novel-deslop",
  "novel-structure-quality-coordinator",
  "skill-creator",
  "token-optimizer",
]);

/** N-31：围栏行判定 —— 整行**恰好**三个连字符（允许尾随空白与 CR）。
 *  旧实现用 `indexOf("\n---")` 找闭合围栏，任何以 `---` 开头的行都会被误当围栏：
 *  `----`（正文分隔线）会把文件头误判成 frontmatter 开出 phantom 技能，
 *  `---not-a-fence` 会提前闭合、丢掉后半段字段。逐行判定后两者都不再命中。 */
function isFenceLine(line: string): boolean {
  return /^---\s*$/.test(line.replace(/\r$/, ""));
}

/** A-8：剥 YAML 单行值的成对首尾引号（"…" / '…'）。
 *  token-optimizer 的 description 带引号书写，旧实现把字面引号原样注入
 *  系统提示词。只做"成对即剥"的简单标量口径：不成对、内部转义引号不做
 *  完整 YAML 解析（技能描述里没有这种写法的实际样本，不为此上解析器）。 */
function stripYamlQuotes(v: string): string {
  if (v.length >= 2) {
    const a = v[0];
    const b = v[v.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return v.slice(1, -1);
  }
  return v;
}

/**
 * 解析 SKILL.md 头部 frontmatter 的 name/description（单行值）。
 * 容错口径：BOM 先剥（记事本等编辑器存 UTF-8 带 BOM 时，围栏判定会失效）；
 * 无 frontmatter / 围栏未闭合 / 行不是 `key: value` 形态 → 一律返回空值，
 * 由调用方（scanSkills）跳过该目录，绝不抛异常。
 * 已知字段之外的 frontmatter 键（triggers/version/agent_created 等扩展字段）
 * **有意丢弃**：skill_list 是封闭的既有格式（prefs 契约），不为扩展字段破例。
 */
export function parseFrontmatter(text: string): { name: string; description: string } {
  let name = "";
  let description = "";
  const t = text.replace(/^\uFEFF/, "");
  const lines = t.split("\n");
  if (lines.length > 0 && isFenceLine(lines[0])) {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (isFenceLine(lines[i])) {
        end = i;
        break;
      }
    }
    // 围栏未闭合 → 保持空值（与旧口径一致：宁可不认，不认半个）
    for (let i = 1; end > 0 && i < end; i++) {
      const m = /^(\w+)\s*:\s*(.*)$/.exec(lines[i].replace(/\r$/, "").trim());
      if (!m) continue;
      const v = stripYamlQuotes(m[2].trim());
      if (m[1] === "name") name = v;
      else if (m[1] === "description") description = v;
    }
  }
  return { name, description };
}

/** 扫描技能根目录；目录缺 SKILL.md 或 name 为空时跳过（不报错）。
 *  id 取目录名（稳定、可复现，不随 frontmatter name 改名而漂移）。 */
export async function scanSkills(fs: FsBridge, skillsDir: string): Promise<SkillMeta[]> {
  const out: SkillMeta[] = [];
  let entries;
  try {
    entries = await fs.list(skillsDir);
  } catch {
    return out; // 技能根不可读（未释放/被占用）时按"无技能"处理，不阻断启动
  }
  for (const e of entries) {
    if (!e.isDir) continue; // 只有目录才是技能
    const skillFile = `${e.path}\\SKILL.md`;
    if (!(await fs.exists(skillFile))) continue;
    let text = "";
    try {
      text = await fs.readText(skillFile);
    } catch {
      continue; // 读失败视为坏技能目录，跳过
    }
    const { name, description } = parseFrontmatter(text);
    if (name === "") continue; // 无 name 无法被 skill_lookup 精确引用，跳过
    out.push({
      id: e.name,
      name,
      description,
      directoryPath: e.path,
      isBuiltIn: BUILTIN_SKILL_NAMES.has(name),
      marketplaceSkillId: null,
      marketplaceVersion: null,
    });
  }
  return out;
}

/**
 * 合并扫描结果与既有清单：skillList 以扫描（目录现实）为准，整体替换 ——
 *  - 目录里删掉的技能随之从清单消失；activeSkillIds 里残留的失效 id 无害
 *    （availableSkillsBlock 按现存 id 过滤，自动忽略），且刻意不清除：目录暂时
 *    不可见（如外接盘未挂载）时不丢用户勾选，目录回来即恢复；
 *  - 新增技能入库但默认不勾选（非首次不由系统替用户做决定）；
 *  - id 取目录名，旧清单整体被替换，不存在新旧 id 冲突的合并问题。
 * 开关状态：首次（旧清单为空）只默认开启内置白名单（novel-writer / skill-creator），
 * 非首次原样保留用户当前的 activeSkillIds。
 */
export function mergeSkillList(
  previous: SkillMeta[],
  scanned: SkillMeta[],
  currentActive: string[] = [],
): { skillList: SkillMeta[]; activeSkillIds: string[] } {
  const activeSkillIds =
    previous.length === 0
      ? scanned.filter((s) => BUILTIN_SKILL_NAMES.has(s.name)).map((s) => s.id)
      : currentActive;
  return { skillList: scanned, activeSkillIds };
}
