/**
 * 资料形态体检（L2：把"文档胖不胖、符号脏不脏"变成可核的数字）。
 *
 * 短段落、少量字段与明确职责降低读取和增量回写的成本。
 * 形态只作诊断；场景篇幅计划是写作信息，不等于过程记录。
 *
 * 纪律（与「格式优先」同一条）：
 *  - **只报告，绝不改写**：本模块只产出提示，不动用户一个字符；
 *  - 判据真源在**代码**（本文件的预算表与阈值），文档只做解释与索引；
 *  - 阈值刻意宽松（宁可漏报也不误报）：超标是"该看一眼"，不是"错了"。
 */

/** 一条资料体检提示（形态与 project.ts 的 ProjectIssue 一致，便于直接并入作品校验） */
export interface MaterialIssue {
  level: "warn" | "info";
  /** 机器可读的检查名（稳定字符串，测试按它断言）。聚合后为 `material-shape` */
  check: string;
  /** 人话描述（界面直接展示） */
  message: string;
  /** 短标签（聚合用）：如「框线字符 495」「超预算 4.1 倍」 */
  label?: string;
}

/** 单份资料的形态预算（诊断阈值，不是写作目标或自动清理依据） */
export interface MaterialBudget {
  /** 单文件字符数上限 */
  maxChars: number;
  /** 表格行占比上限（0–1）。保留对旧版追踪表的宽容，不代表推荐表格 */
  maxTableRatio: number;
  /** 一句话职责（体检提示里回显，帮作者判断"这份该装什么"） */
  role: string;
}

/** 状态入口：指针 + 下一步，几乎不该出现表格 */
const STATUS_RATIO = 0.25;
/** 其余叙述与设定类文档：既有诊断阈值，新资料默认自然段 */
const NARRATIVE_RATIO = 0.3;
/** 兼容用户既有追踪矩阵，**不做占比判定**（1 = 不设限；配合 checkMaterial 的 `< 1` 判据） */
const MATRIX_RATIO = 1;

/**
 * 14 件套 + 已知附加文档的预算表。**键是磁盘文件名（逐字）**。
 * 长书按章数放大的文档（04/05/章节摘要/人物库/追踪-*）取的是"34 章规模"的上限，
 * 更长或更短的书可等比放宽/收紧——超出只会得到一条提示，不会被程序改写。
 */
export const MATERIAL_BUDGETS: Record<string, MaterialBudget> = {
  "00-项目状态.md": { maxChars: 1500, maxTableRatio: STATUS_RATIO, role: "状态入口：每章开工第一个读，只放指针与下一步" },
  "01-开书定位.md": { maxChars: 2500, maxTableRatio: NARRATIVE_RATIO, role: "开书定位：类型、读者、一句话故事" },
  "02-核心设定.md": { maxChars: 3000, maxTableRatio: NARRATIVE_RATIO, role: "世界规则、能力边界、主线" },
  "03-全书大纲.md": { maxChars: 6000, maxTableRatio: NARRATIVE_RATIO, role: "重大转折与结局方向，不写逐场次" },
  "04-分卷大纲.md": { maxChars: 14000, maxTableRatio: 0.5, role: "卷章概览：每卷目标与卷末新局面，每章一句；逐场细节放 05 或归档" },
  "04-粗纲.md": { maxChars: 8000, maxTableRatio: NARRATIVE_RATIO, role: "弧段级预测：每弧段一个标题加一段缩略内容，不写逐场细节" },
  "05-滚动细纲.md": { maxChars: 10000, maxTableRatio: 0.5, role: "近期场景细纲：只放未来3至5章，每章约四段自然段" },
  "06-写作规则.md": { maxChars: 4000, maxTableRatio: NARRATIVE_RATIO, role: "本书写作要求与个人文风沉淀" },
  "06-写作风格.md": { maxChars: 8000, maxTableRatio: NARRATIVE_RATIO, role: "本书特定风格要求（风格规则：### SR-编号 + 规则分类/规则来源/具体内容）加禁用列表；通用纪律在技能里" },
  "人物库.md": { maxChars: 18000, maxTableRatio: NARRATIVE_RATIO, role: "只存稳定特征；动态状态在追踪表" },
  "章节摘要.md": { maxChars: 15000, maxTableRatio: NARRATIVE_RATIO, role: "历史归档索引：每章一条简短摘要" },
  "追踪-伏笔.md": { maxChars: 20000, maxTableRatio: MATRIX_RATIO, role: "伏笔记录：F 编号、埋设与回收章节、状态" },
  "追踪-角色状态.md": { maxChars: 12000, maxTableRatio: MATRIX_RATIO, role: "角色动态状态记录" },
  "追踪-时间线.md": { maxChars: 10000, maxTableRatio: MATRIX_RATIO, role: "事件时间线记录" },
  "追踪-资源与权限.md": { maxChars: 10000, maxTableRatio: MATRIX_RATIO, role: "资源与权限当前值记录" },
  "追踪-废弃设定.md": { maxChars: 6000, maxTableRatio: MATRIX_RATIO, role: "禁止恢复的旧设定（D 编号）" },
};

