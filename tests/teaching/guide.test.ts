import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "../../src/core/dirs";
import { createNodeFs } from "../support/nodeFs";
import { completeGuideStep, loadGuide, parseGuideResponse, reopenGuideStep, saveGuide, type ChapterGuide, type GuideStep } from "../../src/core/teaching/guide";

const step = (): GuideStep => ({ title: "雨夜相遇", goal: "建立人物矛盾", actions: ["让主角主动询问来意"], facts: ["两人此前未见"], turn: "来客认出了信物", transition: "把疑问带到下一场", completion: "读者知道来客有所隐瞒" });
const guide = (): ChapterGuide => ({ schemaVersion: 1, id: "guide-1", chapter: 2, version: 1, createdAt: "2026-10-12T00:00:00.000Z", steps: [step(), { ...step(), title: "追问信物" }, { ...step(), title: "离开院子" }], completed: [] });
const response = (steps: unknown = [step()]) => JSON.stringify({ steps });

describe("strict AI guide schema", () => {
  it("accepts only the fixed steps envelope and copies valid fields", () => {
    expect(parseGuideResponse(response())).toEqual([step()]);
  });
  it.each(["", "not json", "[]", "null", "{}", response([]), response(Array.from({ length: 31 }, step)), JSON.stringify({ steps: [step()], body: "正文" }), "\u0011", "\u0000"])("rejects invalid response %s instead of returning empty steps", text => {
    expect(() => parseGuideResponse(text)).toThrow();
  });
  it("rejects markdown fences and commentary around JSON", () => {
    expect(() => parseGuideResponse("\u0000" + response())).toThrow();
    expect(() => parseGuideResponse("\u0000".replace("\u0000", "正文") + response())).toThrow();
    expect(() => parseGuideResponse("~~~json\n" + response() + "\n~~~")).toThrow();
  });
  it.each(["title", "goal", "actions", "facts", "turn", "transition", "completion"])("rejects missing %s", field => {
    const raw: Record<string, unknown> = { ...step() }; delete raw[field];
    expect(() => parseGuideResponse(response([raw]))).toThrow(field);
  });
  it("rejects unknown step fields and non-string values", () => {
    expect(() => parseGuideResponse(response([{ ...step(), prose: "AI正文" }]))).toThrow();
    expect(() => parseGuideResponse(response([{ ...step(), title: 12 }]))).toThrow("title");
    expect(() => parseGuideResponse(response([{ ...step(), actions: "行动" }]))).toThrow("actions");
    expect(() => parseGuideResponse(response([{ ...step(), facts: [null] }]))).toThrow("facts");
  });
  it.each(["title", "goal", "turn", "transition", "completion"])("bounds string field %s", field => {
    expect(() => parseGuideResponse(response([{ ...step(), [field]: " " }]))).toThrow(field);
    expect(() => parseGuideResponse(response([{ ...step(), [field]: "字".repeat(2001) }]))).toThrow(field);
  });
  it("accepts the exact maximum string lengths and rejects one character beyond", () => {
    const boundary = { ...step(), title: "字".repeat(120), goal: "字".repeat(2000), turn: "字".repeat(2000), transition: "字".repeat(2000), completion: "字".repeat(2000), actions: ["字".repeat(1000)], facts: ["字".repeat(1000)] };
    expect(parseGuideResponse(response([boundary]))).toEqual([boundary]);
    expect(() => parseGuideResponse(response([{ ...boundary, title: "字".repeat(121) }]))).toThrow("title");
  });
  it("bounds lists and their strings and accepts thirty steps", () => {
    for (const [field, value] of [["actions", []], ["actions", Array(13).fill("行动")], ["facts", Array(21).fill("事实")], ["actions", [" "]], ["facts", ["字".repeat(1001)]]] as const)
      expect(() => parseGuideResponse(response([{ ...step(), [field]: value }]))).toThrow(field);
    expect(parseGuideResponse(response(Array.from({ length: 30 }, step)))).toHaveLength(30);
    expect(parseGuideResponse(response([{ ...step(), facts: [] }]))[0].facts).toEqual([]);
  });
});

