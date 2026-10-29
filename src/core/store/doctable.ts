/**
 * 资料表格化（D-043 / B7；2026-10-06 全覆盖改造）：把 小说资料/ 的 md 文档解析成表格视图数据。
 *
 * 定位：**只读展示层 + 手改落点**——文件本体永远是 md，表格只是它的一种看法。
 * 与写入校验（docschema.ts）同一份格式认知：字段行 `- 键：值`、`## 条目` 分块、
 * 粗纲弧段标题、细纲章块标签。
 *
 * 全覆盖（2026-10-06 用户裁决「完全的表格形式」）：
 *  - 认识的文件名走各自的专用解析器；
 *  - 不认识的文档（03-全书大纲、旧结构文件、用户自建、审核归档）走**通用回落解析器**：
 *    头部字段区 → kv 卡，每个 `##` 节 → 字段卡或散文卡。任何 md 都能表格化，
 *    docTableFor 不再返回 null。
 *
 * 手改落点（位置感知）：每个单元格带 CellAddr（原文行区间 + 单行值起点列），
 * 编辑提交经 applyCellEdit / applyRangeDelete / applyInsertBlock 做行级手术——
 * 除目标区间外其余字节逐字节不变（与 markdown.ts 同一「格式优先」纪律）。
 *
 * 纪律：
 *  - 解析失败**节级回落**：哪一块认不出来，那一块就按原文展示，绝不让整页崩掉；
 *  - 只读不判：任何形态都安全返回，不抛异常。
 */

import { dominantEol, joinLines, splitLines } from "./markdown";

/** 单元格/块在原文中的落点（行下标基于 markdown.splitLines 的行数组） */
export interface CellAddr {
  /** 起始行（含） */
  startLine: number;
  /** 结束行（不含） */
  endLine: number;
  /**
   * 单行值编辑：值在该行内的起始列（`- 键：` / `标签：` 之后）。非 null 时编辑只动
   * 该行 valueCol 到行尾的部分（键与前缀逐字节保留）；null = 按整段区间替换。
   */
  valueCol: number | null;
}

export interface KvRow {
  label: string;
  value: string;
  /** 编辑落点；null = 不可定位（只读展示） */
  addr: CellAddr | null;
}

export interface GridRow {
  cells: string[];
  /** 与 cells 等长的逐格落点（null = 该格只读） */
  addrs: (CellAddr | null)[];
  /** 整条目块的行区间（删行用）；null = 不可删 */
  block: CellAddr | null;
}

/** 表格的一个部分：kv = 字段/值两栏；grid = 行条目表；prose = 节级回落的原文 */
export type DocTablePart =
  | { kind: "kv"; title?: string; rows: KvRow[] }
  | { kind: "grid"; title?: string; columns: string[]; rows: GridRow[]; appendAt: number | null }
  | { kind: "prose"; title?: string; text: string; addr: CellAddr | null };

export interface DocTable {
  fileName: string;
  parts: DocTablePart[];
  /** 未按格式解析的块数（界面顶部提示用；只报告不改写） */
  unparsedBlocks: number;
}

// ────────────────────────────── 行级解析基元 ──────────────────────────────

interface PLine {
  /** 行内容（不含 EOL，splitLines 已剥） */
  text: string;
  /** 行下标（splitLines 行数组） */
  i: number;
}

/** `- 键：值` 字段行：返回键、值与值的行内起点列；非字段行返回 null */
function fieldOf(line: string): { key: string; value: string; valueCol: number } | null {
  const m = /^-\s*([^：:]+?)\s*[：:]\s*(.*)$/.exec(line);
  if (!m) return null;
  // (.*)$ 锚到行尾 → 值起点 = 行长 − 值长
  return { key: m[1].trim(), value: m[2], valueCol: line.length - m[2].length };
}

/** 「标签：内容」裸行（人物库/细纲的自然段字段，无前导短横线） */
function labeledOf(line: string, labels: readonly string[]): { key: string; value: string; valueCol: number } | null {
  const t = line.trim();
  for (const lb of labels) {
    if (t.startsWith(lb + "：") || t.startsWith(lb + ":")) {
      const after = lb.length + 1;
      let vs = after;
      while (vs < t.length && (t[vs] === " " || t[vs] === "\t")) vs++;
      return { key: lb, value: t.slice(vs), valueCol: vs };
    }
  }
  return null;
}

interface Block {
  title: string;
  /** 标题行下标 */
  titleLine: number;
  /** 正文行区间 [bodyStart, bodyEnd) */
  bodyStart: number;
  bodyEnd: number;
  lines: PLine[];
}

/** 按 `## 标题` 分块（一级标题与之前的头部不进块），带行号 */
function h2Blocks(lines: string[]): { head: PLine[]; blocks: Block[] } {
  const blocks: Block[] = [];
  const head: PLine[] = [];
  let cur: Block | null = null;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      cur = { title: m[1].trim(), titleLine: i, bodyStart: i + 1, bodyEnd: i + 1, lines: [] };
      blocks.push(cur);
    } else if (cur) {
      cur.lines.push({ text: line, i });
      cur.bodyEnd = i + 1;
    } else {
      head.push({ text: line, i });
    }
  });
  return { head, blocks };
}

