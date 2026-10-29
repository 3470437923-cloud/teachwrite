/**
 * 写入落点校验（D-043 / B6）：AI 经 file_write 写 小说资料/ 下的文件时，
 * 先过该文件的格式 schema —— 「AI 不得把不相干内容写进不相干文件」的执行层。
 *
 * 两条原则：
 *  - **变坏才拦**：某项规则在写入前就不满足（老作品的存量违规），本次写入不背锅，
 *    降级为警告；只有本次写入**引入或加重**违规才硬拒。否则老书会陷入"处处违规、
 *    一个字都改不了"的死锁。
 *  - **硬拒是教会，不是拒绝**：报错信息里带正确格式，AI 按提示重写即可。
 *
 * 校验范围：只查认识的文件名/命名形态（00、01、02、03、04-粗纲、06-写作风格、人物库、
 * 追踪-系列、细纲（第N-M章细纲）、个人改稿/规则台账.md）。审核/ 是自由格式区，不查；
 * 不认识的文档（用户自建、老作品旧名）不查。
 * 例外通道：AI 可用 question 征得用户同意后再写——本模块不认识那次提问，
 * 真正的例外由用户手动编辑完成（手动编辑不走 file_write，不受本门限制）。
 */

/** 校验结论（ok=false 时 message 必填，直接回给模型） */
export interface DocWriteVerdict {
  ok: boolean;
  message?: string;
  /** 软警告（写入仍成功；并入结果 JSON 的 warnings 字段） */
  warnings: string[];
}

interface Rule {
  id: string;
  /** hard = 引入/加重违规即拒收；warn = 只警告 */
  level: "hard" | "warn";
  /** 返回违规描述；合规返回 null */
  test: (content: string) => string | null;
  /** 硬拒时附带的正确格式提示 */
  hint: string;
  /**
   * 可数违规（框线/emoji 个数、表格行数）的数量口径：给定了就按「数量是否变多」判定加重，
   * 缺省按「有/无」判定。没有它，"既有 1 个 emoji 的文档再被加 1 个"会被误判成存量不背锅。
   */
  magnitude?: (content: string) => number;
}

const BOX_RE = /[─-╿▀-▟]/; // ── 框线字符区（U+2500–257F / U+2580–259F，与 style.ts 同口径）
// emoji 与装饰符号（与 style.ts 的 DECOR_RE 逐字同口径，保持两处判定一致）
const EMOJI_RE = /[🀀-🫿☀-➿■-◿⬀-⯿※️‍]/u;

/** 装饰字符计数（框线 + emoji/装饰符） */
function decorCount(text: string): number {
  return (text.match(new RegExp(BOX_RE, "g")) ?? []).length + (text.match(new RegExp(EMOJI_RE, "gu")) ?? []).length;
}

/** 全文表格行（| 开头） */
function tableLineCount(text: string): number {
  return text.split("\n").filter((l) => l.trim().startsWith("|")).length;
}

