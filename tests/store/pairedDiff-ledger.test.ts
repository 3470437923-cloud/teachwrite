/** 配对对照（B5）与规则台账的回归锁。 */
import { describe, expect, it } from "vitest";
import { pairedDiff, pairedDiffSummary } from "../../src/core/store/pairedDiff";
import { nextLedgerId, parseLedger, promotableEntries, serializeLedger } from "../../src/core/store/ledger";

describe("pairedDiff（段落级配对）", () => {
  it("完全相同的文本：无改动，未改占比 1", () => {
    const d = pairedDiff("甲。\n\n乙。", "甲。\n\n乙。");
    expect(d.pairs).toEqual([]);
    expect(d.addedOnly).toEqual([]);
    expect(d.removedOnly).toEqual([]);
    expect(d.unchangedRatio).toBe(1);
  });

  it("改动一段 → 恰好一对「原 → 改」", () => {
    const d = pairedDiff("他停下。\n\n她笑了笑。", "他停下。\n\n她扯了下嘴角。");
    expect(d.pairs).toEqual([{ before: "她笑了笑。", after: "她扯了下嘴角。" }]);
    expect(d.addedOnly).toEqual([]);
    expect(d.removedOnly).toEqual([]);
  });

  it("纯新增与纯删除不配对", () => {
    const d = pairedDiff("甲。\n\n丙。", "甲。\n\n乙。\n\n丙。");
    expect(d.pairs).toEqual([]);
    expect(d.addedOnly).toEqual(["乙。"]);
    const d2 = pairedDiff("甲。\n\n乙。\n\n丙。", "甲。\n\n丙。");
    expect(d2.removedOnly).toEqual(["乙。"]);
  });

  it("连续变更区按区内序号两两配对", () => {
    const d = pairedDiff("锚一\n\n旧A\n\n旧B\n\n锚二", "锚一\n\n新A\n\n新B\n\n锚二");
    expect(d.pairs).toEqual([
      { before: "旧A", after: "新A" },
      { before: "旧B", after: "新B" },
    ]);
  });

  it("空输入安全返回；一侧为空整份进 addedOnly/removedOnly", () => {
    expect(pairedDiff("", "").pairs).toEqual([]);
    expect(pairedDiff("", "甲。").addedOnly).toEqual(["甲。"]);
    expect(pairedDiff("甲。", "").removedOnly).toEqual(["甲。"]);
  });
});

describe("pairedDiffSummary（喂给模型的对照清单）", () => {
  it("配对按序渲染为「原 → 改」，可截断", () => {
    const d = pairedDiff("锚\n\n旧段", "锚\n\n新段");
    const s = pairedDiffSummary(d);
    expect(s).toContain("「原：旧段」→「改：新段」");
  });

  it("没有配对改动时如实说明", () => {
    expect(pairedDiffSummary(pairedDiff("甲", "甲"))).toBe("（没有可配对的改动）");
  });
});

describe("规则台账（B5）", () => {
  it("解析 → 序列化 → 再解析 往返一致", () => {
    const entries = [
      {
        id: "GL-001",
        rule: "删掉「眼眶一热」类套用反应",
        category: "词汇",
        evidence: "第3章；第7章",
        hits: 2,
        status: "候选",
        updated: "2026-10-05",
      },
    ];
    const round = parseLedger(serializeLedger(entries));
    expect(round).toEqual(entries);
  });

  it("编号只增：nextLedgerId 取现有最大 +1；空台账从 GL-001 起", () => {
    expect(nextLedgerId([])).toBe("GL-001");
    expect(nextLedgerId(parseLedger(serializeLedger([
      { id: "GL-002", rule: "x", category: "其他", evidence: "", hits: 1, status: "已否决", updated: "" },
    ])))).toBe("GL-003");
  });

  it("可提请确认 = 候选且命中 ≥2", () => {
    const entries = parseLedger(serializeLedger([
      { id: "GL-001", rule: "a", category: "词汇", evidence: "", hits: 2, status: "候选", updated: "" },
      { id: "GL-002", rule: "b", category: "词汇", evidence: "", hits: 1, status: "候选", updated: "" },
      { id: "GL-003", rule: "c", category: "词汇", evidence: "", hits: 5, status: "已晋升", updated: "" },
    ]));
    expect(promotableEntries(entries).map((e) => e.id)).toEqual(["GL-001"]);
  });

  it("坏行跳过、空文本安全返回（只读不判）", () => {
    expect(parseLedger("")).toEqual([]);
    expect(parseLedger("随便一段\n- 规则：没有标题行")).toEqual([]);
  });
});
