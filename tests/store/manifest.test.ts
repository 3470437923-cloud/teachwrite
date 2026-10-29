/**
 * 作品清单：用实测样本做回归锁。
 * 样本逐字取自 C:\Users\Administrator\AI写小说\测试书籍\.openwrite_manifest.json
 */
import { describe, expect, it } from "vitest";
import {
  basenameRel,
  emptyManifest,
  findByPhysicalPath,
  legacyRef,
  orderFor,
  parentRel,
  parseManifest,
  removeItem,
  renameItem,
  serializeManifest,
  upsertItem,
  type ProjectManifest,
} from "../../src/core/store/manifest";
import { __setSubMsSource } from "../../src/core/ids";

const REAL_SAMPLE =
  '{"version":1,"updatedAt":"2026-09-27T22:00:35.918741","items":{"item_1790517635918741_g2mpat":{"id":"item_1790517635918741_g2mpat","kind":"file","physicalPath":"章节内容/1.md","displayName":"1.md","createdAt":"2026-09-27T22:00:35.918741","updatedAt":"2026-09-27T22:00:35.918741"}},"orders":{"章节内容":["legacy:章节内容/1.md","item_1790517635918741_g2mpat"]},"manualOrderParents":[]}';

describe("manifest 解析（实测样本）", () => {
  it("逐字段还原实测样本结构", () => {
    const m = parseManifest(REAL_SAMPLE);
    expect(m.version).toBe(1);
    expect(m.updatedAt).toBe("2026-09-27T22:00:35.918741");
    expect(Object.keys(m.items)).toEqual(["item_1790517635918741_g2mpat"]);
    const it0 = m.items["item_1790517635918741_g2mpat"];
    expect(it0.kind).toBe("file");
    expect(it0.physicalPath).toBe("章节内容/1.md");
    expect(it0.displayName).toBe("1.md");
    expect(it0.createdAt).toBe("2026-09-27T22:00:35.918741");
    expect(m.orders["章节内容"]).toEqual([
      "legacy:章节内容/1.md",
      "item_1790517635918741_g2mpat",
    ]);
    expect(m.manualOrderParents).toEqual([]);
  });

  it("空内容按空清单处理，不抛异常", () => {
    const m = parseManifest("");
    expect(m.items).toEqual({});
    expect(m.orders).toEqual({});
    expect(m.version).toBe(1);
  });

  it("序列化后能被原样解析（往返）", () => {
    const m = parseManifest(REAL_SAMPLE);
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });
});

