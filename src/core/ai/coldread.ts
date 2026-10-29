/**
 * 冷读（独立审读实例，D-045 重构）。
 *
 * 与 D-014 时代的差别（用户 2026-10-05 裁决）：
 *  - 不再复用主聊天界面：结果进**悬浮面板**（无遮罩、可拖动），用户看着清单改稿；
 *  - 不再落盘：不写 小说资料\审核\ 报告、不建会话，关窗即弃（oplog 仍记一行最小痕迹）；
 *  - 通道从 clarity/pace 改为两路：
 *      plot  —— 剧情冷读（**完全冷**：无大纲/设定/人物资料/作者解释，只查连贯度与硬性 bug）；
 *      style —— 风格对照（**半冷**：注入 06-写作风格.md 档案，只查风格不符）。
 *  - 输出是**结构化问题块**（严格格式契约，见 FORMAT_CONTRACT），程序解析成行条目；
 *    解析失败的部分进 leftover 原文块（不丢内容，只是不能勾选）。
 *
 * 隔离仍由代码物理保证：sendIsolated（零工具、零技能、零项目块）；
 * style 通道注入的风格档案是**用户自己写的规则**，由调用方读盘后作为正文材料传入，
 * 模型侧依然没有任何文件读取能力。
 */

/** 冷读通道 */
export type ColdReadChannel = "plot" | "style";

/** 通道 → 面板/日志里展示的中文标签 */
export const COLD_READ_CHANNEL_LABEL: Record<ColdReadChannel, string> = {
  plot: "剧情 · 完全冷",
  style: "风格 · 对照档案",
};

/**
 * 问题类别（封闭集合；模型必须从中选，解析器把未知类别归进「其他」）。
 * plot 只装"读不顺/对不上"的硬问题；style 只装"不像这本书"的表达问题。
 */
export const COLD_READ_CATEGORIES: Record<ColdReadChannel, readonly string[]> = {
  plot: ["连贯断裂", "硬性bug", "状态矛盾", "信息缺失", "其他"],
  style: ["禁用词命中", "句式节奏", "语气不符", "人设声线", "其他"],
};

/** 输出格式契约（写进两套系统提示词；解析器 parseColdReadIssues 按它逐字切） */
const FORMAT_CONTRACT =
  "输出格式（严格遵守，这是程序要解析的契约）：\n" +
  "每条问题输出一个块，块与块之间空一行，字段名逐字照写：\n\n" +
  "【问题】\n" +
  "类别：（只能从给定类别里选一个）\n" +
  "位置：第几段「短引原文，不超过20字」\n" +
  "问题：读者在这里会怎么理解或误读（一两句话）\n" +
  "依据：正文里的证据（一两句话）\n" +
  "补足：最少需要澄清或补足什么（一两句话）\n\n" +
  "如果一个有依据的问题都没有：只输出【无问题】，然后说明你逐一核对过哪些方面。";

/** 共用输出纪律：报告制、不打分、不凑数、不替写 */
const COMMON_OUTPUT_RULES =
  "纪律（必须遵守）：\n" +
  "- 只诊断、不改稿：不替写正文，不给整段重写稿。\n" +
  "- 不打分，不统计问题数量，不为了凑数硬找；正常的留白、悬念和不影响理解的选择不算问题。\n" +
  "- 只写有正文依据的问题；拿不准的不算。\n";

/** plot 通道身份：第一次读到这份稿子的新读者（完全冷的隔离价值） */
const PLOT_IDENTITY =
  "你是一名第一次阅读这部小说的普通读者兼审读员。你只看得到下面提供的正文文本，" +
  "没有任何大纲、设定、人物资料或作者解释，也无法读取任何文件。这正是你的价值：" +
  "作者和写作助手知道得太多，会无意识替正文补全信息；你只知道读者知道的。\n\n";

/** style 通道身份：拿着作者风格档案的校对（半冷：不看设定与前情，只看档案与正文） */
const STYLE_IDENTITY =
  "你是一名文字校对。你看不到这部小说的大纲、设定与人物资料，也无法读取任何文件；" +
  "你手上只有两样东西：作者自己定的「写作风格档案」，和要审的正文。" +
  "你的任务是只回答一个问题：这段正文符不符合档案里定下的风格。\n\n";

