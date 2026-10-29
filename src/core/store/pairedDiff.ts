/**
 * 配对对照（D-043 / B5）：把「编辑前 → 编辑后」的改动对齐成**成对**的「原句 → 改后句」。
 *
 * 为什么不用既有的 diffLines：它只做前后缀裁剪，产出两个无序行集（- 行 / + 行），
 * 位置对应关系被丢弃——而文风规则的本质就是配对改写。风格回流的 prompt 需要的是
 * 「这一段原来这么写、用户改成了这样」，两个行集给不了。
 *
 * 算法：按空行切段（章节正文/资料都以空行分段）→ 段的精确匹配做 LCS 锚定未改动段
 * → 锚点之间的变更区按区内序号两两配对（多出来的进 addedOnly/removedOnly）。
 * 段数在几百量级，LCS 的 O(n·m) 完全够用。
 */

export interface PairedChange {
  /** 旧版段落（原文，未 trim） */
  before: string;
  /** 用户改后的段落 */
  after: string;
}

export interface PairedDiff {
  /** 配对改动（按出现顺序） */
  pairs: PairedChange[];
  /** 纯新增（无对应旧段） */
  addedOnly: string[];
  /** 纯删除（无对应新段） */
  removedOnly: string[];
  /** 未改动段占比（0–1；越高说明改动越局部） */
  unchangedRatio: number;
}

/** 按空行分段（保留段内换行；去首尾空白；纯空白段丢弃） */
function paragraphsOf(text: string): string[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/** 段级 LCS：返回 both 中按序相等的段对（锚点）。小数据量的经典 DP。 */
function lcsAnchors(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/**
 * 编辑前后 → 配对改动。
 * 空输入安全返回全空；一侧为空时另一侧整份进 addedOnly/removedOnly。
 */
export function pairedDiff(before: string, after: string): PairedDiff {
  const a = paragraphsOf(before);
  const b = paragraphsOf(after);
  const out: PairedDiff = { pairs: [], addedOnly: [], removedOnly: [], unchangedRatio: a.length === 0 ? 1 : 0 };
  if (a.length === 0 && b.length === 0) return out;
  if (a.length === 0) {
    out.addedOnly = b;
    return out;
  }
  if (b.length === 0) {
    out.removedOnly = a;
    return out;
  }

  const anchors = lcsAnchors(a, b);
  out.unchangedRatio = anchors.length / Math.max(a.length, b.length);

  // 锚点把两侧各切成若干变更区；每区按区内序号两两配对
  let ai = 0;
  let bi = 0;
  for (const [ax, bx] of [...anchors, [a.length, b.length] as [number, number]]) {
    const removed = a.slice(ai, ax);
    const added = b.slice(bi, bx);
    const n = Math.max(removed.length, added.length);
    for (let k = 0; k < n; k++) {
      const r = removed[k];
      const c = added[k];
      if (r !== undefined && c !== undefined) out.pairs.push({ before: r, after: c });
      else if (r !== undefined) out.removedOnly.push(r);
      else if (c !== undefined) out.addedOnly.push(c);
    }
    ai = ax + 1;
    bi = bx + 1;
  }
  return out;
}

/** 配对改动渲染成 prompt 用的对照清单（每侧截断；条数封顶；无配对时如实说明） */
export function pairedDiffSummary(diff: PairedDiff, maxPairs = 30, maxChars = 160): string {
  const cut = (s: string) => {
    const oneLine = s.replace(/\s+/g, " ").trim();
    return oneLine.length > maxChars ? oneLine.slice(0, maxChars) + "…" : oneLine;
  };
  const out: string[] = [];
  const pairs = diff.pairs.slice(0, maxPairs);
  pairs.forEach((p, i) => {
    out.push(`${i + 1}. 「原：${cut(p.before)}」→「改：${cut(p.after)}」`);
  });
  if (diff.pairs.length > maxPairs) out.push(`（其余 ${diff.pairs.length - maxPairs} 处配对改动省略）`);
  for (const s of diff.addedOnly.slice(0, 10)) out.push(`+ 纯新增：${cut(s)}`);
  for (const s of diff.removedOnly.slice(0, 10)) out.push(`- 纯删除：${cut(s)}`);
  if (out.length === 0) return "（没有可配对的改动）";
  return out.join("\n");
}
