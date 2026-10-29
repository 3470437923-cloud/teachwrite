/**
 * 技能注册表。
 *
 * 技能的权威清单在配置键 `skill_list`（既有格式：元素含 id/name/description/directoryPath/
 * isBuiltIn/marketplaceSkillId/marketplaceVersion），不在目录扫描结果里。
 *
 * 注入格式（**实际字节，不是理想排版**）：
 *   `## Available Skills\n\n技能按需加载。…\n\n<available_skills>\n`
 *   + 每个技能：`  <skill>` + `    <name>…</name>` + `    <description>…</description>` + `  </skill>\n`
 *   + `</available_skills>`
 *   —— 注意这四段之间**没有换行**（KL-TL-01）：一个技能在提示词里是一整行
 *   `  <skill>    <name>甲</name>    <description>…</description>  </skill>`。
 *   标签本身完好，模型读得懂（标签间的空白无语义），但**与"逐字排版"的设想不符**。
 *   手里的证据不足以判定原产品到底发的是哪种（`cjk_exe.tsv` 只有含中文的字符串样本，
 *   纯 ASCII 片段天生不在里面；运行期请求体没有留档），故**保持现有字节不动**，
 *   只把注释改成与代码一致 —— 无据不改契约。
 *
 * skill_lookup 命中后回注的目录说明逐字。
 */

import type { FsBridge } from "../fsbridge";
import type { SkillMeta } from "../prefs";

/** 块头（逐字；末尾带 \n） */
export const AVAILABLE_SKILLS_HEADER =
  "## Available Skills\n\n技能按需加载。当用户请求与某个技能的使用场景匹配时，调用 `skill_lookup` 加载该技能的完整内容。参数 `skill_name` 必须一字不差地使用 `<name>` 中的技能名（不要改写、翻译或添加后缀）。\n\n<available_skills>\n";

/** 目录说明（逐字；开头与结尾都带 \n） */
export const SKILL_DIR_NOTE =
  "\n- 约定: `scripts/` 存放可执行脚本，`references/` 存放按需读取的文档，`assets/` 存放输出资源。\n- 该目录下的相对路径都基于此目录。\n- 可用文件(排除 SKILL.md，最多10个，完整列表可读目录):\n";

/** 技能清单注入块（无技能时返回空串，不注入空块）
 *  开关语义（「已开启 7 / 共 8」）：activeIds 非空 = 恰好注入这些；
 *  空 = 未做过选择，默认全部注入。 */
export function availableSkillsBlock(skills: SkillMeta[], activeIds?: string[]): string {
  const list =
    activeIds && activeIds.length > 0 ? skills.filter((s) => activeIds.includes(s.id)) : skills;
  if (list.length === 0) return "";

  let out = AVAILABLE_SKILLS_HEADER;
  for (const s of list) {
    out += "  <skill>";
    out += `    <name>${s.name}</name>`;
    out += `    <description>${s.description}</description>`;
    out += "  </skill>\n";
  }
  out += "</available_skills>";
  return out;
}

/** skill_lookup 的命中结果（content = SKILL.md 正文 + 逐字目录说明 + 文件清单） */
export interface SkillLookupHit {
  skill_name: string;
  content: string;
}

/** 按名字或 id 精确匹配（既有描述：The skill name exactly as shown in Available Skills, or the skill ID） */
export function findSkill(skills: SkillMeta[], nameOrId: string): SkillMeta | null {
  const q = nameOrId.trim();
  return skills.find((s) => s.name === q) ?? skills.find((s) => s.id === q) ?? null;
}

/**
 * 读取技能正文；命中后按逐字格式追加目录说明与文件清单（最多 10 个，排除 SKILL.md）。
 * 文件清单最多下探 3 层目录（depth 0..2），约定目录 scripts/references/assets 都在此深度内。
 * SKILL.md 缺失（技能目录被删/未释放）视为未命中，返回 null 由工具层报 "Skill not found"。
 */
export async function lookupSkill(
  fs: FsBridge,
  skills: SkillMeta[],
  nameOrId: string,
): Promise<SkillLookupHit | null> {
  const meta = findSkill(skills, nameOrId);
  if (!meta) return null;

  const skillFile = `${meta.directoryPath}\\SKILL.md`;
  if (!(await fs.exists(skillFile))) return null;
  const body = await fs.readText(skillFile);

  // 目录说明 + 最多 10 个可用文件（排除 SKILL.md；'/' 分隔的相对路径）
  let note = SKILL_DIR_NOTE;
  const files: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 2 || files.length >= 10) return;
    for (const e of await fs.list(dir)) {
      if (files.length >= 10) break;
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDir) {
        await walk(e.path, childRel, depth + 1);
      } else if (e.name !== "SKILL.md") {
        files.push(childRel);
      }
    }
  };
  await walk(meta.directoryPath, "", 0);
  for (const f of files) note += `- ${f}\n`;

  return { skill_name: meta.name, content: body + note };
}

/** 技能根目录（用于路径授权：技能目录直读） */
export function skillDirectory(meta: SkillMeta): string {
  return meta.directoryPath;
}
