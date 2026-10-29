/**
 * 00-项目状态.md 的结构化读取（I-3 销项）。
 *
 * 背景：14 件套模板把「待填写」当**内容**而不是状态 —— 填充完成后，应用只能
 * 把整份文档丢给模型读，自己判断不了写作进度。本模块只做一件事：把头部
 * `- 键：值` 行解析成字段表，让应用能直接问这两件事：
 *   · 正文处理进度到哪一步（未开始／起草中／待逐段修改／修改复读中／待用户确认）
 *   · 当前章节（模板口径 = **下一个要写的章**，如 `第012章`）
 *
 * 纪律（与「格式优先」同一条）：**只读不写**，不纠正、不补字段；认不出的形态
 * 一律返回空字段，绝不猜测、绝不抛异常 —— 用户改过格式就以用户当前文件为准。
 *
 * 解析范围只到第一个**二级**标题为止（`# 项目状态` 这行一级标题下面仍是头部字段区）：
 * `## 开书大纲自检` 等分节里也有 `- 状态：…` 这种行，它们不是头部字段，
 * 混进来会把「状态」当成进度。
 */

import { parseChapterName } from "./chapter";

export interface ProjectStatus {
  /** 头部 `- 键：值` 的全部字段（键与值都 trim、去行尾 CR；同名键取首个） */
  fields: Record<string, string>;
  /** 当前阶段（开书准备 / 开书自检 / 连续写作 / 收尾） */
  stage: string;
  /** 当前章节（模板口径：下一个要写的章） */
  chapter: string;
  /** 正文处理进度 */
  progress: string;
  /** 下一步 */
  nextStep: string;
  /**
   * 启用的追踪模块（D-043）：00 头部「- 启用模块：伏笔、角色状态」的解析结果；
   * **null = 没有这一行（老作品），按盘上实际存在的文件为准，不做缺失判定**。
   */
  modules: string[] | null;
}

/** 「启用模块」字段值的解析：顿号/逗号/分号分隔，「无」与空值 = 空数组 */
export function parseModuleList(raw: string): string[] {
  const t = raw.trim();
  if (t === "" || t === "无") return [];
  return t
    .split(/[、，,;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 头部字段行：允许全角「：」与半角「:」，键里不含冒号 */
const FIELD_RE = /^-\s*([^：:]+?)\s*[：:]\s*(.*)$/;
/** 分节起点：**二级及以下**标题（一级 `# 项目状态` 是文档标题，其下仍是头部字段区） */
const SECTION_RE = /^#{2,6}\s/;

/** 解析 00-项目状态.md 的头部字段（分节区不参与）；任何形态都安全返回 */
export function parseProjectStatus(text: string): ProjectStatus {
  const fields: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (SECTION_RE.test(line)) break; // 进入分节区：`- 状态：` 之类的行不属于头部
    const m = FIELD_RE.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    if (key === "" || key in fields) continue; // 同名键保留首个（重复行不覆盖）
    fields[key] = m[2].trim();
  }
  return {
    fields,
    stage: fields["当前阶段"] ?? "",
    chapter: fields["当前章节"] ?? "",
    progress: fields["正文处理进度"] ?? "",
    nextStep: fields["下一步"] ?? "",
    modules: "启用模块" in fields ? parseModuleList(fields["启用模块"]) : null,
  };
}

/** 状态文档是否还是"没动过"的初始态（阶段=开书准备 且 进度=未开始） */
export function isStatusUntouched(s: ProjectStatus): boolean {
  return s.stage === "开书准备" && s.progress === "未开始";
}

/** 状态声明的章号（解析不出返回 null）。模板口径：当前章节 = 下一个要写的章 */
export function statusChapterNo(s: ProjectStatus): number | null {
  const c = parseChapterName(s.chapter.trim());
  return c?.no ?? null;
}

/**
 * 定点写「启用模块」行（B8 建仓/停用的落点；格式优先：只动这一行，其余字节不变）。
 * 已有该行 → 整行替换；没有（老作品）→ 插在「- 当前章节：」行之后；连当前章节行都没有 → null
 * （文档形态不认，交给调用方放弃而不是硬塞）。
 */
export function setModulesInStateDoc(text: string, modules: readonly string[]): string | null {
  const lines = text.split("\n");
  const body = `- 启用模块：${modules.length > 0 ? modules.join("、") : "无"}`;
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s*启用模块\s*[：:]/.test(lines[i])) {
      // 保留原行的行尾形态（CRLF 文件的行尾 \r 不能丢）
      lines[i] = body + (lines[i].endsWith("\r") ? "\r" : "");
      return lines.join("\n");
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s*当前章节\s*[：:]/.test(lines[i])) {
      lines.splice(i + 1, 0, body + (lines[i].endsWith("\r") ? "\r" : ""));
      return lines.join("\n");
    }
  }
  return null;
}
