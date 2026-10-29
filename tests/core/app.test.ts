/**
 * 启动装配的单一入口（KL-TL-10）。
 * `boot()` 幂等：并发与重复调用共用同一次装配；失败可重试。
 * Tauri 的 invoke 在这里被打桩 —— 本文件只验装配次数与引用，不碰真实盘。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  fail: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string): Promise<unknown> => {
    h.calls.push(cmd);
    if (h.fail) throw new Error("磁盘没准备好");
    if (cmd === "app_dirs") {
      return {
        home: "C:\\Users\\t",
        documents: "C:\\Users\\t\\Documents",
        appData: "C:\\Users\\t\\AppData\\Roaming",
        prefsDir: "C:\\Users\\t\\AppData\\Roaming\\com.writerd\\writerD",
        prefsFile: "C:\\Users\\t\\AppData\\Roaming\\com.writerd\\writerD\\shared_preferences.json",
      };
    }
    if (cmd === "prefs_load") return "{}";
    return null;
  },
}));

function count(cmd: string): number {
  return h.calls.filter((c) => c === cmd).length;
}

beforeEach(() => {
  vi.resetModules(); // 每个用例一份全新的模块状态（bootPromise / booted）
  h.calls.length = 0;
  h.fail = false;
});

describe("boot() 的幂等性", () => {
  it("并发两次调用 → 只装配一次，且拿到同一个对象", async () => {
    const { boot } = await import("../../src/core/app");
    const [a, b] = await Promise.all([boot(), boot()]);
    expect(a).toBe(b);
    expect(count("app_dirs")).toBe(1);
    expect(count("prefs_load")).toBe(1);
    expect(count("fs_mkdir")).toBe(4); // 作品根 / 会话 / 快照 / 技能
  });

  it("启动后再调 → 直接复用，不再打任何 invoke", async () => {
    const { boot } = await import("../../src/core/app");
    const first = await boot();
    const before = h.calls.length;
    expect(await boot()).toBe(first);
    expect(h.calls.length).toBe(before);
  });

  it("currentBoot() 在首次启动前为 null，启动后是同一份", async () => {
    const app = await import("../../src/core/app");
    expect(app.currentBoot()).toBeNull();
    const b = await app.boot();
    expect(app.currentBoot()).toBe(b);
  });

  it("启动失败 → 抛出且不缓存失败态，下一次还能重试", async () => {
    h.fail = true;
    const { boot } = await import("../../src/core/app");
    await expect(boot()).rejects.toThrow(/磁盘没准备好/);
    h.fail = false;
    const b = await boot(); // 失败被清掉了，所以这里真的重试了一次
    expect(b.dirs.booksRoot).toBeTruthy();
    expect(count("app_dirs")).toBe(2); // 失败那次 1 次 + 重试那次 1 次
  });
});