describe("manual guide progress", () => {
  it("completes only next pending step without changing input", () => {
    const initial = guide(); const first = completeGuideStep(initial, 0);
    expect(first.completed).toEqual([0]); expect(initial.completed).toEqual([]);
    expect(() => completeGuideStep(initial, 1)).toThrow();
    expect(() => completeGuideStep(first, 0)).toThrow();
    expect(completeGuideStep(first, 1).completed).toEqual([0, 1]);
  });
  it("reopening cancels that step and every following completion", () => {
    const done = { ...guide(), completed: [0, 1, 2] };
    expect(reopenGuideStep(done, 1).completed).toEqual([0]);
    expect(done.completed).toEqual([0, 1, 2]);
    expect(reopenGuideStep(done, 0).completed).toEqual([]);
  });
  it.each([-1, 3, 0.5, NaN])("rejects invalid index %s", index => {
    expect(() => completeGuideStep(guide(), index)).toThrow();
    expect(() => reopenGuideStep(guide(), index)).toThrow();
  });
  it("rejects noncontiguous or duplicate progress", () => {
    for (const completed of [[1], [0, 0], [0, 2], [-1], [0, 1, 2, 3]])
      expect(() => completeGuideStep({ ...guide(), completed }, 0)).toThrow("completed");
  });
});

