/**
 * 回流任务装配：候选/正文两路语义（候选禁止回写事实；正文增量回写），
 * 审稿只出报告、正文只读，资料维护须经 question 确认，学习记录路径。
 *
 * 提示词里的 小说资料/个人改稿、06-写作规则.md、00-项目状态.md、待确认/、
 * 章节内容/ 均为磁盘契约名，断言即回归锁。
 */
import { describe, expect, it } from "vitest";
import {
  buildBootstrapPrompt,
  buildReflowPrompt,
  buildStyleReflowPrompt,
  normalizeReflowMode,
  REFLOW_MODES,
  reflowSessionTitle,
  reflowTracksFor,
} from "../../src/core/ai/reflow";
import { diffLines, pendingRefrows, type OplogEntry } from "../../src/core/store/oplog";

// 100→90：数字变化的典型样例（金额类事实，回流必须点名核对）
const diff = diffLines("他有100元。", "他有90元，转身走了。");

describe("buildReflowPrompt：候选稿路径", () => {
  const p = buildReflowPrompt({
    relPath: "待确认/第3章-v2-候选.md",
    kind: "candidate",
    chapterLabel: "第3章",
    diff,
  });

  it("带回流标记、章号与文件路径", () => {
    expect(p).toContain("【回流】");
    expect(p).toContain("第3章");
    expect(p).toContain("待确认/第3章-v2-候选.md");
  });

  it("候选稿：明令禁止把候选情节写入事实记录（阿序铁律）", () => {
    expect(p).toContain("禁止");
    expect(p).toMatch(/禁止\*\*?把候选情节写入/);
  });

  it("审稿只出报告：确认也不代改正文，资料修改仍须 question", () => {
    expect(p).toContain("只输出审稿报告");
    expect(p).toContain("即使用户确认也不改写正文");
    expect(p).toContain("不生成示范、对白或替代句");
    expect(p).toContain("资料修改逐项通过 question 确认");
  });

  it("学习记录写入 个人改稿/改稿对比-第N章.md，晋升需 question 确认", () => {
    expect(p).toContain("小说资料/个人改稿/改稿对比-第3章.md");
    expect(p).toContain("个人文风（学习沉淀）");
  });

  it("diff 摘要随任务下发（数字变化被点名）", () => {
    expect(diff.digitsChanged).toBe(true);
    expect(p).toContain("数字变化");
    expect(p).toContain("变更摘要");
    // diffSummaryText 的行前缀格式：- 删除行 / + 新增行
    expect(p).toContain("- 他有100元。");
    expect(p).toContain("+ 他有90元，转身走了。");
  });
});

describe("buildReflowPrompt：正式正文路径", () => {
  const p = buildReflowPrompt({
    relPath: "章节内容/第7章.md",
    kind: "chapter",
    chapterLabel: "第7章",
    diff,
  });

  it("正文：按变更增量回写追踪表与章节摘要，注明来源章节", () => {
    expect(p).toContain("作者手写并已保存的正式正文");
    expect(p).toContain("增量更新");
    expect(p).toContain("注明来源章节");
  });

  it("正文路径不出现候选禁止条款", () => {
    expect(p).not.toContain("禁止**把候选情节写入");
  });

  it("冲突登记到 00-项目状态，不能修改任何正文或代替作者归档", () => {
    expect(p).toContain("尚未解决的冲突");
    expect(p).toContain("不修改任何正文");
    expect(p).toContain("不替作者确认归档");
  });

  it("章号未识别时如实标注", () => {
    // 不猜测章号：标签缺失时明说「章号未识别」，学习记录文件名同样如实
    const q = buildReflowPrompt({ relPath: "章节内容/终章.md", kind: "chapter", chapterLabel: null, diff });
    expect(q).toContain("章号未识别");
  });
});

describe("reflowSessionTitle", () => {
  it("标题含章号与稿件类型（会话列表可追溯）", () => {
    expect(reflowSessionTitle("第3章", "candidate")).toBe("回流 - 第3章（候选）");
    expect(reflowSessionTitle("第7章", "chapter")).toBe("回流 - 第7章（正文）");
    expect(reflowSessionTitle(null, "chapter")).toBe("回流 - 稿件（正文）");
  });

  it("风格通道标题带「风格」前缀（与资料回流在会话列表里可区分）", () => {
    expect(reflowSessionTitle("第3章", "chapter", "style")).toBe("风格回流 - 第3章（正文）");
    expect(reflowSessionTitle("第3章", "candidate", "style")).toBe("风格回流 - 第3章（候选）");
  });
});