/** 头部字段区（首个 ## 之前的 `- 键：值` 行）→ kv 行（带落点） */
function headerKv(head: PLine[]): KvRow[] {
  const rows: KvRow[] = [];
  for (const l of head) {
    if (/^#{1,6}\s/.test(l.text)) continue; // 一级标题跳过
    const f = fieldOf(l.text);
    if (f) rows.push({ label: f.key, value: f.value.trim(), addr: { startLine: l.i, endLine: l.i + 1, valueCol: f.valueCol } });
  }
  return rows;
}

/** 块内 `- 键：值` 字段（带落点） */
function blockFieldRows(b: Block): KvRow[] {
  const rows: KvRow[] = [];
  for (const l of b.lines) {
    const f = fieldOf(l.text);
    if (f) rows.push({ label: f.key, value: f.value.trim(), addr: { startLine: l.i, endLine: l.i + 1, valueCol: f.valueCol } });
  }
  return rows;
}

/** 块的正文散文（去掉字段行/标签行后的剩余），以及它是否占据整个块体（决定可编辑性） */
function proseRemainder(b: Block, labels: readonly string[] = []): { text: string; addr: CellAddr | null } {
  const proseLines = b.lines.filter((l) => !fieldOf(l.text) && !labeledOf(l.text, labels));
  const text = proseLines.map((l) => l.text).join("\n").trim();
  if (text === "") return { text: "", addr: null };
  // 只有「块体整块都是散文」时才给落点（混合块的散文行不连续，区间替换会误伤字段行）
  const pure = proseLines.length === b.lines.length;
  return { text, addr: pure && b.bodyEnd > b.bodyStart ? { startLine: b.bodyStart, endLine: b.bodyEnd, valueCol: null } : null };
}

// ────────────────────────────── 各文件的专用解析器 ──────────────────────────────

/** 00-项目状态：头部字段 kv + 各固定节的字段 kv / 散文 */
function parseStateDoc(text: string): DocTable {
  const doc = splitLines(text);
  const { head, blocks } = h2Blocks(doc.lines);
  const parts: DocTablePart[] = [];
  const header = headerKv(head);
  if (header.length > 0) parts.push({ kind: "kv", title: "状态", rows: header });
  for (const b of blocks) {
    const rows = blockFieldRows(b);
    if (rows.length > 0) parts.push({ kind: "kv", title: b.title, rows });
    const prose = proseRemainder(b);
    if (prose.text !== "") parts.push({ kind: "prose", title: rows.length > 0 ? undefined : b.title, text: prose.text, addr: prose.addr });
  }
  return { fileName: "00-项目状态.md", parts, unparsedBlocks: 0 };
}

/** 追踪表：## 条目 → grid（行=条目）；自述统计块 → 顶部 kv */
function parseTracker(fileName: string, columns: readonly string[], kvBlockTitles: readonly string[] = []) {
  return (text: string): DocTable => {
    const doc = splitLines(text);
    const { blocks } = h2Blocks(doc.lines);
    const parts: DocTablePart[] = [];
    const rows: GridRow[] = [];
    let unparsed = 0;
    for (const b of blocks) {
      const fieldRows = blockFieldRows(b);
      if (kvBlockTitles.some((t) => b.title.startsWith(t))) {
        parts.push({ kind: "kv", title: b.title, rows: fieldRows });
        continue;
      }
      if (fieldRows.length === 0) {
        unparsed += 1;
        parts.push({ kind: "prose", title: b.title, text: b.lines.map((l) => l.text).join("\n").trim() || "（空）", addr: { startLine: b.bodyStart, endLine: b.bodyEnd, valueCol: null } });
        continue;
      }
      const fields: Record<string, string> = {};
      const addrByKey: Record<string, CellAddr> = {};
      for (const r of fieldRows) {
        fields[r.label] = r.value;
        if (r.addr) addrByKey[r.label] = r.addr;
      }
      rows.push({
        cells: [b.title, ...columns.map((c) => fields[c] ?? "")],
        // 首列是条目标题（## 行）：整行编辑落点（编号改名是用户最高权威，允许但走整行）
        addrs: [
          { startLine: b.titleLine, endLine: b.titleLine + 1, valueCol: null },
          ...columns.map((c) => addrByKey[c] ?? null),
        ],
        block: { startLine: b.titleLine, endLine: b.bodyEnd, valueCol: null },
      });
    }
    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      parts.push({ kind: "grid", columns: ["条目", ...columns], rows, appendAt: last.block ? last.block.endLine : null });
    }
    return { fileName, parts, unparsedBlocks: unparsed };
  };
}

/** 04-粗纲：## 第N-M章 弧段名 → grid（弧段名可整行内编辑，缩略内容按块编辑） */
function parseRough(text: string): DocTable {
  const doc = splitLines(text);
  const { blocks } = h2Blocks(doc.lines);
  const rows: GridRow[] = [];
  let unparsed = 0;
  for (const b of blocks) {
    const titleText = doc.lines[b.titleLine].replace(/\r$/, "");
    const m = /^##\s+(第\s*\S+[-–—~～]\S+\s*章)\s*(.*)$/.exec(titleText);
    if (!m) {
      unparsed += 1;
      continue;
    }
    // 弧段名的行内起点（范围段嵌在标题中间，只给弧段名落点；范围要改请用原文）
    const nameCol = titleText.length - m[2].length;
    const body = b.lines.map((l) => l.text).join("\n").trim();
    rows.push({
      cells: [m[1].replace(/\s+/g, ""), m[2].trim(), body],
      addrs: [
        null, // 章号区间：与标题结构耦合，表格里只读（改它请切原文）
        m[2] !== "" ? { startLine: b.titleLine, endLine: b.titleLine + 1, valueCol: nameCol } : null,
        b.bodyEnd > b.bodyStart ? { startLine: b.bodyStart, endLine: b.bodyEnd, valueCol: null } : null,
      ],
      block: { startLine: b.titleLine, endLine: b.bodyEnd, valueCol: null },
    });
  }
  return {
    fileName: "04-粗纲.md",
    parts: rows.length > 0 ? [{ kind: "grid", columns: ["弧段", "弧段名", "缩略内容"], rows, appendAt: rows[rows.length - 1].block!.endLine }] : [],
    unparsedBlocks: unparsed,
  };
}