/** plot 通道系统提示词：剧情连贯度与硬性 bug，四核对方面 + 格式契约 */
export const COLD_READ_SYSTEM_PLOT =
  PLOT_IDENTITY +
  "本次审读目标：剧情连贯度与硬性 bug。只审「只读正文的读者会不会读错、读断、读出矛盾」，逐一核对：\n" +
  "1. 连贯断裂：与前文（若提供）或本章自身对不上的地方——伏笔没回收不算，回收错了才算；\n" +
  "2. 硬性bug：因果、时间、空间上的不可能或自相矛盾；\n" +
  "3. 状态矛盾：伤势、持物、位置、知情、情绪、关系、资源在变化后无故复原或凭空消失；\n" +
  "4. 信息缺失：新身份、能力、物件、消息、地点第一次影响理解时，正文没给读者当下必要的依据。\n\n" +
  "问题类别只能从以下选一个：连贯断裂 / 硬性bug / 状态矛盾 / 信息缺失 / 其他。\n\n" +
  COMMON_OUTPUT_RULES +
  "\n" +
  FORMAT_CONTRACT;

/** style 通道系统提示词：对照风格档案查不符；类别与「无问题」话术随通道替换 */
export const COLD_READ_SYSTEM_STYLE =
  STYLE_IDENTITY +
  "本次审读目标：风格对照。把正文逐段与「写作风格档案」对照，只找出**不符**：\n" +
  "1. 禁用词命中：档案禁用列表里的词/句式在正文里出现了；\n" +
  "2. 句式节奏：与档案规定的句式、段落节奏明显相悖（如档案禁长句而此处连用长句）；\n" +
  "3. 语气不符：叙述语气偏离档案定的基调；\n" +
  "4. 人设声线：人物说话的声线与档案/正文既有塑造不一致。\n" +
  "档案没规定的方面一律不审；档案与正文冲突时以档案为准提出，但要在「依据」里引档案原文。\n\n" +
  "问题类别只能从以下选一个：禁用词命中 / 句式节奏 / 语气不符 / 人设声线 / 其他。\n\n" +
  COMMON_OUTPUT_RULES +
  "\n" +
  FORMAT_CONTRACT;

/** 按通道取系统提示词（未知通道回退 plot，与类型缺省一致） */
export function coldReadSystem(channel: ColdReadChannel): string {
  return channel === "style" ? COLD_READ_SYSTEM_STYLE : COLD_READ_SYSTEM_PLOT;
}

/** 冷读随对象附带的前文（plot 通道：读者已读部分；只给正文文本，不给任何设定资料） */
export interface ColdReadPrior {
  /** 前文标题（如 第2章） */
  title: string;
  text: string;
}

/**
 * 装配冷读会话的首条用户消息。
 *  - plot：前文（按阅读顺序）+ 审读对象全文；
 *  - style：风格档案 + 审读对象全文（不带前文：风格判断不需要前情，省 token 也避免混入设定）。
 */
export function buildColdReadUserMessage(
  channel: ColdReadChannel,
  chapterTitle: string,
  chapterText: string,
  priors: ColdReadPrior[] = [],
  styleDossier?: string,
): string {
  let out = "";
  if (channel === "style") {
    out += `【写作风格档案】\n${(styleDossier ?? "").trim()}\n\n`;
  } else {
    for (const p of priors) {
      out += `【前文（读者已读部分）：${p.title}】\n${p.text.trim()}\n\n`;
    }
  }
  out += `【本次审读对象：${chapterTitle}】\n${chapterText.trim()}\n\n`;
  out += "请按系统指令的格式开始审读。";
  return out;
}

/** 一条解析出的问题（panel 行条目的数据核） */
export interface ColdIssue {
  /** 稳定 id（通道 + 序号），供 React key 与行操作定位 */
  id: string;
  /** 类别（已归一到本通道的封闭集合；未知类别归「其他」） */
  category: string;
  /** 位置描述（如「第12段」；模型没给段落号时为原文其余部分） */
  location: string;
  /** 「」内的短引原文（定位跳转用它；没有则为空串） */
  quote: string;
  /** 问题描述 */
  problem: string;
  /** 文本依据 */
  basis: string;
  /** 最少需要补足什么 */
  fix: string;
}

/** parseColdReadIssues 的结果 */
export interface ColdReadParse {
  issues: ColdIssue[];
  /** 模型明确报告【无问题】（且没有任何问题块） */
  noIssues: boolean;
  /** noIssues 时模型给出的核对说明 */
  note: string;
  /** 问题块之外的散文（开头说明/结尾汇总等），展示用；无则为空串 */
  leftover: string;
}

