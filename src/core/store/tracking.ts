/**
 * 追踪表的可核对统计（I-4 销项）。
 *
 * 问题：作者常在细纲附录里自述"已回收伏笔 29 条、预留 8 条"，而正文里没有任何
 * 编号体系可供核对 —— 换个人导入会得到完全不同的数字。软件此前对这类自述
 * **没有落点**：既没有地方写，也没有地方验。
 *
 * 现在：`追踪-伏笔.md` 模板自带 `## 伏笔统计` 自述块（数字由作者/AI 填），
 * 本模块按 `## F编号` 条目**数一遍**并与自述比对，不一致就在作品校验里报出来。
 *
 * 纪律：
 *  - 只读不判、只报不改：数字不一致是"提示"，不自动改写用户的文档；
 *  - 认不出的形态一律不猜：状态既不是三个规定值、也不是自述字段的行，
 *    只计入 `unclassified`，绝不硬塞进某一类；
 *  - 自述留空（「待填写」）＝没有自述，不报任何问题（新书与旧格式都安全）。
 */

/** 伏笔条目起始行：`## F001` / `## F001（…）` */
const ENTRY_RE = /^##\s*(F\d+)\b/i;
/** 任意 ATX 标题（分节边界） */
const HEADING_RE = /^#{1,6}\s/;
/** 统计块标题：**锚定「伏笔统计」**（B12-8）。
 *  旧实现是 `/^##\s*.*统计/` 子串匹配 —— 任何含「统计」二字的标题（例如条目标题
 *  `## F010 统计口径待定`、附录 `## 统计说明`）都会把其后所有 `- 键：值` 行当成
 *  自述统计消费掉：条目状态既不计数也不进 unclassified，计数静默变成 0，
 *  「自述与条目数核对」这件事整个失效。锚定标题前缀即消除该形态。 */
const STATS_HEADING_RE = /^##\s*伏笔统计/;
/** `- 键：值` 字段行（全角/半角冒号都认） */
const FIELD_RE = /^-\s*([^：:]+?)\s*[：:]\s*(.*)$/;

export interface ForeshadowCounts {
  /** 状态 = 开放 的条目数 */
  open: number;
  /** 状态 = 已回收 的条目数 */
  collected: number;
  /** 状态 = 废弃 的条目数 */
  dropped: number;
  /** 状态认不出的条目数（占位样板、用户自定状态等），不计入上面三类 */
  unclassified: number;
  /** 条目编号（按出现顺序，去重后保留首次出现） */
  ids: string[];
  /** 文档自述的统计（只收整数；没有或写成「待填写」就没有对应键） */
  declared: { open?: number; collected?: number; dropped?: number; total?: number };
  /** 自述与条目数不一致的说明（空数组 = 一致，或本就没有自述） */
  mismatches: string[];
}

/** 从字段值里取第一个整数（「29 条」→ 29；「待填写」→ null） */
function firstInt(v: string): number | null {
  const m = /\d+/.exec(v);
  return m ? Number(m[0]) : null;
}

/** 状态归类：只认精确前缀，占位样板「开放／已回收／废弃」落进 unclassified */
function classify(status: string): "open" | "collected" | "dropped" | null {
  const s = status.trim();
  if (/^(开放|未回收|预留|未兑现)$/.test(s)) return "open";
  if (/^已回收/.test(s)) return "collected";
  if (/^废弃/.test(s)) return "dropped";
  return null;
}

/**
 * 数一遍 `## F编号` 条目并与 `## 伏笔统计` 自述比对。
 * 传入 追踪-伏笔.md 的全文；任何形态都安全返回。
 */
export function countForeshadowing(text: string): ForeshadowCounts {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const ids: string[] = [];
  let open = 0;
  let collected = 0;
  let dropped = 0;
  let unclassified = 0;
  let inEntry = false;
  const declared: ForeshadowCounts["declared"] = {};

  let inStats = false;
  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      inStats = STATS_HEADING_RE.test(line);
    }
    const entry = ENTRY_RE.exec(line);
    if (entry) {
      inEntry = true;
      const id = entry[1].toUpperCase();
      if (!ids.includes(id)) ids.push(id);
      continue;
    }
    // 进入统计块后：收 `- 键：值` 自述数字（不当作条目字段）
    if (inStats) {
      const f = FIELD_RE.exec(line);
      if (!f) continue;
      const key = f[1].trim();
      const n = firstInt(f[2]);
      if (n === null) continue; // 「待填写」＝没有自述
      if (/^(开放|未回收|预留)$/.test(key)) declared.open = n;
      else if (/^已回收/.test(key)) declared.collected = n;
      else if (/^废弃/.test(key)) declared.dropped = n;
      else if (/^(合计|总计|总数)$/.test(key)) declared.total = n;
      continue;
    }
    if (!inEntry) continue;
    const f = FIELD_RE.exec(line);
    if (!f) continue;
    if (f[1].trim() !== "状态") continue;
    const kind = classify(f[2]);
    if (kind === "open") open++;
    else if (kind === "collected") collected++;
    else if (kind === "dropped") dropped++;
    else unclassified++;
  }

  const mismatches: string[] = [];
  const check = (label: string, declaredNo: number | undefined, actual: number) => {
    if (declaredNo === undefined) return;
    if (declaredNo !== actual) mismatches.push(`${label}：自述 ${declaredNo} 条，条目实为 ${actual} 条`);
  };
  check("开放", declared.open, open);
  check("已回收", declared.collected, collected);
  check("废弃", declared.dropped, dropped);
  if (declared.total !== undefined && declared.total !== open + collected + dropped) {
    mismatches.push(
      `合计：自述 ${declared.total} 条，条目实为 ${open + collected + dropped} 条（开放 ${open} + 已回收 ${collected} + 废弃 ${dropped}）`,
    );
  }

  return { open, collected, dropped, unclassified, ids, declared, mismatches };
}
