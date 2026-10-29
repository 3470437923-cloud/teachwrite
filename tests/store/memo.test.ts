/**
 * 备忘录 store 回归锁：格式保持既有 writerd_memos.json 实测结构
 * （文件名是磁盘契约，测试中的 X:\writerd_memos.json 等路径保持原样）。
 */
import { describe, expect, it } from "vitest";
import {
  addCategory,
  DEFAULT_CATEGORY,
  emptyMemoFile,
  loadMemos,
  newMemo,
  removeCategory,
  type MemoFile,
} from "../../src/core/store/memo";
import type { FsBridge } from "../../src/core/fsbridge";

/** 内存版 fs 桥（与 store 其它测试同一套路） */
function memFs(files: Record<string, string> = {}): FsBridge {
  return {
    async exists(p: string) {
      return p in files;
    },
    async readText(p: string) {
      if (!(p in files)) throw new Error("not found: " + p);
      return files[p];
    },
    async writeText(p: string, content: string) {
      files[p] = content;
    },
    async list() {
      return [];
    },
    async mkdir() {},
    async delete() {},
    async rename() {},
  } as unknown as FsBridge;
}

const REAL_SAMPLE = JSON.stringify({
  categories: ["默认", "灵感", "大纲"],
  memos: [
    {
      id: "1779819137257",
      title: "无标题",
      content: "第一步…第二步…",
      category: "默认",
      created_at: "2026-05-27T02:12:17.257787",
      updated_at: "2026-05-28T22:07:48.247679",
      project_id: "C:\\Users\\Administrator\\AI写小说\\烂，也要烂在你怀里",
    },
  ],
});

describe("memo store", () => {
  it("文件不存在 → 空结构（默认分类）", async () => {
    const fs = memFs();
    const data = await loadMemos(fs, "X:\\writerd_memos.json");
    expect(data).toEqual({ categories: ["默认"], memos: [] });
  });

  it("实测样例 → 原样解析出 categories 与 memos 字段", async () => {
    const fs = memFs({ "X:\\writerd_memos.json": REAL_SAMPLE });
    const data = await loadMemos(fs, "X:\\writerd_memos.json");
    expect(data.categories).toEqual(["默认", "灵感", "大纲"]);
    expect(data.memos).toHaveLength(1);
    expect(data.memos[0].id).toBe("1779819137257");
    expect(data.memos[0].category).toBe("默认");
    expect(data.memos[0].project_id).toContain("AI写小说");
  });

  it("带 BOM 的文件也能读（PowerShell 写入容错）", async () => {
    const fs = memFs({ "X:\\m.json": "\uFEFF" + REAL_SAMPLE });
    const data = await loadMemos(fs, "X:\\m.json");
    expect(data.memos).toHaveLength(1);
  });

  it("newMemo：id=毫秒串、title=无标题、category=默认、ISO 微秒时间", () => {
    const m = newMemo("C:\\books\\a", new Date(2026, 8, 28, 2, 30, 0, 123));
    expect(m.id).toBe(String(new Date(2026, 8, 28, 2, 30, 0, 123).getTime()));
    expect(m.title).toBe("无标题");
    expect(m.category).toBe(DEFAULT_CATEGORY);
    expect(m.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(m.project_id).toBe("C:\\books\\a");
  });

  it("分类增删：默认不可删、重复不加", () => {
    let d: MemoFile = emptyMemoFile();
    d = addCategory(d, "灵感");
    d = addCategory(d, "灵感");
    expect(d.categories).toEqual(["默认", "灵感"]);
    d = removeCategory(d, DEFAULT_CATEGORY);
    expect(d.categories).toContain("默认");
    d = removeCategory(d, "灵感");
    expect(d.categories).toEqual(["默认"]);
  });

  it("删分类时该分类下的备忘录迁移到默认（KL-ST-09：不留点不到的孤儿）", () => {
    let d: MemoFile = emptyMemoFile();
    d = addCategory(d, "灵感");
    d = { ...d, memos: [newMemo("p1"), newMemo("p1")] };
    d = { ...d, memos: d.memos.map((m) => ({ ...m, category: "灵感" })) };
    const after = removeCategory(d, "灵感");
    expect(after.categories).toEqual([DEFAULT_CATEGORY]);
    // 条目还在（不删数据），只是换到默认分类
    expect(after.memos.length).toBe(2);
    expect(after.memos.every((m) => m.category === DEFAULT_CATEGORY)).toBe(true);
  });

  it("删不存在的分类 → 原样返回（幂等，且不动任何条目）", () => {
    let d: MemoFile = emptyMemoFile();
    d = { ...d, memos: [newMemo("p1")] };
    const after = removeCategory(d, "没有这个分类");
    expect(after).toBe(d);
  });
});