describe("guide Markdown persistence", () => {
  let root: string; const fs = createNodeFs();
  const current = () => join(root, "小说资料", "写作导览", "第2章-导览.md");
  const historyDir = () => join(root, "小说资料", "写作导览", ".history");
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "teachwrite-guide-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("returns null only for a missing guide and round-trips Markdown with manual progress", async () => {
    expect(await loadGuide(fs, root, 2)).toBeNull();
    const next = completeGuideStep(guide(), 0); await saveGuide(fs, root, next);
    const md = await fs.readText(current());
    for (const text of ["第2章", "雨夜相遇", "建立人物矛盾", "让主角主动询问来意", "两人此前未见", "来客认出了信物", "把疑问带到下一场", "读者知道来客有所隐瞒", "[x]", "[ ]"]) expect(md).toContain(text);
    expect(await loadGuide(fs, root, 2)).toEqual(next);
    expect(await fs.exists(join(root, "章节内容"))).toBe(false);
  });
  it("preserves each overwritten revision uniquely, including progress, in the same millisecond", async () => {
    const first = guide(); await saveGuide(fs, root, first);
    const original = await fs.readText(current());
    const advanced = completeGuideStep(first, 0); await saveGuide(fs, root, advanced);
    const progress = await fs.readText(current());
    const second = { ...guide(), version: 2, steps: [{ ...step(), title: "新导览" }] };
    await saveGuide(fs, root, second);
    const history = await fs.list(historyDir());
    expect(history).toHaveLength(2);
    expect(new Set(history.map(e => e.name)).size).toBe(2);
    expect(await Promise.all(history.map(e => fs.readText(e.path)))).toEqual(expect.arrayContaining([original, progress]));
    expect(await loadGuide(fs, root, 2)).toEqual(second);
    await saveGuide(fs, root, second);
    expect(await fs.list(historyDir())).toHaveLength(2);
  });
  it("serializes concurrent saves so prior progress is not lost from history", async () => {
    const first = guide(); await saveGuide(fs, root, first);
    const one = completeGuideStep(first, 0); const two = completeGuideStep(one, 1);
    await Promise.all([saveGuide(fs, root, one), saveGuide(fs, root, two)]);
    expect(await loadGuide(fs, root, 2)).toEqual(two);
    expect(await fs.list(historyDir())).toHaveLength(2);
  });
  it("does not overwrite if writing the prior revision fails", async () => {
    await saveGuide(fs, root, guide()); const original = await fs.readText(current());
    const failingFs = { ...fs, writeText: async (path: string, text: string) => {
      if (path !== current()) throw new Error("snapshot failed"); await fs.writeText(path, text);
    } };
    await expect(saveGuide(failingFs, root, completeGuideStep(guide(), 0))).rejects.toThrow("snapshot failed");
    expect(await fs.readText(current())).toBe(original);
  });
  it.each(["", "# 人工导览\n", "<!-- teachwrite-guide:v1\n{}\n-->", "<!-- teachwrite-guide:v1\nnull\n-->"])("reports corrupt stored data explicitly", async text => {
    await fs.writeText(current(), text);
    await expect(loadGuide(fs, root, 2)).rejects.toThrow();
    await expect(saveGuide(fs, root, guide())).rejects.toThrow();
    expect(await fs.readText(current())).toBe(text);
  });
  it("refuses to silently overwrite manual edits to readable guidance", async () => {
    await saveGuide(fs, root, guide());
    const edited = (await fs.readText(current())).replace("目标：建立人物矛盾", "目标：作者自己的修改");
    await fs.writeText(current(), edited);
    await expect(loadGuide(fs, root, 2)).rejects.toThrow("metadata");
    await expect(saveGuide(fs, root, completeGuideStep(guide(), 0))).rejects.toThrow("metadata");
    expect(await fs.readText(current())).toBe(edited);
  });
  it("rejects corrupted machine steps and unsupported schema without empty fallback", async () => {
    await saveGuide(fs, root, guide());
    const original = await fs.readText(current());
    for (const edit of [original.replace('"schemaVersion":1', '"schemaVersion":2'), original.replace('"completed":[]', '"completed":[1]'), original.replace('"steps":[{', '"steps":[null,{')]) {
      await fs.writeText(current(), edit);
      await expect(loadGuide(fs, root, 2)).rejects.toThrow();
    }
  });
  it("rejects mismatched chapter and surfaces read errors", async () => {
    await saveGuide(fs, root, guide());
    await fs.copy(current(), join(root, "小说资料", "写作导览", "第3章-导览.md"));
    await expect(loadGuide(fs, root, 3)).rejects.toThrow("chapter");
    await expect(loadGuide({ ...fs, readText: async () => { throw new Error("permission denied"); } }, root, 2)).rejects.toThrow("permission denied");
  });
  it("rejects sparse in-memory arrays rather than persisting null holes", async () => {
    for (const patch of [{ steps: new Array(1) }, { steps: [{ ...step(), actions: new Array(1) }] }, { steps: [{ ...step(), facts: new Array(1) }] }, { completed: new Array(1) }])
      await expect(saveGuide(fs, root, { ...guide(), ...patch })).rejects.toThrow();
    expect(await fs.list(root)).toEqual([]);
  });
  it("rejects invalid metadata before any write", async () => {
    for (const patch of [{ schemaVersion: 2 }, { id: "" }, { id: "../escape" }, { chapter: 0 }, { chapter: 1.5 }, { version: 0 }, { createdAt: "yesterday" }, { steps: [] }, { completed: [1] }])
      await expect(saveGuide(fs, root, { ...guide(), ...patch } as ChapterGuide)).rejects.toThrow();
    expect(await fs.list(root)).toEqual([]);
  });
  it("refuses stale versions and same-version content changes", async () => {
    await saveGuide(fs, root, guide());
    await expect(saveGuide(fs, root, { ...guide(), steps: [step()] })).rejects.toThrow("version");
    await saveGuide(fs, root, { ...guide(), version: 2 });
    await expect(saveGuide(fs, root, guide())).rejects.toThrow("version");
  });
  it("escapes metadata delimiters and renders all author guidance as text", async () => {
    const special = { ...guide(), steps: [{ ...step(), title: "字 <!-- --> <script> &", actions: ["<!-- teachwrite-guide:v1 -->"] }] };
    await saveGuide(fs, root, special);
    expect(await loadGuide(fs, root, 2)).toEqual(special);
    expect(await fs.readText(current())).not.toContain("<script>");
  });
});