/** 细纲章块的四个固定标签（逐字） */
const XIGANG_LABELS = ["承接与目标", "主要场面", "依据与约束", "变化与章尾"] as const;

/** 细纲：头部字段 kv + 每章一行 grid（四标签裸行可逐格编辑） */
function parseXigang(fileName: string) {
  return (text: string): DocTable => {
    const doc = splitLines(text);
    const { head, blocks } = h2Blocks(doc.lines);
    const parts: DocTablePart[] = [];
    const header = headerKv(head);
    if (header.length > 0) parts.push({ kind: "kv", title: "细纲", rows: header });
    const rows: GridRow[] = [];
    let unparsed = 0;
    for (const b of blocks) {
      if (b.title === "实际与细纲差异") {
        parts.push({ kind: "prose", title: b.title, text: b.lines.map((l) => l.text).join("\n").trim(), addr: { startLine: b.bodyStart, endLine: b.bodyEnd, valueCol: null } });
        continue;
      }
      const fields: Record<string, string> = {};
      const addrByKey: Record<string, CellAddr> = {};
      for (const l of b.lines) {
        const f = labeledOf(l.text, XIGANG_LABELS);
        if (f) {
          fields[f.key] = f.value.trim();
          addrByKey[f.key] = { startLine: l.i, endLine: l.i + 1, valueCol: f.valueCol };
        }
      }
      if (Object.keys(fields).length === 0) {
        unparsed += 1;
        parts.push({ kind: "prose", title: b.title, text: b.lines.map((l) => l.text).join("\n").trim() || "（空）", addr: { startLine: b.bodyStart, endLine: b.bodyEnd, valueCol: null } });
        continue;
      }
      rows.push({
        cells: [b.title, ...XIGANG_LABELS.map((l) => fields[l] ?? "")],
        addrs: [{ startLine: b.titleLine, endLine: b.titleLine + 1, valueCol: null }, ...XIGANG_LABELS.map((l) => addrByKey[l] ?? null)],
        block: { startLine: b.titleLine, endLine: b.bodyEnd, valueCol: null },
      });
    }
    if (rows.length > 0) {
      parts.push({ kind: "grid", columns: ["章", ...XIGANG_LABELS], rows, appendAt: rows[rows.length - 1].block!.endLine });
    }
    return { fileName, parts, unparsedBlocks: unparsed };
  };
}

/** 人物库：每人一块 kv 卡（六方面 + 备注），标签裸行带落点 */
const CAST_LABELS = [
  "身份、背景与长期追求",
  "在意之处、缺陷与底线",
  "基本能力边界",
  "关系起点",
  "说话习惯与压力反应",
  "依据及最近更新章节",
] as const;

function parseCast(text: string): DocTable {
  const doc = splitLines(text);
  const { blocks } = h2Blocks(doc.lines);
  const parts: DocTablePart[] = [];
  let unparsed = 0;
  for (const b of blocks) {
    const rows: KvRow[] = [];
    for (const l of b.lines) {
      const f = labeledOf(l.text, CAST_LABELS);
      if (f) rows.push({ label: f.key, value: f.value.trim(), addr: { startLine: l.i, endLine: l.i + 1, valueCol: f.valueCol } });
    }
    const prose = proseRemainder(b, CAST_LABELS);
    if (rows.length === 0 && prose.text === "") {
      unparsed += 1;
      continue;
    }
    if (rows.length > 0) parts.push({ kind: "kv", title: b.title, rows });
    if (prose.text !== "") parts.push({ kind: "prose", title: rows.length > 0 ? undefined : b.title, text: prose.text, addr: prose.addr });
  }
  return { fileName: "人物库.md", parts, unparsedBlocks: unparsed };
}

/**
 * 06「风格规则」新格式（2026-10-11 批 3）：一条规则一个 `### SR-NNN` 块 + 三个字段。
 * 列名与字段名**逐字相同**（`规则分类`/`规则来源`/`具体内容`），加行走通用的
 * buildEntryBlock（它拿列名当字段名）；第一列「规则编号」是 `###` 标题，表格里只读。
 */
const STYLE_RULE_COLS = ["规则编号", "规则分类", "规则来源", "具体内容"] as const;
const STYLE_RULE_FIELDS = ["规则分类", "规则来源", "具体内容"] as const;

/** 把「风格规则」节切成 `### SR-NNN` 块；一个都没有（旧的自然段格式）返回空数组 */
function styleRuleBlocks(b: Block): { id: string; titleLine: number; bodyEnd: number; lines: PLine[] }[] {
  const out: { id: string; titleLine: number; bodyEnd: number; lines: PLine[] }[] = [];
  let cur: (typeof out)[number] | null = null;
  for (const l of b.lines) {
    const m = /^###\s+(\S+)\s*$/.exec(l.text);
    if (m) {
      cur = { id: m[1], titleLine: l.i, bodyEnd: l.i + 1, lines: [] };
      out.push(cur);
    } else if (cur) {
      cur.lines.push(l);
      cur.bodyEnd = l.i + 1;
    }
  }
  return out;
}

