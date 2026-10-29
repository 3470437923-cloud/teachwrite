/**
 * 资料表格视图（DocTable.tsx）与解析层之间那层**显示契约**的回归锁（2026-10-11）。
 *
 * 这里不渲染组件（本仓库测试环境是 node，没有 DOM 库），只钉住两侧共用的纯数据契约：
 *  ① 状态符号表：用户指定的 √ / ? / × 映射，以及「没约定就原样显示」；
 *  ② 词表耦合：点选清单里的每个状态值都要有符号，否则用户从下拉里选出来的值
 *     在表格里会退回中文长词，把 5% 宽的列撑开；
 *  ③ 空列不许回来：原行末删钮列（.dt-rowact）已按用户裁决删除，源码级钉死。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { statusSymbol } from "../../src/core/store/doctable";
import { STATUS_BY_FILE } from "../../src/ui/DocTable";

describe("状态符号化（√ / ? / ×）", () => {
  it("规则台账：已晋升 √、附条件 ?、未晋升（待观察） ×", () => {
    expect(statusSymbol("规则台账.md", "已晋升")).toBe("√");
    expect(statusSymbol("规则台账.md", "已晋升（附条件）")).toBe("?");
    expect(statusSymbol("规则台账.md", "待观察")).toBe("×");
    expect(statusSymbol("规则台账.md", "候选")).toBe("×");
    expect(statusSymbol("规则台账.md", "已否决")).toBe("×");
  });

  it("追踪-伏笔：已回收 √、开放 ?、废弃 ×", () => {
    expect(statusSymbol("追踪-伏笔.md", "已回收")).toBe("√");
    expect(statusSymbol("追踪-伏笔.md", "开放")).toBe("?");
    expect(statusSymbol("追踪-伏笔.md", "废弃")).toBe("×");
  });

  it("没约定的文件与取值 → undefined（界面按中文原值显示，不猜）", () => {
    expect(statusSymbol("追踪-时间线.md", "开放")).toBeUndefined();
    expect(statusSymbol("追踪-资源与权限.md", "有效")).toBeUndefined();
    expect(statusSymbol("规则台账.md", "某个自造状态")).toBeUndefined();
    expect(statusSymbol("00-项目状态.md", "连续写作")).toBeUndefined();
  });
});

describe("符号表与点选清单耦合", () => {
  it("两个用户点名的表，其点选清单里的每个值都要有符号", () => {
    const covered = ["规则台账.md", "追踪-伏笔.md"];
    for (const file of covered) {
      const values = STATUS_BY_FILE[file];
      expect(values, `${file} 不在点选清单里`).toBeTruthy();
      for (const v of values!) {
        expect(statusSymbol(file, v), `${file} 的「${v}」缺符号`).toBeTruthy();
      }
    }
  });

  it("台账词表覆盖盘上真实在用的三个值（待观察 / 已晋升 / 已晋升（附条件））", () => {
    // 回归锁：旧词表只有「候选/已晋升/已否决」，用户点不出「待观察」与「已晋升（附条件）」
    expect(STATUS_BY_FILE["规则台账.md"]).toEqual(
      expect.arrayContaining(["待观察", "已晋升", "已晋升（附条件）"]),
    );
  });
});

describe("空列不许回来（用户 2026-10-11：「最右边多余空白列删掉」）", () => {
  it("DocTable.tsx 不再有行末删钮列（.dt-rowact / dt-rowdel 以外的独立 th）", () => {
    const src = readFileSync(fileURLToPath(new URL("../../src/ui/DocTable.tsx", import.meta.url)), "utf8");
    expect(src).not.toContain("dt-rowact");
    // 删钮改为浮在行右端
    expect(src).toContain("dt-rowdel");
  });

  it("样式表里也没有残留的 .dt-rowact 规则", () => {
    const css = readFileSync(fileURLToPath(new URL("../../src/styles/app.css", import.meta.url)), "utf8");
    expect(css).not.toContain(".dt-rowact");
    expect(css).toContain(".dt-rowdel");
  });
});