/** 全部二级标题 */
function h2Titles(text: string): string[] {
  return text.split("\n").map((l) => /^##\s+(.+)$/.exec(l.replace(/\r$/, ""))?.[1].trim()).filter((s): s is string => Boolean(s));
}

/** 全部 `### 标题` 块（`##` 起新块并结束当前 h3 块；`####` 不算 h3） */
function h3Blocks(text: string): { title: string; body: string }[] {
  const blocks: { title: string; body: string }[] = [];
  let cur: { title: string; body: string[] } | null = null;
  const flush = () => {
    if (cur) blocks.push({ title: cur.title, body: cur.body.join("\n") });
    cur = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^##\s+/.test(line)) {
      flush();
      continue;
    }
    const m = /^###\s+(.+)$/.exec(line);
    if (m) {
      flush();
      cur = { title: m[1].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  flush();
  return blocks;
}

/** 头部 `- 键：值` 的键集合（首个二级标题之前） */
function headerKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^#{2,6}\s/.test(line)) break;
    const m = /^-\s*([^：:]+?)\s*[：:]/.exec(line);
    if (m) keys.add(m[1].trim());
  }
  return keys;
}

/** 某个 `## 条目` 起头的块里是否含 `- 键：值` 字段行（条目块 = 到下一个同级标题为止） */
function entryBlocks(text: string): { title: string; body: string }[] {
  const lines = text.split("\n");
  const blocks: { title: string; body: string }[] = [];
  let cur: { title: string; body: string[] } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      if (cur) blocks.push({ title: cur.title, body: cur.body.join("\n") });
      cur = { title: m[1].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) blocks.push({ title: cur.title, body: cur.body.join("\n") });
  return blocks;
}

/** 装饰字符规则（所有受管文件共用）：写入不得让框线/emoji 变多 */
const DECOR_RULE: Rule = {
  id: "decor",
  level: "hard",
  test: (c) => (decorCount(c) > 0 ? `含 ${decorCount(c)} 个框线/emoji 装饰字符` : null),
  hint: "资料文件不用框线图、emoji 与装饰符号；分节用标题层级，强调靠措辞",
  magnitude: decorCount,
};

/** 表格禁令（叙述类文档用）：写入不得让表格行变多 */
const NO_TABLE_RULE: Rule = {
  id: "no-table",
  level: "hard",
  test: (c) => (tableLineCount(c) > 0 ? `含 ${tableLineCount(c)} 行表格` : null),
  hint: "该文件用自然段与固定字段书写，不用表格；追踪表保持 `- 键：值` 字段",
  magnitude: tableLineCount,
};

/** 00 的封闭头部必备字段（新旧结构交集，老作品也满足） */
const STATE_REQUIRED = ["当前阶段", "当前章节", "正文处理进度", "下一步"];

const STATE_RULE: Rule = {
  id: "state-fields",
  level: "hard",
  test: (c) => {
    const keys = headerKeys(c);
    const missing = STATE_REQUIRED.filter((k) => !keys.has(k));
    return missing.length > 0 ? `头部缺少必备字段：${missing.join("、")}` : null;
  },
  hint: "00-项目状态.md 的头部字段是封闭集合，机器按字段名读取；缺字段请补齐而不是删掉结构",
};

/** 01 的开书引导标签（七个，逐字） */
const POSITIONING_LABELS = [
  "目标平台与读者",
  "主类型与最想带给读者的感受",
  "一句话故事",
  "主角是谁，当前最想做成什么",
  "不行动或失败会失去什么",
  "开局发生的具体事件",
  "预计篇幅及依据",
];

const POSITIONING_RULE: Rule = {
  id: "positioning-labels",
  level: "hard",
  test: (c) => {
    const missing = POSITIONING_LABELS.filter((l) => !c.includes(`- ${l}：`));
    return missing.length > 0 ? `缺少开书引导字段：${missing.join("、")}` : null;
  },
  hint: "01-开书定位.md 的引导标签是应用开书向导的落点，必须逐字保留",
};

/** 02 的三节（逐字） */
const CORE_SECTIONS = ["世界与生活", "核心机制", "主线与边界"];

const CORE_RULE: Rule = {
  id: "core-sections",
  level: "hard",
  test: (c) => {
    const missing = CORE_SECTIONS.filter((s) => !h2Titles(c).includes(s));
    return missing.length > 0 ? `缺少固定节：${missing.join("、")}` : null;
  },
  hint: "02-核心设定.md 固定三节：世界与生活 / 核心机制 / 主线与边界",
};

/** 04-粗纲：只允许弧段标题「## 第N-M章 弧段名」 */
const ROUGH_ARC_RE = /^第\s*\S+[-–—~～]\S+\s*章/;
const ROUGH_RULE: Rule = {
  id: "rough-arcs",
  level: "hard",
  test: (c) => {
    const bad = h2Titles(c).filter((t) => !ROUGH_ARC_RE.test(t));
    return bad.length > 0 ? `含非弧段标题：${bad.join("、")}` : null;
  },
  hint: "04-粗纲.md 只有「## 第N-M章 弧段名 + 一段缩略内容」一种块，逐场细节放 细纲/",
};

/** 06-写作风格：只有两节 */
const STYLE_SECTIONS = ["风格规则", "禁用列表"];
const STYLE_RULE: Rule = {
  id: "style-sections",
  level: "hard",
  test: (c) => {
    const extra = h2Titles(c).filter((t) => !STYLE_SECTIONS.includes(t));
    return extra.length > 0 ? `含规定以外的节：${extra.join("、")}` : null;
  },
  hint: "06-写作风格.md 只有「风格规则」与「禁用列表」两节；流程纪律在 novel-writer 技能里，不写这里",
};

/**
 * 06「风格规则」的 SR 条目（2026-10-11 批 3 新格式）：`### SR-编号` + 三字段齐全。
 * **旧的自然段格式不受此约束**——老书没迁移也照旧合法（条目一个都没有 → 规则直接通过）。
 */
const STYLE_SR_FIELDS = ["规则分类", "规则来源", "具体内容"];
const STYLE_SR_RULE: Rule = {
  id: "style-sr-fields",
  level: "hard",
  test: (c) => {
    for (const b of h3Blocks(c)) {
      if (!/^SR-\d+$/.test(b.title)) continue;
      const missing = STYLE_SR_FIELDS.filter((f) => !new RegExp(`^-\\s*${f}\\s*[：:]`, "m").test(b.body));
      if (missing.length > 0) return `条目 ${b.title} 缺字段：${missing.join("、")}`;
    }
    return null;
  },
  hint: "06 的规则条目 = ### SR-编号 + 三个字段（规则分类/规则来源/具体内容）；旧的自然段格式不受此约束",
};

/** 人物库：语义错位软警告（条目标题不像人名） */
const NON_PERSON_RE = /世界|大陆|体系|法则|设定|组织|势力|地点|国家|门派|宗门|制度/;
const CAST_SEMANTIC_RULE: Rule = {
  id: "cast-nonperson",
  level: "warn",
  test: (c) => {
    const bad = h2Titles(c).filter((t) => NON_PERSON_RE.test(t));
    return bad.length > 0 ? `人物库条目「${bad.join("、")}」的标题不像人物名——世界观与设定请写进 02-核心设定.md` : null;
  },
  hint: "",
};

/** 00 的过程记录软警告 */
const STATE_PROCESS_RULE: Rule = {
  id: "state-process",
  level: "warn",
  test: (c) =>
    /导入说明|核对证据|遗疵|文档归位表/.test(c)
      ? "00-项目状态.md 含过程性记录（导入说明/核对证据/遗疵等）——过程记录该放 小说资料/审核/"
      : null,
  hint: "",
};

/** 追踪表：每个条目必须含 `- 状态：` 字段 */
const TRACKER_RULE: Rule = {
  id: "tracker-fields",
  level: "hard",
  test: (c) => {
    const bad = entryBlocks(c).filter((b) => b.title !== "伏笔统计" && !/^-\s*状态\s*[：:]/m.test(b.body));
    return bad.length > 0 ? `条目「${bad[0].title}」等缺少 - 状态： 字段` : null;
  },
  hint: "追踪表条目 = 「## 编号/人物名」+ 固定字段（含 - 状态：）；新增条目追加在文件末尾",
};

/** 细纲：必须有 `- 状态：` 头部字段 */
const XIGANG_RULE: Rule = {
  id: "xigang-status",
  level: "hard",
  test: (c) => (headerKeys(c).has("状态") ? null : "缺少头部字段「- 状态：进行中/未启动/已完成」"),
  hint: "细纲文件的头部必须有 - 状态： 字段；弧段写完改名为（已完成）并把状态行改为已完成",
};

/** 规则台账：GL 条目六字段齐全 */
const LEDGER_FIELDS = ["规则", "类别", "证据", "命中章节数", "状态", "最近更新"];
const LEDGER_RULE: Rule = {
  id: "ledger-fields",
  level: "hard",
  test: (c) => {
    for (const b of entryBlocks(c)) {
      if (!/^GL-\d+$/.test(b.title)) continue;
      const missing = LEDGER_FIELDS.filter((f) => !new RegExp(`^-\\s*${f}\\s*[：:]`, "m").test(b.body));
      if (missing.length > 0) return `条目 ${b.title} 缺字段：${missing.join("、")}`;
    }
    return null;
  },
  hint: "规则台账条目 = ## GL-编号 + 六个字段（规则/类别/证据/命中章节数/状态/最近更新）",
};

/** 按文件名取适用规则表（不认识的文件返回空 = 不校验） */
function rulesFor(fileName: string): Rule[] {
  if (fileName === "00-项目状态.md") return [DECOR_RULE, NO_TABLE_RULE, STATE_RULE, STATE_PROCESS_RULE];
  if (fileName === "01-开书定位.md") return [DECOR_RULE, NO_TABLE_RULE, POSITIONING_RULE];
  if (fileName === "02-核心设定.md") return [DECOR_RULE, NO_TABLE_RULE, CORE_RULE];
  if (fileName === "03-全书大纲.md") return [DECOR_RULE, NO_TABLE_RULE];
  if (fileName === "04-粗纲.md") return [DECOR_RULE, NO_TABLE_RULE, ROUGH_RULE];
  if (fileName === "06-写作风格.md") return [DECOR_RULE, NO_TABLE_RULE, STYLE_RULE, STYLE_SR_RULE];
  if (fileName === "人物库.md") return [DECOR_RULE, NO_TABLE_RULE, CAST_SEMANTIC_RULE];
  if (fileName.startsWith("追踪-")) return [DECOR_RULE, TRACKER_RULE];
  if (/^第.+[-–—~～].+章细纲(（已完成）)?\.md$/.test(fileName)) return [DECOR_RULE, NO_TABLE_RULE, XIGANG_RULE];
  if (fileName === "规则台账.md") return [DECOR_RULE, LEDGER_RULE];
  return [];
}

/**
 * 旧结构文件名 → 新结构替代（2026-10-06 用户裁决「以后只能是硬格式」）。
 * **新建**这些名字的文件一律硬拒并指向新名；编辑已存在的存量旧文件仍放行
 * （老作品没迁移前，AI 照旧按盘上实际文件工作，不锁死）。
 */
const LEGACY_FORBIDDEN_NEW: Record<string, string> = {
  "04-分卷大纲.md": "04-粗纲.md（弧段级：## 第N-M章 弧段名 + 一段缩略内容）",
  "05-滚动细纲.md": "细纲/第N-M章细纲.md（每份覆盖 3 章，完成改名（已完成））",
  "06-写作规则.md": "06-写作风格.md（只有「风格规则」与「禁用列表」两节）",
  "章节摘要.md": "细纲/ 栏目（已完成细纲即章节摘要的替身；旧摘要只在老作品里继续存在）",
};

/**
 * 校验一次写入（prev = 写入前的全文，新文件传 null）。
 * 变坏才拦：同一规则在 prev 上已违反 → 本次降级为警告（存量不背锅）；
 * prev 为 null（新文件）→ 任何违规都硬拒。
 */
export function validateDocWrite(fileName: string, next: string, previous: string | null): DocWriteVerdict {
  // 旧结构名新建拦截（先于一切规则；存量编辑走下面的常规规则，这些名字 rulesFor 为空 = 不拦）
  const replacedBy = LEGACY_FORBIDDEN_NEW[fileName];
  if (previous === null && replacedBy) {
    return {
      ok: false,
      message: `写入被拦截（${fileName} 是旧结构文件名，新作品一律使用新结构）：请改用 ${replacedBy}。`,
      warnings: [],
    };
  }
  const warnings: string[] = [];
  for (const rule of rulesFor(fileName)) {
    const badNext = rule.test(next);
    if (badNext === null) continue;
    // 变坏才拦：可数违规比较数量（加重了才算），其余比较有无；新文件（prev=null）任何违规都算引入
    const introduced = rule.magnitude
      ? rule.magnitude(next) > (previous === null ? 0 : rule.magnitude(previous))
      : previous === null || rule.test(previous) === null;
    if (rule.level === "hard" && introduced) {
      return {
        ok: false,
        message: `写入被拦截（${fileName} 落点校验）：${badNext}。${rule.hint}。把内容改成符合该文件格式后重试。`,
        warnings,
      };
    }
    warnings.push(introduced ? `${badNext}` : `${badNext}（存量既有问题，本次未加重）`);
  }
  return { ok: true, warnings };
}

/** 该相对路径（作品根相对，'\\' 分隔）是否落在校验范围内（小说资料下、非审核区） */
export function isValidatedDocPath(rel: string): boolean {
  const r = rel.replace(/\//g, "\\");
  if (!r.startsWith("小说资料\\")) return false;
  if (r.startsWith("小说资料\\审核\\")) return false;
  if (!r.toLowerCase().endsWith(".md")) return false;
  const base = r.split("\\").pop() ?? "";
  // 旧结构名也要进门：validateDocWrite 里有「禁止新建旧名」的拦截
  if (base in LEGACY_FORBIDDEN_NEW) return true;
  return rulesFor(base).length > 0;
}

/** 供 exec 层取规则数（测试用） */
export function docWriteRulesFor(fileName: string): number {
  return rulesFor(fileName).length;
}

/**
 * 受管文件名判定（D-056：左栏树内重命名/删除前的"这是受管文档"警告用）。
 * 受管 = 有落点校验规则（00、01、02、03、04粗纲、06写作风格、人物库、追踪表五份、
 * 细纲、规则台账）或旧结构名（04-分卷大纲、05-滚动细纲、06-写作规则、章节摘要）。
 * 附加文档（rulesFor 为空）不算受管，自由操作无警告。
 */
export function isManagedDocName(fileName: string): boolean {
  return fileName in LEGACY_FORBIDDEN_NEW || rulesFor(fileName).length > 0;
}