/**
 * 06-写作风格：禁用列表 = 行条目 grid（一格一行，整行编辑）；
 * 风格规则 = 新格式的 SR 块 → 四列 grid（规则编号/规则分类/规则来源/具体内容），
 * **旧的自然段格式照样认**（老书不迁移也一切照旧，回落成散文卡）。
 */
function parseStyle(text: string): DocTable {
  const doc = splitLines(text);
  const { blocks } = h2Blocks(doc.lines);
  const parts: DocTablePart[] = [];
  let unparsed = 0;
  const proseOf = (b: Block): DocTablePart => ({
    kind: "prose",
    title: b.title,
    text: b.lines.map((l) => l.text).join("\n").trim(),
    addr: { startLine: b.bodyStart, endLine: b.bodyEnd, valueCol: null },
  });
  for (const b of blocks) {
    if (b.title === "禁用列表") {
      const rows: GridRow[] = [];
      for (const l of b.lines) {
        const m = /^-\s*禁止[：:]\s*(.*)$/.exec(l.text.trim());
        if (!m) continue;
        // 「……（来源：用户指定）」→ 拆出来源列；两格共用同一行的整行落点。
        // 先试「以 （来源：…） 结尾」（贪婪项吃到 `（来源` 前，保留禁止项里的括号），
        // 不匹配再整行作禁止项、来源留空。原用 `(.*?)?` 可选组：`.*` 贪婪会连来源一起吃掉，
        // 可选组匹配空就成，于是永远不拆 —— 来源列恒空（旧测试只验了「滥用不禁」无来源那例才没暴露）。
        const tail = /^(.*)（来源[：:](.*?)）$/.exec(m[1].trim());
        const sm = tail ?? /^(.*)$/.exec(m[1].trim());
        const lineAddr: CellAddr = { startLine: l.i, endLine: l.i + 1, valueCol: null };
        rows.push({
          cells: [(sm?.[1] ?? "").trim(), (sm?.[2] ?? "").trim()],
          addrs: [lineAddr, lineAddr],
          block: lineAddr,
        });
      }
      const lastLine = b.lines.length > 0 ? b.bodyEnd : b.titleLine + 1;
      parts.push({ kind: "grid", title: b.title, columns: ["禁止项", "来源"], rows, appendAt: lastLine });
      continue;
    }
    if (b.title === "风格规则") {
      const rules = styleRuleBlocks(b);
      if (rules.length === 0) {
        parts.push(proseOf(b)); // 旧格式：整节自然段，看法与改造前逐字一致
        continue;
      }
      // 节内前言（首个 `### SR-` 之前的说明行）：SR 块不含它，得单独给散文卡，
      // 否则模板里「一条规则一个块、分类/来源怎么填」这类写法说明会在表格视图里消失。
      const firstRuleLine = rules[0].titleLine;
      const preLines = b.lines.filter((l) => l.i < firstRuleLine);
      const pre = preLines.map((l) => l.text).join("\n").trim();
      if (pre !== "") {
        parts.push({
          kind: "prose",
          title: undefined, // 节标题留给下面的规则表，前言作无题引言
          text: pre,
          addr: { startLine: b.bodyStart, endLine: firstRuleLine, valueCol: null },
        });
      }
      const rows: GridRow[] = [];
      /** SR 块一个字段行都没有（手改成纯散文挂在 ### 下）：不作空行进表，回落成散文卡，免得正文在表格视图里消失 */
      const orphans: DocTablePart[] = [];
      for (const r of rules) {
        const fields: Record<string, string> = {};
        const addrByKey: Record<string, CellAddr> = {};
        for (const l of r.lines) {
          const f = fieldOf(l.text);
          if (f) {
            fields[f.key] = f.value.trim();
            addrByKey[f.key] = { startLine: l.i, endLine: l.i + 1, valueCol: f.valueCol };
          }
        }
        if (Object.keys(addrByKey).length === 0) {
          orphans.push({
            kind: "prose",
            title: r.id,
            text: r.lines.map((l) => l.text).join("\n").trim() || "（空）",
            addr: { startLine: r.titleLine + 1, endLine: r.bodyEnd, valueCol: null },
          });
          continue;
        }
        rows.push({
          cells: [r.id, ...STYLE_RULE_FIELDS.map((k) => fields[k] ?? "")],
          addrs: [
            null, // 规则编号 = `###` 标题：与标题层级耦合，表格里只读（改它请切原文）
            ...STYLE_RULE_FIELDS.map((k) => addrByKey[k] ?? null),
          ],
          block: { startLine: r.titleLine, endLine: r.bodyEnd, valueCol: null },
        });
      }
      // 加行落在「风格规则」节末尾（下一个 `##` 节标题之前）
      if (rows.length > 0) {
        parts.push({ kind: "grid", title: b.title, columns: [...STYLE_RULE_COLS], rows, appendAt: b.bodyEnd });
      }
      parts.push(...orphans);
      unparsed += orphans.length;
      continue;
    }
    parts.push(proseOf(b));
  }
  return { fileName: "06-写作风格.md", parts, unparsedBlocks: unparsed };
}

