/**
 * 操作日志与 diff：轻量回流阈值、数字事实信号、jsonl 读写容错。
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeFs } from "../support/nodeFs";
import {
  LIGHT_EDIT_CHARS,
  appendOplog,
  diffLines,
  diffSummaryText,
  digitTokens,
  isLightEdit,
  oplogFile,
  readOplog,
} from "../../src/core/store/oplog";

let root: string;
const fs = createNodeFs();

beforeAll(async () => {
  // 临时目录前缀用产品名 deepcompose-（非磁盘契约；作品根内的 writerd_oplog 目录名是契约，测试里保持原样）
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "deepcompose-oplog-"));
});

afterAll(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

describe("diffLines（前后缀裁剪）", () => {
  it("无变更：全空", () => {
    const d = diffLines("a\r\nb", "a\r\nb");
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changedChars).toBe(0);
    expect(d.digitsChanged).toBe(false);
  });

  it("中间行替换：只报变更块", () => {
    const d = diffLines("第一行\n旧内容\n末行", "第一行\n新内容\n末行");
    expect(d.removed).toEqual(["旧内容"]);
    expect(d.added).toEqual(["新内容"]);
    expect(d.changedChars).toBe(6); // 3+3 非空白字符
  });

  it("纯新增行：removed 为空", () => {
    const d = diffLines("a\nb", "a\nx\nb");
    expect(d.added).toEqual(["x"]);
    expect(d.removed).toEqual([]);
  });

  it("数字多重集合变化 → digitsChanged（金额/数量事实信号）", () => {
    expect(diffLines("他有100元", "他有100元").digitsChanged).toBe(false);
    expect(diffLines("他有100元", "他有200元").digitsChanged).toBe(true);
    // 位置移动但集合不变：按多重集合比较（保守：仍视为变化，因为行变了）
    expect(diffLines("a 1\nb 2", "a 2\nb 1").digitsChanged).toBe(false);
  });

  it("digitTokens 排序后比较，含小数", () => {
    expect(digitTokens("3.5 和 12")).toEqual(["12", "3.5"]);
  });
});

describe("isLightEdit（轻量回流阈值）", () => {
  it("小改动且数字未变 → 轻量（只记日志）", () => {
    const d = diffLines("他走进房间，坐下。", "他走进房间，坐了下来。");
    expect(d.changedChars).toBeLessThanOrEqual(LIGHT_EDIT_CHARS);
    expect(isLightEdit(d)).toBe(true);
  });

  it("小改动但数字变了 → 不轻量（事实信号必须回流）", () => {
    const d = diffLines("余额是100元。", "余额是99元。");
    expect(d.changedChars).toBeLessThanOrEqual(LIGHT_EDIT_CHARS);
    expect(isLightEdit(d)).toBe(false);
  });

  it("大改动 → 不轻量", () => {
    const d = diffLines("旧的一整段内容。", "完全重写的一整段新内容，长度超过阈值很多很多。");
    expect(isLightEdit(d)).toBe(false);
  });
});

describe("diffSummaryText", () => {
  it("标记增删并截断长行", () => {
    const long = "长".repeat(200);
    const s = diffSummaryText(diffLines(`旧\n${long}`, `新\n${long}补`), 40, 120);
    expect(s).toContain("- 旧");
    expect(s).toContain("+ 新");
    expect(s).not.toContain("长".repeat(200));
    expect(s).toContain("…");
  });

  it("行数超限折叠为省略提示", () => {
    const before = Array.from({ length: 50 }, (_, i) => `旧${i}`).join("\n");
    const after = Array.from({ length: 50 }, (_, i) => `新${i}`).join("\n");
    const s = diffSummaryText(diffLines(before, after), 10, 120);
    expect(s).toContain("其余 40 行删除省略");
    expect(s).toContain("其余 40 行新增省略");
  });
});

describe("oplog jsonl 读写", () => {
  it("追加两条后按序读回；损坏行跳过", async () => {
    await appendOplog(fs, root, "open", "章节内容\\第1章.md", "sess-1");
    await appendOplog(fs, root, "edit_end", "待确认/第2章-v2-候选.md", "sess-1", {
      changedChars: 42,
      digitsChanged: true,
      reflowTriggered: true,
    });
    // 人为注入损坏行：readOplog 必须跳过而不是整体失败
    await fsp.appendFile(oplogFile(root), "{broken json\n", "utf8");
    await appendOplog(fs, root, "adopt", "待确认/第2章-v2-候选.md", "sess-2");

    const entries = await readOplog(fs, root);
    expect(entries).toHaveLength(3);
    expect(entries[0].action).toBe("open");
    expect(entries[0].relPath).toBe("章节内容/第1章.md"); // 统一 '/' 分隔
    expect(entries[1].detail).toEqual({ changedChars: 42, digitsChanged: true, reflowTriggered: true });
    expect(entries[2].action).toBe("adopt");
    // 每行一条 JSON：3 条有效 + 1 条损坏 = 4 行（append-only，损坏行不被清理）
    const raw = await fsp.readFile(oplogFile(root), "utf8");
    expect(raw.trim().split("\n").length).toBe(4);
  });

  it("文件缺失 → 空数组（不抛错）", async () => {
    expect(await readOplog(fs, path.join(root, "不存在的作品"))).toEqual([]);
  });

  it("limit 只取最近 N 条", async () => {
    const recent = await readOplog(fs, root, 2);
    expect(recent).toHaveLength(2);
    expect(recent[1].action).toBe("adopt");
  });
});