/** 未登记文档（用户自建附加资料，如 世界观/风格规范/写作禁忌）的默认预算 */
export const EXTRA_DOC_BUDGET: MaterialBudget = {
  maxChars: 8000,
  maxTableRatio: NARRATIVE_RATIO,
  role: "用户自建附加资料（未登记预算，按默认上限）",
};

/** 取某文件的预算：登记过的用登记值，其余按附加文档默认值 */
export function budgetOf(name: string): MaterialBudget {
  return MATERIAL_BUDGETS[name] ?? EXTRA_DOC_BUDGET;
}

/** 单文件形态指标（全部为纯计数，不做语义判断） */
export interface MaterialMetrics {
  chars: number;
  lines: number;
  headings: number;
  tableLines: number;
  /** 表格行占非空行的比例（0–1） */
  tableRatio: number;
  /** 最长行字符数（超长行不利于 diff 与节内替换命中） */
  longestLine: number;
  /** 框线/方块字符（ASCII 图专用） */
  boxDrawing: number;
  /** emoji 与变体选择符 */
  emoji: number;
  /** `**粗体**` 对数 */
  boldPairs: number;
  /** `---` / `===` / `***` 这类装饰分节线行数 */
  hrLines: number;
  /** 箭头（当连接词使用） */
  arrows: number;
  /** 过程性标注：导入说明、核对证据、遗疵等；场景篇幅计划不算过程记录 */
  processNotes: number;
  /** 每千字结构符号数（框线+emoji+粗体×2+表格行+分节线+箭头），仅作密度提示 */
  structPer1000: number;
}

const BOX_RE = /[\u2500-\u257F\u2580-\u259F]/g;
/** 装饰性图形符号：emoji、杂项符号（✅✂⚠）、Dingbats、几何图形（●◆▲）、※ */
const DECOR_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}\u{203B}\u{FE0F}\u{200D}]/gu;
const ARROW_RE = /[\u2192\u2190\u2191\u2193\u21D2\u21D0]/g;
/** 过程性标注：与"作品事实"无关的流程记录痕迹 */
const PROCESS_RE = /导入说明|导入核对|核对证据|遗疵|文档归位表/g;
const HR_RE = /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/;

