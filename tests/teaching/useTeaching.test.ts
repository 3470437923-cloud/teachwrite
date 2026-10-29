import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterGuide } from "../../src/core/teaching/guide";
import type { TeachingTab } from "../../src/ui/useTeaching";

// 无 DOM 依赖的 hook 调度器：保留 state/ref、执行 effect 清理，手动控制异步完成顺序。
const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], guides: new Map<string, unknown>(),
  files: new Map<string, string>(), saveWait: null as Promise<void> | null,
  saves: vi.fn(), send: vi.fn(), isolated: vi.fn(), abort: vi.fn(), notify: vi.fn(), open: vi.fn(), ask: vi.fn(),
}));
vi.mock("react", () => {
  const equal = (a: unknown[] | undefined, b: unknown[]) => !!a && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  return {
    useState(initial: unknown) {
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = initial;
      return [h.slots[i], (next: unknown) => { h.slots[i] = typeof next === "function" ? (next as (old: unknown) => unknown)(h.slots[i]) : next; }];
    },
    useRef(initial: unknown) { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
    useMemo(factory: () => unknown, deps: unknown[]) {
      const i = h.cursor++; const old = h.slots[i] as { deps: unknown[]; value: unknown } | undefined;
      if (!old || !equal(old.deps, deps)) h.slots[i] = { deps, value: factory() };
      return (h.slots[i] as { value: unknown }).value;
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const i = h.cursor++; const old = h.slots[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
      if (!old || !equal(old.deps, deps)) {
        const slot = { deps, cleanup: old?.cleanup }; h.slots[i] = slot;
        h.effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; });
      }
    },
  };
});
vi.mock("../../src/core/app", () => ({ currentBoot: () => ({ dirs: {}, prefs: {} }) }));
vi.mock("../../src/core/ai/controller", () => ({ send: h.send, sendIsolated: h.isolated }));
vi.mock("../../src/core/ai/transport", () => ({ createTauriTransport: () => ({ abortActive: h.abort }) }));
vi.mock("../../src/core/fsbridge", () => ({ getFs: () => ({
  stat: async (path: string) => h.files.has(path) || [...h.files.keys()].some(file => file.startsWith(path + "/"))
    ? { isDir: !h.files.has(path), isLink: false, size: 1, mtimeMs: 0 } : null,
  exists: async (path: string) => h.files.has(path),
  readText: async (path: string) => { if (!h.files.has(path)) throw new Error("missing: " + path); return h.files.get(path)!; },
  writeText: async (path: string, value: string) => { h.files.set(path, value); },
  list: async (dir: string) => [...h.files.keys()].filter(path => path.startsWith(dir + "/") && !path.slice(dir.length + 1).includes("/"))
    .map(path => ({ name: path.slice(dir.length + 1), path, isDir: false, isLink: false })),
}) }));
vi.mock("../../src/core/teaching/guide", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/core/teaching/guide")>(),
  loadGuide: async (_fs: unknown, root: string, chapter: number) => h.guides.get(root + ":" + chapter) ?? null,
  saveGuide: async (_fs: unknown, root: string, guide: ChapterGuide) => { h.saves(root, guide); if (h.saveWait) await h.saveWait; h.guides.set(root + ":" + guide.chapter, guide); },
}));
import { useTeaching } from "../../src/ui/useTeaching";