describe("四态路由（D-043）", () => {
  it("off 什么都不排；facts 只资料；style 只风格；all 实质改动双通道", () => {
    expect(reflowTracksFor("off", false)).toEqual([]);
    expect(reflowTracksFor("off", true)).toEqual([]);
    expect(reflowTracksFor("facts", false)).toEqual(["facts"]);
    expect(reflowTracksFor("style", false)).toEqual(["style"]);
    expect(reflowTracksFor("all", false)).toEqual(["facts", "style"]);
  });

  it("轻改动（≤24 字符且数字未变）：facts 不审、style 照排（词级改动是最纯的文风证据）", () => {
    expect(reflowTracksFor("facts", true)).toEqual([]);
    expect(reflowTracksFor("style", true)).toEqual(["style"]);
    expect(reflowTracksFor("all", true)).toEqual(["style"]);
  });

  it("normalizeReflowMode：非法值回落 null（调用方按 all 处理）", () => {
    expect(normalizeReflowMode("all")).toBe("all");
    expect(normalizeReflowMode("off")).toBe("off");
    expect(normalizeReflowMode("bogus")).toBeNull();
    expect(normalizeReflowMode(undefined)).toBeNull();
  });
});

describe("REFLOW_MODES（界面四态的唯一样本）", () => {
  it("四态齐全、顺序固定，每条都带标签与说明（缺一条界面就少一个选项）", () => {
    expect(REFLOW_MODES.map((m) => m.id)).toEqual(["all", "facts", "style", "off"]);
    for (const m of REFLOW_MODES) {
      expect(m.label.trim().length).toBeGreaterThan(0);
      expect(m.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it("每个 id 都能被 normalizeReflowMode 原样读回（按书记住的模式重启后仍有效）", () => {
    for (const m of REFLOW_MODES) expect(normalizeReflowMode(m.id)).toBe(m.id);
  });
});

describe("buildStyleReflowPrompt（风格通道）", () => {
  const p = buildStyleReflowPrompt({
    relPath: "章节内容/第7章.md",
    kind: "chapter",
    chapterLabel: "第7章",
    diff,
  });

  it("只做对照学习：不审稿、不动事实、不写追踪表", () => {
    expect(p).toContain("【风格回流】");
    expect(p).toContain("规则台账.md");
    expect(p).toContain("命中章节数");
    expect(p).toContain("不做审稿");
    expect(p).toContain("不更新追踪表");
  });

  it("晋升门槛与去向：≥2 章命中 → question 逐条确认 → 06-写作风格.md", () => {
    expect(p).toContain("question");
    expect(p).toContain("06-写作风格.md");
    expect(p).toContain("禁用列表");
  });
});

describe("pendingRefrows（队列落盘配对）", () => {
  const entry = (id: string, pending: boolean, prompt = "任务文本", track = "facts"): OplogEntry => ({
    ts: "t",
    action: "reflow",
    relPath: "",
    sessionId: "",
    detail: pending ? { reflowId: id, reflowPending: true, prompt, title: `T-${id}`, reflowTrack: track } : { reflowId: id },
  });

  it("pending 无完成行 → 待补跑；有完成行 → 不补", () => {
    const entries = [entry("a", true), entry("b", true), entry("a", false)];
    const out = pendingRefrows(entries);
    expect(out.map((p) => p.reflowId)).toEqual(["b"]);
    expect(out[0].prompt).toBe("任务文本");
  });

  it("缺 prompt 的 pending 行不可补跑（没有任务文本），忽略非 reflow 动作", () => {
    const entries: OplogEntry[] = [
      { ts: "t", action: "edit_end", relPath: "", sessionId: "", detail: {} },
      { ts: "t", action: "reflow", relPath: "", sessionId: "", detail: { reflowId: "x", reflowPending: true } },
    ];
    expect(pendingRefrows(entries)).toEqual([]);
  });

  it("同一 id 重新入队以最后一次为准；通道随日志恢复", () => {
    const entries = [entry("a", true, "旧"), entry("a", true, "新", "style")];
    const out = pendingRefrows(entries);
    expect(out[0].prompt).toBe("新");
    expect(out[0].track).toBe("style");
  });
});

describe("buildBootstrapPrompt（建仓任务，B8）", () => {
  it("先报预估量经确认再动手；产物只暂存资料审核区，不写正文目录", () => {
    const p = buildBootstrapPrompt("伏笔", "追踪-伏笔.md");
    expect(p).toContain("【建仓】");
    expect(p).toContain("预估读取量");
    expect(p).toContain("question");
    expect(p).toContain("小说资料/审核/建仓-伏笔-");
    expect(p).toContain("不直接覆盖追踪表");
    expect(p).not.toContain("写到 待确认/");
    expect(p).toContain("正文、候选稿和归档凭据都不可改动");
    expect(p).toContain("启用模块");
  });
});