const FIELD_RE = /^(类别|位置|问题|依据|补足)\s*[：:]\s*(.*)$/;
const QUOTE_RE = /^(.*?)[「『](.+?)[」』]\s*$/;

/**
 * 解析冷读输出为行条目。契约见 FORMAT_CONTRACT。
 * 容错纪律：字段缺失给空串、未知类别归「其他」、块外散文进 leftover ——
 * 解析失败**不丢内容**，只是该行不能精准定位。
 */
export function parseColdReadIssues(text: string, channel: ColdReadChannel): ColdReadParse {
  const categories = COLD_READ_CATEGORIES[channel];
  // split 锚在行首即可：标记同行跟字段（"【问题】类别：…"）也能被 FIELD_RE 吃掉
  const parts = text.split(/^【问题】/m);
  // split 后首段是首个问题块之前的散文（可能是空串）
  const head = (parts.shift() ?? "").trim();
  const issues: ColdIssue[] = [];
  const tails: string[] = [];
  parts.forEach((block, i) => {
    const fields: Record<string, string> = {};
    let lastKey = "";
    let closed = false; // 契约规定块间空行：字段区遇到空行即视为本块结束，余下是散文
    let leftoverInBlock = "";
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        if (lastKey) closed = true;
        continue;
      }
      if (closed) {
        leftoverInBlock = leftoverInBlock ? leftoverInBlock + "\n" + line : line;
        continue;
      }
      const m = FIELD_RE.exec(line);
      if (m) {
        lastKey = m[1];
        fields[lastKey] = m[2].trim();
      } else if (lastKey) {
        // 续行并入上一个字段（模型把「问题」写成两行的容错）
        fields[lastKey] = fields[lastKey] + "\n" + line;
      } else {
        leftoverInBlock = leftoverInBlock ? leftoverInBlock + "\n" + line : line;
      }
    }
    if (leftoverInBlock) tails.push(leftoverInBlock);
    if (!fields["问题"] && !fields["位置"] && !fields["类别"]) {
      // 整块都不是字段：模型没按格式来，整块回 leftover，不硬造条目
      return;
    }
    const locRaw = fields["位置"] ?? "";
    const qm = QUOTE_RE.exec(locRaw);
    const cat = categories.includes(fields["类别"] ?? "") ? fields["类别"] : "其他";
    issues.push({
      id: `${channel}-${i}`,
      category: cat,
      location: qm ? qm[1].trim() : locRaw,
      quote: qm ? qm[2].trim() : "",
      problem: fields["问题"] ?? "",
      basis: fields["依据"] ?? "",
      fix: fields["补足"] ?? "",
    });
  });
  const leftover = [head, ...tails].filter(Boolean).join("\n\n");
  const noIssues = issues.length === 0 && /【无问题】/.test(text);
  return {
    issues,
    noIssues,
    note: noIssues ? text.replace(/【无问题】/g, "").trim() : "",
    leftover: noIssues ? "" : leftover,
  };
}

/**
 * 「发送给 AI」的任务文本：把勾选的行条目组装成一条给主聊天的修改指令。
 * 纪律：只改列出的问题、改动最小化、不顺手润色；逐条报告改法；快照由系统保留。
 */
export function buildColdFixMessage(
  chapterLabel: string,
  relPath: string,
  issues: readonly ColdIssue[],
): string {
  const lines = issues.map((it, i) => {
    const loc = it.location ? `${it.location}` : "位置未标注";
    const quote = it.quote ? `「${it.quote}」` : "";
    return (
      `${i + 1}. [${it.category}] ${loc}${quote}\n` +
      `   问题：${it.problem.replace(/\n/g, " ")}\n` +
      (it.basis ? `   依据：${it.basis.replace(/\n/g, " ")}\n` : "") +
      (it.fix ? `   补足：${it.fix.replace(/\n/g, " ")}` : "")
    );
  });
  return (
    `【冷读修复】请修改 ${relPath}（${chapterLabel}），逐条处理下面勾选的审读问题：\n` +
    lines.join("\n") +
    `\n要求：只处理上面列出的问题，改动最小化，不顺手润色未列出的段落；` +
    `审读员看不到设定，先逐条判断问题是否成立（有些「看不懂」恰是伏笔或刻意留白），不成立的说明理由、不要改；` +
    `每处改完用一句话报告改了什么；写前快照由系统保留，不要自己备份文件。`
  );
}
