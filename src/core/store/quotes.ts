/**
 * 英文双引号 → 中文双引号（编辑器底部「统一引号」键；用户裁决：只转双引号，单引号不动）。
 *
 * 配对规则：逐行交替 —— 每行内第 1/3/5… 个 `"` 转为开引号“，其余转为闭引号”。
 * 为什么逐行而不是全文交替：中文小说的连续对话跨段时，每段都以开引号起笔
 * （上一段故意不闭口），全文交替会把第二段段首的开引号错判成闭引号；
 * 逐行重置正好覆盖这个写作习惯。
 * 已知边界：一行内出现奇数个 `"`（漏配/半数引用）时按交替照常转换，
 * 并在返回值里报出行号，由界面提示用户复核 —— 不猜、不静默。
 */

export interface QuoteUnifyResult {
  /** 转换后的全文 */
  text: string;
  /** 实际转换的引号个数 */
  converted: number;
  /** 引号个数为奇数的行号（1 起），供界面提示复核 */
  oddLines: number[];
}

/** 把 text 里的成对英文双引号转成中文引号“”；不含 `"` 时原样返回 */
export function unifyDoubleQuotes(text: string): QuoteUnifyResult {
  let converted = 0;
  const oddLines: number[] = [];
  const out = text
    .split("\n")
    .map((line, idx) => {
      let open = true;
      let count = 0;
      // 按码点遍历（[...str]），避免半截代理对；本函数只匹配 ASCII 引号
      const next = [...line]
        .map((ch) => {
          if (ch !== '"') return ch;
          count += 1;
          converted += 1;
          const r = open ? "“" : "”";
          open = !open;
          return r;
        })
        .join("");
      if (count % 2 === 1) oddLines.push(idx + 1);
      return next;
    })
    .join("\n");
  return { text: out, converted, oddLines };
}
