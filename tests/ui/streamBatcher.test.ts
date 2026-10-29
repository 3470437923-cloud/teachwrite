/**
 * 流式增量合批器(B19 崩溃根因修复)的回归锁。
 *
 * 钉住三件事:
 *  1. 合批语义:N 次 push 在同一次帧回调里只交付一次,且顺序内容不丢;
 *  2. flush/drop 的时序:drop 之后残量绝不追加(否则会污染刚清空的流式区);
 *  3. 稳定引用:hook 返回的对象与三个回调在重渲染之间不变,
 *     否则调用方的 useCallback 依赖会每帧失效,把「减少重渲染」的目的抵消掉。
 */
import { describe, expect, it } from "vitest";
import { StreamCoalescer } from "../../src/ui/useStreamBatcher";

/** 手动调度器:把排程收集起来,由测试决定何时"下一帧" */
function manual() {
  const queue: Array<() => void> = [];
  return {
    schedule: (run: () => void) => queue.push(run),
    frame: () => queue.splice(0, queue.length).forEach((f) => f()),
    pending: () => queue.length,
  };
}

describe("StreamCoalescer", () => {
  it("一帧内多次 push 只交付一次,内容按序拼接", () => {
    const got: string[] = [];
    const m = manual();
    const c = new StreamCoalescer((merged) => got.push(merged), m.schedule);
    c.push("海");
    c.push("先");
    c.push("动了");
    expect(m.pending()).toBe(1); // 只排了一帧
    m.frame();
    expect(got).toEqual(["海先动了"]);
  });

  it("跨帧继续累加:每帧交付的是该帧内的增量,不是全文重放", () => {
    const got: string[] = [];
    const m = manual();
    const c = new StreamCoalescer((merged) => got.push(merged), m.schedule);
    c.push("a");
    m.frame();
    c.push("b");
    c.push("c");
    m.frame();
    expect(got).toEqual(["a", "bc"]);
  });

  it("空串 push 不排程也不交付", () => {
    const got: string[] = [];
    const m = manual();
    const c = new StreamCoalescer((merged) => got.push(merged), m.schedule);
    c.push("");
    expect(m.pending()).toBe(0);
    m.frame();
    expect(got).toEqual([]);
  });

  it("flush 立刻交付缓冲,随后的那一帧不再重复交付", () => {
    const got: string[] = [];
    const m = manual();
    const c = new StreamCoalescer((merged) => got.push(merged), m.schedule);
    c.push("甲");
    c.flush();
    expect(got).toEqual(["甲"]);
    m.frame(); // 帧回调仍会跑一次,但缓冲已空 → 不该再交付
    expect(got).toEqual(["甲"]);
  });

  it("drop 丢弃缓冲:之后那一帧什么都不交付(清空流式区前后必须用它)", () => {
    const got: string[] = [];
    const m = manual();
    const c = new StreamCoalescer((merged) => got.push(merged), m.schedule);
    c.push("残量");
    c.drop();
    m.frame();
    expect(got).toEqual([]);
    // drop 之后新内容照常工作
    c.push("新回合");
    m.frame();
    expect(got).toEqual(["新回合"]);
  });

  it("dispose 之后 push 失效(组件卸载不留幽灵更新)", () => {
    const got: string[] = [];
    const m = manual();
    const c = new StreamCoalescer((merged) => got.push(merged), m.schedule);
    c.dispose();
    c.push("不该出现");
    expect(m.pending()).toBe(0);
    m.frame();
    expect(got).toEqual([]);
  });

  it("apply 抛错不吞(业务 bug 要冒出来)", () => {
    const m = manual();
    const c = new StreamCoalescer(() => {
      throw new Error("boom");
    }, m.schedule);
    c.push("x");
    expect(() => m.frame()).toThrow("boom");
  });
});