const tab = (root: string, chapter: number, content = ""): TeachingTab => ({ name: "第" + chapter + "章.md", rel: "章节内容/第" + chapter + "章.md", path: root + "/章节内容/第" + chapter + "章.md", kind: "chapter", content });
const guide = (chapter: number): ChapterGuide => ({ schemaVersion: 1, id: "guide-" + chapter, chapter, version: 1, createdAt: "2026-10-14T00:00:00.000Z", completed: [], steps: [0, 1].map(index => ({ title: "章节" + chapter + "场景" + index, goal: "任务", actions: ["行动"], facts: [], turn: "转折", transition: "衔接", completion: "完成条件" })) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type Element = { type?: unknown; props?: { children?: unknown; [key: string]: unknown } };
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  const element = node as Element;
  return [element, ...elements(element.props?.children)];
}
function button(node: unknown, label: string) {
  const found = elements(node).find(element => element.type === "button" && element.props?.children === label);
  if (!found) throw new Error("missing button " + label);
  return found.props!.onClick as () => void;
}
function options(active: TeachingTab) {
  return { root: active.path.split("/章节内容/")[0], active, tabs: [active], busy: false, editor: { current: null },
    askQuestions: h.ask, acquire: () => true, release: vi.fn(), saveActive: async () => {}, openChapter: h.open, refresh: async () => {}, notify: h.notify };
}
function render(p: ReturnType<typeof options>) {
  h.cursor = 0; const result = useTeaching(p); const effects = h.effects.splice(0); effects.forEach(effect => effect()); return result;
}
async function settle(p: ReturnType<typeof options>) {
  for (let round = 0; round < 3; round++) { for (let i = 0; i < 50; i++) await Promise.resolve(); render(p); }
  return render(p);
}
beforeEach(() => {
  h.slots = []; h.cursor = 0; h.effects = []; h.guides.clear(); h.files.clear(); h.saveWait = null;
  for (const fn of [h.saves, h.send, h.isolated, h.abort, h.notify, h.open, h.ask]) fn.mockReset();
  h.send.mockResolvedValue({ session: { messages: [] }, truncated: false });
});

describe("教学hook异步作者控制", () => {
  it("勾选保存完成前切章，不得把旧章导览塞回当前章", async () => {
    const a = tab("/book", 1), b = tab("/book", 2);
    h.files.set(a.path, ""); h.files.set(b.path, ""); h.guides.set("/book:1", guide(1)); h.guides.set("/book:2", guide(2));
    const first = options(a); render(first); const shown = await settle(first);
    const wait = deferred<void>(); h.saveWait = wait.promise;
    const checkbox = elements(shown.overlay).find(element => element.type === "input")!;
    (checkbox.props!.onChange as () => void)();
    const second = { ...first, active: b, tabs: [a, b] }; render(second); await settle(second);
    wait.resolve(); const current = await settle(second);
    expect(elements(current.overlay).find(element => element.type === "h2")?.props?.children).toBe("章节2场景0");
    expect((h.guides.get("/book:1") as ChapterGuide).completed).toEqual([0]);
    expect((h.guides.get("/book:2") as ChapterGuide).completed).toEqual([]);
  });
  it("普通导览入口恢复已有版本和进度，不请求AI或重生成", async () => {
    const a = tab("/book", 1); h.files.set(a.path, "");
    const existing = { ...guide(1), completed: [0] }; h.guides.set("/book:1", existing);
    const p = options(a); render(p); const shown = await settle(p);
    button(shown.actions, "继续第1章导览")(); const restored = await settle(p);
    expect(h.open).toHaveBeenCalledWith(1); expect(h.isolated).not.toHaveBeenCalled(); expect(h.saves).not.toHaveBeenCalled();
    expect(elements(restored.overlay).find(element => element.type === "h2")?.props?.children).toBe("章节1场景1");
  });
  it("生成期间切换作品，结果可以保存在原作品但不能导航拉回", async () => {
    const a = tab("/a", 1), b = tab("/b", 1); h.files.set(a.path, ""); h.files.set(b.path, "");
    h.files.set("/a/小说资料/资料.md", "人物与开局资料");
    const result = deferred<unknown>(); h.isolated.mockReturnValue(result.promise);
    const first = options(a); render(first); const shown = await settle(first);
    button(shown.actions, "生成第1章导览")(); await settle(first);
    expect(h.isolated).toHaveBeenCalled();
    const second = options(b); render(second); await settle(second);
    result.resolve({ session: { messages: [{ role: "assistant", text: JSON.stringify({ steps: guide(1).steps }) }] }, truncated: false });
    const current = await settle(second);
    expect(h.open).not.toHaveBeenCalled(); expect(current.overlay).toBeNull();
    expect(h.guides.has("/a:1")).toBe(true); expect(h.guides.has("/b:1")).toBe(false);
  });
  it("审读期间切到另一作品同名章节，结果只保存原作品不污染当前UI", async () => {
    const a = tab("/a", 1, "作者原文"), b = tab("/b", 1, "另一部作品");
    h.files.set(a.path, a.content); h.files.set(b.path, b.content); h.files.set("/a/小说资料/资料.md", "人物资料");
    const result = deferred<unknown>(); h.isolated.mockReturnValue(result.promise);
    const first = options(a); render(first); const shown = await settle(first);
    button(shown.actions, "审读本章")(); await settle(first); expect(h.isolated).toHaveBeenCalled();
    const second = options(b); render(second); await settle(second);
    result.resolve({ session: { messages: [{ role: "assistant", text: "[]" }] }, truncated: false });
    const current = await settle(second);
    expect(current.review).toBeNull();
    expect([...h.files.keys()].some(path => path.startsWith("/a/小说资料/审核/审读/"))).toBe(true);
    expect([...h.files.keys()].some(path => path.startsWith("/b/小说资料/审核/审读/"))).toBe(false);
  });
  it("等待最终确认时停止，即便随后确认也不能写归档凭据", async () => {
    const a = tab("/book", 1, "作者正文"); h.files.set(a.path, a.content);
    const answer = deferred<string[][]>(); h.ask.mockReturnValue(answer.promise);
    const p = options(a); render(p); const shown = await settle(p);
    button(shown.actions, "资料回流与归档")(); const running = await settle(p);
    expect(h.ask).toHaveBeenCalled(); button(running.actions, "停止教学任务")();
    answer.resolve([["确认归档完成"]]); await settle(p);
    expect([...h.files.keys()].some(path => path.includes("归档.json"))).toBe(false);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("停止"));
  });
  it("正文回流工具失败，即使请求正常结束也不询问最终封存", async () => {
    const a = tab("/book", 1, "作者正文"); h.files.set(a.path, a.content);
    h.send.mockImplementation(async input => { input.onEvent({ type: "tool_completed", call: { result: JSON.stringify({ error: "作者未确认资料变更。" }) } }); return { session: { messages: [] }, truncated: false }; });
    const p = options(a); render(p); const shown = await settle(p);
    button(shown.actions, "资料回流与归档")(); await settle(p);
    expect(h.ask).not.toHaveBeenCalled();
    expect([...h.files.keys()].some(path => path.includes("归档.json"))).toBe(false);
  });
});
