/** I-4 回归锁：伏笔条目计数与自述统计核对（认不出不猜、没自述不报） */
import { describe, expect, it } from "vitest";
import { countForeshadowing } from "../../src/core/store/tracking";

const DOC = `# 追踪-伏笔
## 伏笔统计（自述口径：必须与下方条目数一致，应用会核对）
- 开放：2
- 已回收：1
- 废弃：1
- 合计：4

## F001 断线的风筝
- 内容与涉及对象：风筝
- 状态：开放

## F002 旧照片
- 状态：已回收（第12章）

## F003 母亲的药瓶
- 状态：开放

## F004 假身份
- 状态：废弃

## F005 新条目还没定
- 内容与涉及对象：待填写
- 状态：开放／已回收／废弃
`;

describe("countForeshadowing", () => {
  it("按状态计数、收集编号，并与自述一致时不报", () => {
    const c = countForeshadowing(DOC);
    expect(c.open).toBe(2);
    expect(c.collected).toBe(1);
    expect(c.dropped).toBe(1);
    expect(c.unclassified).toBe(1); // F005 还是占位样板，不硬塞进任何一类
    expect(c.ids).toEqual(["F001", "F002", "F003", "F004", "F005"]);
    expect(c.declared).toEqual({ open: 2, collected: 1, dropped: 1, total: 4 });
    expect(c.mismatches).toEqual([]);
  });

  it("自述与实际不一致时给出人话说明（细纲附件自述 29+8 的核对落点）", () => {
    const c = countForeshadowing(DOC.replace("- 已回收：1", "- 已回收：29").replace("- 合计：4", "- 合计：32"));
    expect(c.mismatches.length).toBeGreaterThan(0);
    expect(c.mismatches[0]).toContain("已回收");
    expect(c.mismatches[0]).toContain("29");
    expect(c.mismatches.some((m) => m.startsWith("合计"))).toBe(true);
  });

  it("模板默认（全是「待填写」）＝没有自述，不报任何问题", () => {
    const tpl = `# 追踪-伏笔
## 伏笔统计（自述口径：必须与下方条目数一致，应用会核对）
- 开放：待填写
- 已回收：待填写
- 废弃：待填写
- 合计：待填写

## F001（模板，新伏笔复制本条目）
- 内容与涉及对象：待填写
- 状态：开放／已回收／废弃
`;
    const c = countForeshadowing(tpl);
    expect(c.declared).toEqual({});
    expect(c.mismatches).toEqual([]);
    expect(c.unclassified).toBe(1);
  });

  it("无统计块 / 无条目 / 空串都安全返回", () => {
    const noStats = countForeshadowing("# 追踪-伏笔\n## F001 x\n- 状态：开放\n");
    expect(noStats.open).toBe(1);
    expect(noStats.declared).toEqual({});
    expect(noStats.mismatches).toEqual([]);
    expect(countForeshadowing("").ids).toEqual([]);
  });

  it("CRLF 与半角冒号同样可解析", () => {
    const c = countForeshadowing("# x\r\n## F001\r\n- 状态: 已回收\r\n");
    expect(c.collected).toBe(1);
  });

  it("自定状态不猜（计入 unclassified 而不是开放）", () => {
    const c = countForeshadowing("## F001\n- 状态：悬置\n");
    expect(c.open).toBe(0);
    expect(c.unclassified).toBe(1);
  });

  it("B12-8：标题里含「统计」二字的条目/附录不再劫持统计模式", () => {
    // 条目标题带「统计」字样：其 `- 状态` 必须照常计数
    const entry = countForeshadowing("## F001\n- 状态：开放\n\n## F010 统计口径待定\n- 状态：已回收\n");
    expect(entry.open).toBe(1);
    expect(entry.collected).toBe(1);
    expect(entry.declared).toEqual({});

    // 普通「统计说明」节里的字段不当自述（旧实现在这里会把 - 状态 吃掉）
    const appendix = countForeshadowing("## 统计说明\n- 状态：开放\n- 已回收：99\n\n## F001\n- 状态：开放\n");
    expect(appendix.declared).toEqual({});
    expect(appendix.open).toBe(1);
  });
});
