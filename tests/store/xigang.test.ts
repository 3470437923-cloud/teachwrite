/** 细纲栏目（D-043）的回归锁：文件名契约、状态读取、起草读取集。 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeFs } from "../support/nodeFs";
import { listXigang, parseXigangName, xigangFileName, xigangReadSet, xigangStatusOf } from "../../src/core/store/xigang";

const fs = createNodeFs();
let root: string;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "deepcompose-xigang-"));
});
afterAll(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

describe("parseXigangName / xigangFileName", () => {
  it("标准形态与完成态", () => {
    expect(parseXigangName("第1-3章细纲.md")).toEqual({ from: 1, to: 3, done: false });
    expect(parseXigangName("第41-43章细纲（已完成）.md")).toEqual({ from: 41, to: 43, done: true });
    expect(parseXigangName("第41-43章细纲（已完成）")).toEqual({ from: 41, to: 43, done: true }); // 不带扩展名也认
  });

  it("全角数字、中文数字、不同连接符", () => {
    expect(parseXigangName("第４１－４３章细纲.md")).toBeNull(); // 全角「－」（U+FF0D）不在连接符集合
    expect(parseXigangName("第４１-４３章细纲.md")).toEqual({ from: 41, to: 43, done: false }); // 全角数字可
    expect(parseXigangName("第四十一-四十三章细纲.md")).toEqual({ from: 41, to: 43, done: false });
    expect(parseXigangName("第41–43章细纲.md")).toEqual({ from: 41, to: 43, done: false }); // en dash
  });

  it("非细纲名与非法区间返回 null", () => {
    expect(parseXigangName("第41章细纲.md")).toBeNull(); // 单章不算区间
    expect(parseXigangName("第43-41章细纲.md")).toBeNull(); // 倒置区间
    expect(parseXigangName("细纲.md")).toBeNull();
    expect(parseXigangName("第41-43章.md")).toBeNull();
  });

  it("与 xigangFileName 互逆", () => {
    expect(parseXigangName(xigangFileName(7, 9))).toEqual({ from: 7, to: 9, done: false });
    expect(parseXigangName(xigangFileName(7, 9, true))).toEqual({ from: 7, to: 9, done: true });
  });
});

describe("xigangStatusOf", () => {
  it("读头部 - 状态： 字段；没有为 null", () => {
    expect(xigangStatusOf("# 第1-3章细纲\n- 状态：进行中（进行中、未启动、已完成）\n\n## 第1章\n")).toBe("进行中（进行中、未启动、已完成）");
    expect(xigangStatusOf("# 第1-3章细纲\n\n## 第1章\n")).toBeNull();
    expect(xigangStatusOf("")).toBeNull();
  });
});

describe("listXigang / xigangReadSet", () => {
  it("按首章号排序，非细纲文件跳过；读取集 = 当前 + 上一段已完成", async () => {
    const dir = path.join(root, "书", "小说资料", "细纲");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "第7-9章细纲.md"), "七", "utf8");
    await fsp.writeFile(path.join(dir, "第1-3章细纲（已完成）.md"), "一", "utf8");
    await fsp.writeFile(path.join(dir, "第4-6章细纲（已完成）.md"), "四", "utf8");
    await fsp.writeFile(path.join(dir, "笔记.md"), "跳过", "utf8"); // 非细纲命名

    const list = await listXigang(fs, path.join(root, "书"));
    expect(list.map((x) => x.name)).toEqual(["第1-3章细纲（已完成）.md", "第4-6章细纲（已完成）.md", "第7-9章细纲.md"]);
    expect(list.map((x) => x.done)).toEqual([true, true, false]);

    // 起草第 8 章：当前 = 第7-9章细纲，上一段 = 第4-6章细纲（已完成）
    const rs = xigangReadSet(list, 8);
    expect(rs.current?.name).toBe("第7-9章细纲.md");
    expect(rs.prior?.name).toBe("第4-6章细纲（已完成）.md");

    // 起草第 2 章（老内容）：当前为 null（覆盖区间是已完成态），上一段为 null
    const old = xigangReadSet(list, 2);
    expect(old.current).toBeNull();
    expect(old.prior).toBeNull();

    // 目录不存在 → 空数组（不抛错）
    expect(await listXigang(fs, path.join(root, "不存在"))).toEqual([]);
  });
});