/** 量一份资料（纯函数，任何输入都安全返回） */
export function measureMaterial(text: string): MaterialMetrics {
  const lines = text.split("\n");
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  const chars = text.length;
  const boxDrawing = (text.match(BOX_RE) ?? []).length;
  const emoji = (text.match(DECOR_RE) ?? []).length;
  const arrows = (text.match(ARROW_RE) ?? []).length;
  const processNotes = (text.match(PROCESS_RE) ?? []).length;
  const boldPairs = Math.floor((text.match(/\*\*/g) ?? []).length / 2);
  const hrLines = lines.filter((l) => HR_RE.test(l)).length;
  const tableLines = lines.filter((l) => l.trim().startsWith("|")).length;
  const headings = lines.filter((l) => /^#{1,6}\s/.test(l)).length;
  const longestLine = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const structish = boxDrawing + emoji + boldPairs * 2 + tableLines + hrLines + arrows;
  return {
    chars,
    lines: lines.length,
    headings,
    tableLines,
    tableRatio: nonEmpty.length > 0 ? tableLines / nonEmpty.length : 0,
    longestLine,
    boxDrawing,
    emoji,
    boldPairs,
    hrLines,
    arrows,
    processNotes,
    structPer1000: chars > 0 ? (structish / chars) * 1000 : 0,
  };
}

/**
 * 体检一份资料，返回**逐条**提示（空数组 = 形态良好）。
 * 只做"可数"的判定：预算、框线、emoji/装饰符、过程标注、表格占比、装饰分节线、超长行。
 * 面向界面时用 `auditMaterials`（按文件聚合，避免一份文件刷出十几条把状态条淹没）。
 */
export function checkMaterial(name: string, text: string): MaterialIssue[] {
  const m = measureMaterial(text);
  const b = budgetOf(name);
  const out: MaterialIssue[] = [];
  const kind = MATERIAL_BUDGETS[name] ? "" : "（附加文档）";

  if (m.chars > b.maxChars) {
    const times = (m.chars / b.maxChars).toFixed(1);
    out.push({
      level: "warn",
      check: "material-over-budget",
      label: `超预算 ${times} 倍（${m.chars}/${b.maxChars} 字符）`,
      message: `${name}${kind} 体量 ${m.chars} 字符，超出预算 ${b.maxChars}（${times} 倍）：${b.role}。预算只用于诊断，不自动删除或改写；如需整理，先确认授权并保留事实、来源与可检索归档`,
    });
  }
  if (m.boxDrawing > 0) {
    out.push({
      level: "warn",
      check: "material-box-drawing",
      label: `框线字符 ${m.boxDrawing} 个`,
      message: `${name}${kind} 含 ${m.boxDrawing} 个框线字符（ASCII 图/框线表）：编辑器是比例字体，必然错位，且任何编辑都会破图。经授权整理时改成自然段，保留必要标题与机器字段`,
    });
  }
  if (m.emoji > 0) {
    out.push({
      level: "warn",
      check: "material-emoji",
      label: `装饰符号 ${m.emoji} 个`,
      message: `${name}${kind} 含 ${m.emoji} 个 emoji/装饰符号（✅★◆●※ 一类）：正式资料不用装饰符号`,
    });
  }
  if (m.processNotes > 0) {
    out.push({
      level: "warn",
      check: "material-process-notes",
      label: `过程性标注 ${m.processNotes} 处`,
      message: `${name}${kind} 含 ${m.processNotes} 处过程性标注（导入说明/核对证据/遗疵/文档归位表）：流程记录属于 小说资料/审核/ 的归档，不放进内容文件`,
    });
  }
  // 旧版追踪矩阵 maxTableRatio = 1：兼容存量格式，不据此推荐新表格
  if (b.maxTableRatio < 1 && m.tableRatio > b.maxTableRatio) {
    out.push({
      level: "warn",
      check: "material-table-ratio",
      label: `表格行占比 ${(m.tableRatio * 100).toFixed(0)}%`,
      message: `${name}${kind} 表格行占比 ${(m.tableRatio * 100).toFixed(0)}%（上限 ${(b.maxTableRatio * 100).toFixed(0)}%）：新资料默认自然段和必要标题；存量整理先保留事实与来源，机器字段不改成表格`,
    });
  }
  if (m.hrLines > 2) {
    out.push({
      level: "info",
      check: "material-hr-lines",
      label: `装饰分节线 ${m.hrLines} 条`,
      message: `${name}${kind} 有 ${m.hrLines} 条 ---/= 装饰分节线：分节用标题层级表达`,
    });
  }
  if (m.longestLine > 600) {
    out.push({
      level: "info",
      check: "material-long-line",
      label: `最长行 ${m.longestLine} 字符`,
      message: `${name}${kind} 最长一行 ${m.longestLine} 字符：过长的行不利于检索与节内替换，建议按语意分成自然段，不截断路径或链接`,
    });
  }
  return out;
}

/** 旧版人物卡的字段行诊断上限。新模板使用自然段，不按段数判错。
 *  只数旧版 `- ` 字段行；超限仅提示核对职责，不自动删事实。 */
export const CAST_ENTRY_MAX_LINES = 6;

/** 人物库逐条目检查：`## 名字` 起头，块内字段行（`- `）数超过上限即提示 */
function checkCastEntries(name: string, text: string): MaterialIssue[] {
  const lines = text.split("\n");
  const out: MaterialIssue[] = [];
  let cur = "";
  let count = 0;
  let long = 0;
  const flush = () => {
    if (cur !== "" && count > CAST_ENTRY_MAX_LINES) {
      long += 1;
      out.push({
        level: "info",
        check: "material-cast-entry-long",
        label: `超长条目 ${long}`,
        message: `人物库.md 的「${cur}」条目 ${count} 个字段行（上限 ${CAST_ENTRY_MAX_LINES}）：可用自然段记录稳定特征与人物特有表达，位置、伤势、知情和资源另查追踪表；整理须保留事实`,
      });
    }
  };
  for (const raw of lines) {
    const l = raw.replace(/\r$/, "");
    if (/^##\s+/.test(l)) {
      flush();
      cur = l.replace(/^##\s+/, "").trim();
      count = 0;
      continue;
    }
    if (/^\s*-\s/.test(l)) count += 1;
  }
  flush();
  return out;
}

/**
 * 体检一批资料（**按文件聚合**，供界面展示）。
 *
 * 为什么聚合：真实样本（《李淑珍疑案》）逐条判定会产出 90 条提示 —— 状态条会被淹没，
 * 作者也读不出"该先改哪份文件"。聚合后每份资料**最多一条**：等级取该文件最重的一条，
 * 消息里列全部违规短标签（"世界观.md：框线字符 495、装饰符号 7、超预算 1.0 倍"）。
 * 需要逐条明细的调用方用 `checkMaterial`。
 */
export function auditMaterials(files: { name: string; text: string }[]): MaterialIssue[] {
  const out: MaterialIssue[] = [];
  for (const f of files) {
    const items = checkMaterial(f.name, f.text);
    if (f.name === "人物库.md") {
      const cast = checkCastEntries(f.name, f.text);
      const n = cast.length;
      // 人物库条目超长可能有很多条：这里只合并成一条计数，不逐人刷屏
      if (n > 0) {
        items.push({
          level: "info",
          check: "material-cast-entry-long",
          label: `超长条目 ${n} 个`,
          message: `人物库.md 有 ${n} 个条目超过 ${CAST_ENTRY_MAX_LINES} 行：可用自然段记录稳定特征与人物特有表达，位置、伤势、知情和资源另查追踪表；整理须保留事实`,
        });
      }
    }
    if (items.length === 0) continue;
    const level = items.some((i) => i.level === "warn") ? "warn" : "info";
    const labels = items.map((i) => i.label ?? i.check);
    out.push({
      level,
      check: "material-shape",
      label: labels.join("、"),
      message: `${f.name} 形态：${labels.join("、")}（改法见 docs/MATERIALS-STYLE.md；程序不会自动改写）`,
    });
  }
  return out;
}

/** 体检摘要（界面/日志用的一句话；无提示时给出总量） */
export function materialsSummary(files: { name: string; text: string }[]): string {
  const issues = auditMaterials(files);
  const chars = files.reduce((s, f) => s + f.text.length, 0);
  if (issues.length === 0) return `${files.length} 份资料共 ${chars} 字符，形态无提示`;
  const warns = issues.filter((i) => i.level === "warn").length;
  return `${files.length} 份资料共 ${chars} 字符，${warns} 份形态警告 / ${issues.length - warns} 份仅提示`;
}