/** 规则台账：GL 条目 → grid（证据列在最末，内容最长）；无字段的块节级回落为原文 */
function parseLedgerDoc(text: string): DocTable {
  const doc = splitLines(text);
  const { blocks } = h2Blocks(doc.lines);
  const rows: GridRow[] = [];
  const parts: DocTablePart[] = [];
  let unparsed = 0;
  const COLS = ["规则", "类别", "命中章节数", "状态", "最近更新", "证据"] as const;
  for (const b of blocks) {
    const fieldRows = blockFieldRows(b);
    if (fieldRows.length === 0) {
      unparsed += 1;
      parts.push({ kind: "prose", title: b.title, text: b.lines.map((l) => l.text).join("\n").trim() || "（空）", addr: { startLine: b.bodyStart, endLine: b.bodyEnd, valueCol: null } });
      continue;
    }
    const fields: Record<string, string> = {};
    const addrByKey: Record<string, CellAddr> = {};
    for (const r of fieldRows) {
      fields[r.label] = r.value;
      if (r.addr) addrByKey[r.label] = r.addr;
    }
    rows.push({
      cells: [b.title, ...COLS.map((c) => fields[c] ?? "")],
      addrs: [{ startLine: b.titleLine, endLine: b.titleLine + 1, valueCol: null }, ...COLS.map((c) => addrByKey[c] ?? null)],
      block: { startLine: b.titleLine, endLine: b.bodyEnd, valueCol: null },
    });
  }
  if (rows.length > 0) {
    parts.unshift({ kind: "grid", columns: ["编号", ...COLS], rows, appendAt: rows[rows.length - 1].block!.endLine });
  }
  return { fileName: "规则台账.md", parts, unparsedBlocks: unparsed };
}