describe("manifest 条目操作", () => {
  it("upsert 新条目：写入 items 并把 legacy 引用替换为 item 引用", () => {
    const m = emptyManifest();
    const { manifest, item } = upsertItem(m, { physicalPath: "章节内容/第1章.md" });
    expect(item.id).toMatch(/^item_\d+_[a-z0-9]{6}$/);
    expect(item.displayName).toBe("第1章.md");
    expect(item.kind).toBe("file");
    expect(manifest.items[item.id]).toEqual(item);
    expect(orderFor(manifest, "章节内容")).toEqual([item.id]);
    expect(orderFor(manifest, "")).toEqual([]);
  });

  it("同一物理路径再次 upsert 复用原 id，不产生重复条目", () => {
    const m1 = emptyManifest();
    const a = upsertItem(m1, { physicalPath: "章节内容/第1章.md" });
    const b = upsertItem(a.manifest, { physicalPath: "章节内容/第1章.md" });
    expect(b.item.id).toBe(a.item.id);
    expect(Object.keys(b.manifest.items)).toHaveLength(1);
    expect(orderFor(b.manifest, "章节内容")).toEqual([a.item.id]);
  });

  it("再次 upsert 已有条目不挪动 order 位置（显示顺序回归锁）", () => {
    // 修复前：每次 upsert 都把条目挤到 order 末尾，用户手动排序会被保存动作打乱
    const a = upsertItem(emptyManifest(), { physicalPath: "章节内容/第1章.md" });
    const b = upsertItem(a.manifest, { physicalPath: "章节内容/第2章.md" });
    const c = upsertItem(b.manifest, { physicalPath: "章节内容/第3章.md" });
    const d = upsertItem(c.manifest, { physicalPath: "章节内容/第1章.md" }); // 重新保存第1章
    expect(orderFor(d.manifest, "章节内容")).toEqual([a.item.id, b.item.id, c.item.id]);
  });

  it("legacy 引用原位替换为条目 id，不挪位置", () => {
    const m: ProjectManifest = {
      ...emptyManifest(),
      orders: { "章节内容": ["legacy:章节内容/第1章.md", "legacy:章节内容/第2章.md"] },
    };
    const { manifest, item } = upsertItem(m, { physicalPath: "章节内容/第1章.md" });
    expect(orderFor(manifest, "章节内容")).toEqual([item.id, "legacy:章节内容/第2章.md"]);
  });

  it("removeItem 同步清掉条目 id 与同路径 legacy 引用（幽灵引用回归锁）", () => {
    const { manifest, item } = upsertItem(emptyManifest(), { physicalPath: "章节内容/第1章.md" });
    expect(removeItem(manifest, item.id).items[item.id]).toBeUndefined();
    expect(orderFor(removeItem(manifest, item.id), "章节内容")).toEqual([]);
    // order 里同时残留 legacy 引用与条目 id 时，两个都被清掉
    const withLegacy: ProjectManifest = {
      ...manifest,
      orders: { "章节内容": ["legacy:章节内容/第1章.md", item.id] },
    };
    expect(orderFor(removeItem(withLegacy, item.id), "章节内容")).toEqual([]);
    // 不存在的 id：幂等原样返回
    expect(removeItem(manifest, "item_不存在")).toBe(manifest);
  });

  it("rename 只改 displayName，物理路径不动（格式优先的前提）", () => {
    const a = upsertItem(emptyManifest(), { physicalPath: "章节内容/第1章.md" });
    const m2 = renameItem(a.manifest, a.item.id, "第一章 启程");
    expect(m2.items[a.item.id].displayName).toBe("第一章 启程");
    expect(m2.items[a.item.id].physicalPath).toBe("章节内容/第1章.md");
  });

  it("legacy 引用格式逐字为 legacy:<物理路径>", () => {
    expect(legacyRef("章节内容/1.md")).toBe("legacy:章节内容/1.md");
  });

  it("路径工具：parentRel / basenameRel 同时接受 / 与 \\", () => {
    expect(parentRel("章节内容/1.md")).toBe("章节内容");
    expect(parentRel("章节内容\\1.md")).toBe("章节内容");
    expect(parentRel("1.md")).toBe("");
    expect(basenameRel("小说资料/世界观.md")).toBe("世界观.md");
  });

  it("findByPhysicalPath 命中且仅命中一条", () => {
    const a = upsertItem(emptyManifest(), { physicalPath: "小说资料/世界观.md" });
    expect(findByPhysicalPath(a.manifest, "小说资料/世界观.md")?.id).toBe(a.item.id);
    expect(findByPhysicalPath(a.manifest, "小说资料/人物库.md")).toBeNull();
  });
});

describe("ID 与时间戳格式（保持既有格式）", () => {
  it("isoMicros 输出 6 位微秒的本地时间串", () => {
    __setSubMsSource(() => 741);
    const m = emptyManifest(new Date(2026, 8, 27, 22, 0, 35, 918));
    expect(m.updatedAt).toBe("2026-09-27T22:00:35.918741");
  });

  it("item id 形如 item_<微秒>_<6位字母数字>", () => {
    __setSubMsSource(() => 0);
    const d = new Date(2026, 0, 1, 0, 0, 0, 0);
    const micros = (BigInt(d.getTime()) * 1000n + 500n).toString();
    const { item } = upsertItem(emptyManifest(), { physicalPath: "a.md" }, d);
    // rand=0.5 → 亚毫秒 500；6 位后缀取 ALNUM[18]="s"
    expect(item.id).toMatch(/^item_\d{16}_[a-z0-9]{6}$/);
    expect(item.id.startsWith("item_" + micros.slice(0, 13))).toBe(true);
  });
});