/** 01/02 开书材料：头部标签 kv + 各节正文 */
function parseFieldDoc(fileName: string) {
  return (text: string): DocTable => {
    const doc = splitLines(text);
    const { head, blocks } = h2Blocks(doc.lines);
    const parts: DocTablePart[] = [];
    const header = headerKv(head);
    if (header.length > 0) parts.push({ kind: "kv", title: "开书引导字段", rows: header });
    // 头部里除字段行外的说明文字
    const headProse = head.filter((l) => !fieldOf(l.text) && !/^#{1,6}\s/.test(l.text)).map((l) => l.text).join("\n").trim();
    if (headProse !== "") parts.push({ kind: "prose", text: headProse, addr: null });
    for (const b of blocks) {
      const rows = blockFieldRows(b);
      if (rows.length > 0) parts.push({ kind: "kv", title: b.title, rows });
      const prose = proseRemainder(b);
      if (prose.text !== "") parts.push({ kind: "prose", title: rows.length > 0 ? undefined : b.title, text: prose.text, addr: prose.addr });
    }
    return { fileName, parts, unparsedBlocks: 0 };
  };
}

/**
 * 通用回落解析器（全覆盖的底座）：任何 md → 头部字段卡 + 逐节卡。
 * 认识不了的格式不是"不能表格化"，只是"没有专用视图"——分节卡就是它的表格形态。
 */
function parseGeneric(fileName: string) {
  return (text: string): DocTable => {
    const doc = splitLines(text);
    const { head, blocks } = h2Blocks(doc.lines);
    const parts: DocTablePart[] = [];
    const header = headerKv(head);
    if (header.length > 0) parts.push({ kind: "kv", title: "字段", rows: header });
    const headProse = head.filter((l) => !fieldOf(l.text) && !/^#{1,6}\s/.test(l.text)).map((l) => l.text).join("\n").trim();
    if (headProse !== "") {
      // 头部散文（文件标题下的引言）：落点 = 首个字段/标题行之前的连续散文行
      parts.push({ kind: "prose", text: headProse, addr: null });
    }
    for (const b of blocks) {
      const rows = blockFieldRows(b);
      if (rows.length > 0) parts.push({ kind: "kv", title: b.title, rows });
      const prose = proseRemainder(b);
      if (prose.text !== "") parts.push({ kind: "prose", title: rows.length > 0 ? undefined : b.title, text: prose.text, addr: prose.addr });
      if (rows.length === 0 && prose.text === "") {
        parts.push({ kind: "prose", title: b.title, text: "（空）", addr: { startLine: b.bodyStart, endLine: b.bodyEnd, valueCol: null } });
      }
    }
    return { fileName, parts, unparsedBlocks: 0 };
  };
}

/**
 * 章节摘要（2026-10-11 两列化）：`### 第N章 章名 摘要` → 一行一章。
 *
 *  - 列：章节编号（20）/ 具体摘要（80）；
 *  - 章标题与 `###` 前缀、「摘要」后缀耦合，表格里**只读**（改它请切原文）——本文件是
 *    历史归档索引，按文档自述「不再追加」，不需要行内改标题；
 *  - `##` 节标题（如「原文连续篇章（未设分卷）」）作该节表格的标题，一节一张表；
 *  - 一个 `###` 章块都没有（旧结构/自建文件）→ 回落通用解析器，行为与改造前逐字一致。
 */
function parseChapterSummary(text: string): DocTable {
  const doc = splitLines(text);
  const parts: DocTablePart[] = [];
  /** 按 `##` 节分组：每节一张表（无 `##` 时只有一节，标题为 null） */
  const groups: { title: string | null; rows: GridRow[] }[] = [];
  let prose: PLine[] = [];
  let chapter: { label: string; titleLine: number; bodyStart: number; bodyEnd: number } | null = null;

  const flushProse = () => {
    const t = prose.map((l) => l.text).join("\n").trim();
    if (t !== "") parts.push({ kind: "prose", text: t, addr: null });
    prose = [];
  };
  const flushChapter = () => {
    if (!chapter) return;
    if (groups.length === 0) groups.push({ title: null, rows: [] });
    const g = groups[groups.length - 1];
    g.rows.push({
      cells: [chapter.label, doc.lines.slice(chapter.bodyStart, chapter.bodyEnd).join("\n").trim()],
      addrs: [
        null, // 章标题：与 `###` 前缀、「摘要」后缀耦合，只读
        chapter.bodyEnd > chapter.bodyStart
          ? { startLine: chapter.bodyStart, endLine: chapter.bodyEnd, valueCol: null }
          : null,
      ],
      block: { startLine: chapter.titleLine, endLine: chapter.bodyEnd, valueCol: null },
    });
    chapter = null;
  };

  doc.lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    // 章块标题必须是「### 第…」：别的 `###`（如「### 说明」）不是章，否则会把整本书的
    // 摘要从一个 `### 说明` 起全吞进一个 blob 行。非章的 `###` 关掉当前章后进散文卡。
    const h3 = /^###\s+(第.+)$/.exec(line);
    if (h3) {
      flushChapter();
      flushProse();
      chapter = { label: h3[1].trim().replace(/\s*摘要$/, ""), titleLine: i, bodyStart: i + 1, bodyEnd: i + 1 };
      return;
    }
    // 非「第…」的 ### 行：先关掉当前章（否则它会吃进章摘要正文），再当散文
    if (/^###\s+/.test(line)) {
      flushChapter();
      prose.push({ text: line, i });
      return;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      flushChapter();
      flushProse();
      groups.push({ title: h2[1].trim(), rows: [] });
      return;
    }
    if (chapter) {
      chapter.bodyEnd = i + 1;
      return;
    }
    if (!/^#\s/.test(line)) prose.push({ text: line, i });
  });
  flushChapter();
  flushProse();

  // 认不出一个章块 → 交回通用回落（旧结构文件不因这次改造改变看法）
  if (groups.every((g) => g.rows.length === 0)) return parseGeneric("章节摘要.md")(text);
  for (const g of groups) {
    if (g.rows.length === 0) continue;
    parts.push({
      kind: "grid",
      title: g.title ?? undefined,
      columns: ["章节编号", "具体摘要"],
      rows: g.rows,
      appendAt: g.rows[g.rows.length - 1].block?.endLine ?? null,
    });
  }
  return { fileName: "章节摘要.md", parts, unparsedBlocks: 0 };
}

/**
 * 列宽声明（100 分制 → 百分比；用户 2026-10-11 逐表指定，批 3 补入 06）。
 *
 * 只给用户点名的表启用固定列宽（`table-layout: fixed` + `<colgroup>`）；**未声明的表
 * 保持内容自适应**——用户说过「不变 / 刚刚好 / 完美」的表（细纲、粗纲、00、01、02）
 * 一个像素都不动。06 的「禁用列表」两列不在声明里，因此也走自适应，正是「禁用项表格没问题」。
 *
 * 键 = 列名，与各解析器输出的 `columns` **逐字一致**；权重之和须为 100（有回归锁）。
 * 任一声明的列名对不上就整体放弃（宁可不固定，也不给错宽度）。
 */
export const COLUMN_WEIGHTS: Record<string, Record<string, number>> = {
  // 编号 / 规则 / 类别 / 命中章节数 / 状态 / 最近更新 / 证据
  "规则台账.md": { 编号: 6, 规则: 50, 类别: 8, 命中章节数: 5, 状态: 5, 最近更新: 8, 证据: 18 },
  // 条目 / 内容与涉及对象 / 首次出现章节 / 当前进展 / 预计触发或回收条件 / 状态 / 来源与最近更新章节
  // 「当前进展」多出的份额来自被删掉的空列（原行末删钮列）
  "追踪-伏笔.md": {
    条目: 5,
    内容与涉及对象: 18,
    首次出现章节: 10,
    当前进展: 22,
    预计触发或回收条件: 18,
    状态: 5,
    来源与最近更新章节: 22,
  },
  // 章节摘要两列化（批 3）
  "章节摘要.md": { 章节编号: 20, 具体摘要: 80 },
  // 06-写作风格「风格规则」四列表（批 3 的格式改造）
  "06-写作风格.md": { 规则编号: 10, 规则分类: 15, 规则来源: 10, 具体内容: 65 },
};

/**
 * 该文件该 grid 的逐列权重（%）。要求**列集完全一致**（个数与列名都对得上）：
 * 只对上一部分的列名会产出比表格短的 colgroup，把整张表挤坏——所以宁可整体放弃，
 * 让该表走内容自适应。
 */
export function columnWeightsFor(fileName: string, columns: readonly string[]): number[] | null {
  const w = COLUMN_WEIGHTS[fileName];
  if (!w) return null;
  if (Object.keys(w).length !== columns.length) return null;
  const out = columns.map((c) => w[c]);
  if (out.some((n) => typeof n !== "number")) return null;
  return out;
}

/**
 * 解析结果里是否有「真表格」（grid 行表或 kv 字段卡）——决定要不要给「表格」切换钮（D-061）。
 *
 * 纯散文文档（人物库只写了自然段、03-全书大纲只有节标题）没有真表格：给了钮点进去还是
 * 散文卡，属误导。用户 2026-10-11 裁决：这两类不显示切换钮。判定按**内容**而非文件名，
 * 所以某本书的人物库若真写了六方面标签行，钮会自己出现。
 */
export function hasRealTable(t: DocTable): boolean {
  return t.parts.some((p) => p.kind === "grid" || p.kind === "kv");
}

/** 追踪表的列定义（与模板字段逐字一致） */
const TRACKER_COLUMNS: Record<string, readonly string[]> = {
  "追踪-伏笔.md": ["内容与涉及对象", "首次出现章节", "当前进展", "预计触发或回收条件", "状态", "来源与最近更新章节"],
  "追踪-角色状态.md": ["当前位置、身体与情绪状态", "当前目标", "已知事实与误信信息", "尚不知道的关键信息", "当前关系与利益", "来源及最近更新章节", "状态"],
  "追踪-时间线.md": ["时间、地点与事件", "涉及对象", "来源及最近更新章节", "状态"],
  "追踪-资源与权限.md": ["人物或组织", "金钱、物品、身份、能力或权限", "当前数量与限制", "获得来源", "最近变化及其来源章节", "最近更新章节", "状态"],
  "追踪-废弃设定.md": ["已废弃内容与涉及对象", "废弃原因", "被哪条正式设定替代", "决定来源", "生效及最近更新章节", "禁止恢复"],
};

/**
 * 状态值的**符号化看法**（用户 2026-10-11 指定）：文件里仍存中文原值，符号只是显示。
 *
 *  √ = 已达成；? = 开放 / 待观察 / 附条件；× = 未达成 / 已否决 / 废弃。
 * 未列出的文件与取值原样显示（追踪-时间线/资源/废弃设定不受影响）。
 * 与 DocTable.tsx 的封闭取值词表（STATUS_BY_FILE）耦合，有回归锁。
 */
export const STATUS_SYMBOL: Record<string, Record<string, string>> = {
  "规则台账.md": { 已晋升: "√", "已晋升（附条件）": "?", 待观察: "×", 候选: "×", 已否决: "×" },
  "追踪-伏笔.md": { 已回收: "√", 开放: "?", 废弃: "×" },
};

/** 该文件该状态值的符号；没有符号约定 → undefined（界面按中文原值显示） */
export function statusSymbol(fileName: string, value: string): string | undefined {
  return STATUS_SYMBOL[fileName]?.[value];
}

/**
 * 该文件的表格视图。**任何文档都有视图**（不认识的走通用回落），不再返回 null——
 * 「完全的表格形式」是用户裁决（2026-10-06）。
 *
 * 2026-10-11 修订（D-061）：**视图能力**仍是全覆盖，但**切换钮**改按内容驱动
 * （hasRealTable）——纯散文文档不再给钮，见该函数注释。
 */
export function docTableFor(fileName: string, text: string): DocTable {
  if (fileName === "00-项目状态.md") return parseStateDoc(text);
  if (fileName === "01-开书定位.md" || fileName === "02-核心设定.md") return parseFieldDoc(fileName)(text);
  if (fileName === "04-粗纲.md") return parseRough(text);
  if (fileName === "06-写作风格.md") return parseStyle(text);
  if (fileName === "人物库.md") return parseCast(text);
  if (fileName === "章节摘要.md") return parseChapterSummary(text);
  if (fileName === "规则台账.md") return parseLedgerDoc(text);
  if (/^第.+[-–—~～].+章细纲(（已完成）)?\.md$/.test(fileName)) return parseXigang(fileName)(text);
  const cols = TRACKER_COLUMNS[fileName];
  if (cols) return parseTracker(fileName, cols, fileName === "追踪-伏笔.md" ? ["伏笔统计"] : [])(text);
  return parseGeneric(fileName)(text);
}

/**
 * 该文件类型的默认视图（追踪类/台账/粗纲/细纲/00/章节摘要/06 默认表格；其余默认原文）。
 * 人物库与 03-全书大纲不在此列，且它们没有真表格（hasRealTable=false）→ 连切换钮都没有。
 */
export function defaultTableView(fileName: string): boolean {
  return (
    fileName in TRACKER_COLUMNS ||
    fileName === "规则台账.md" ||
    fileName === "04-粗纲.md" ||
    fileName === "00-项目状态.md" ||
    fileName === "章节摘要.md" ||
    // 06 批 3 改成 SR 块格式后是结构化文档，默认给表格（用户要的「真表格化」）。
    // 老书的自然段格式照样能开：风格规则显示成散文卡，禁用列表仍是表格。
    fileName === "06-写作风格.md" ||
    /^第.+[-–—~～].+章细纲(（已完成）)?\.md$/.test(fileName)
  );
}

// ────────────────────────────── 手改的落点手术（B14 的执行层） ──────────────────────────────

/** 落点是否仍在文本范围内（别处的编辑可能已让行号漂移；漂移就放弃而不是乱写） */
function addrValid(lineCount: number, addr: CellAddr): boolean {
  return addr.startLine >= 0 && addr.endLine >= addr.startLine && addr.endLine <= lineCount;
}

/**
 * 单元格编辑提交：把 addr 指向的内容替换为 newText。
 *  - valueCol 非 null：单行值替换，行内前缀（`- 键：` / `标签：` 与空白）逐字节保留；
 *  - valueCol 为 null：整段区间替换（新内容按文档主导 EOL 拆行；新区间最后一行
 *    继承原区间最后一行的 EOL，保证与后续内容的粘连关系不变）。
 * 落点漂移（行数对不上）时**原样返回**，宁可不写也不乱写。
 */
export function applyCellEdit(text: string, addr: CellAddr, newText: string): string {
  const doc = splitLines(text);
  if (!addrValid(doc.lines.length, addr)) return text;
  if (addr.valueCol !== null && addr.endLine === addr.startLine + 1) {
    const line = doc.lines[addr.startLine];
    doc.lines[addr.startLine] = line.slice(0, addr.valueCol) + newText;
    return joinLines(doc);
  }
  const eol = dominantEol(doc);
  const newLines = newText === "" ? [] : newText.split(/\r\n|\r|\n/);
  const oldLastEol = addr.endLine > addr.startLine ? doc.eols[addr.endLine - 1] : eol;
  const newEols = newLines.map(() => eol);
  if (newEols.length > 0) newEols[newEols.length - 1] = oldLastEol;
  doc.lines.splice(addr.startLine, addr.endLine - addr.startLine, ...newLines);
  doc.eols.splice(addr.startLine, addr.endLine - addr.startLine, ...newEols);
  return joinLines(doc);
}

/** 整条目删除（grid 删行）：删掉 [startLine, endLine) 整段；区间失效返回原文 */
export function applyRangeDelete(text: string, addr: { startLine: number; endLine: number }): string {
  const doc = splitLines(text);
  if (addr.startLine < 0 || addr.endLine <= addr.startLine || addr.endLine > doc.lines.length) return text;
  doc.lines.splice(addr.startLine, addr.endLine - addr.startLine);
  doc.eols.splice(addr.startLine, addr.endLine - addr.startLine);
  return joinLines(doc);
}

/**
 * 在 atLine 行前插入一个块（grid 加行）：块文本按文档主导 EOL 拆行插入，
 * 块末行补主导 EOL，保证与原有下一行不粘连。atLine 越界时夹到文件末尾。
 */
export function applyInsertBlock(text: string, atLine: number, blockText: string): string {
  const doc = splitLines(text);
  const eol = dominantEol(doc);
  const lines = blockText.split(/\r\n|\r|\n/);
  const at = Math.max(0, Math.min(atLine, doc.lines.length));
  // 块每行都带主导 EOL（插入点后还有内容时，块末行靠它与原下一行分行）；
  // 追加到文件末尾且原末行无 EOL 时先补上（否则块首行与原文末行粘连）。
  const eols = lines.map(() => eol);
  if (at === doc.lines.length && doc.eols.length > 0 && doc.eols[doc.eols.length - 1] === "") {
    doc.eols[doc.eols.length - 1] = eol;
  }
  doc.lines.splice(at, 0, ...lines);
  doc.eols.splice(at, 0, ...eols);
  return joinLines(doc);
}

/**
 * 生成新条目块文本（grid 加行）：只支持「标题 + `- 键：值` 字段」形态
 * （五份追踪表 + 规则台账用 `## 标题`；06 的规则表用 `### SR-编号`）；
 * 其余形态（细纲章块、粗纲弧段、禁用列表行）返回 null。
 * 编号自动续：F/T/R/D 取「现有最大编号 +1」，GL/SR 带连字符；角色状态按人名，占位「新人物」。
 * 块首带一个空行，与上一条目分隔（追踪表的既有排版习惯）；06 是 h3 块，块尾再补一个空行，
 * 否则新块会贴着下一个 `##` 节标题。
 */
export function buildEntryBlock(fileName: string, columns: readonly string[], existingTitles: readonly string[]): string | null {
  const PREFIX: Record<string, string> = {
    "追踪-伏笔.md": "F",
    "追踪-时间线.md": "T",
    "追踪-资源与权限.md": "R",
    "追踪-废弃设定.md": "D",
    "规则台账.md": "GL-",
    "06-写作风格.md": "SR-",
  };
  /** 标题层级：06 的规则块嵌在「风格规则」节里，只能是 h3（h2 会被 docschema 判为多余节） */
  const HEADING: Record<string, string> = { "06-写作风格.md": "###" };
  if (!(fileName.startsWith("追踪-") || fileName === "规则台账.md" || fileName === "06-写作风格.md")) return null;
  // 06 有两张 grid：规则表（规则编号 + 三字段）与禁用列表（禁止项 + 来源）。只有前者能加行——
  // 禁用列表是「一行一条」的行条目，加行会生成出错的块。按**列结构**判，不按文件名判。
  if (fileName === "06-写作风格.md" && columns[0] !== "规则编号") return null;
  const prefix = PREFIX[fileName];
  let title: string;
  if (prefix !== undefined) {
    let max = 0;
    const re = new RegExp(`^${prefix.replace("-", "\\-")}(\\d+)$`);
    for (const t of existingTitles) {
      const m = re.exec(t.trim());
      if (m) max = Math.max(max, Number(m[1]));
    }
    title = `${prefix}${String(max + 1).padStart(3, "0")}`;
  } else {
    // 追踪-角色状态.md：条目按人名，占位名由用户随手改掉
    title = "新人物";
  }
  const level = HEADING[fileName] ?? "##";
  const lines = [`${level} ${title}`];
  for (const c of columns.slice(1)) lines.push(`- ${c}：待填写`);
  return "\n" + lines.join("\n") + (level === "###" ? "\n" : "");
}
