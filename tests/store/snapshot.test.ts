/**
 * 写前快照回归测试：一会话一文件、条目追加、previousType 推导、损坏容错、回滚定位。
 * 目录名 writerd_snapshots 是磁盘契约，测试中出现的路径保持原样。
 */
import { describe, expect, it } from "vitest";
import type { FsBridge } from "../../src/core/fsbridge";
import { __setSubMsSource } from "../../src/core/ids";
// 快照文件名的期望值用被测代码自己的 join 构造（Windows '\'、macOS '/'），
// 验证的仍是同一条语义：<snapshotsDir>/<sessionId>.json
import { join } from "../../src/core/dirs";
import {
  contentHash,
  emptySnapshots,
  lastForPath,
  loadSnapshots,
  parseSnapshots,
  recordSnapshot,
  serializeSnapshots,
  snapshotFile,
  type RecordInput,
} from "../../src/core/store/snapshot";

// 固定亚毫秒来源，使 isoMicros 输出可确定（与 manifest.test.ts 同一套路）
__setSubMsSource(() => 527);

/** 内存版 fs 桥（只实现本组测试用到的原语） */
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
    __files: files,
  } as unknown as FsBridge;
}

function filesOf(fs: FsBridge): Record<string, string> {
  return (fs as unknown as { __files: Record<string, string> }).__files;
}

const DIR = "X:\\writerd_snapshots";
const NOW = new Date(2026, 6, 5, 12, 55, 23, 302);

/** 一条最小合法的记录输入（调用方按需覆盖字段） */
function input(over: Partial<RecordInput> = {}): RecordInput {
  return {
    sessionId: "0114dbe9-0000-4000-8000-000000000000",
    callId: "call_00_test",
    operation: "write",
    relativePath: "章节内容/第37章.md",
    previousContent: null,
    previousExists: false,
    ...over,
  };
}

describe("路径与哈希", () => {
  it("snapshotFile：<snapshotsDir>/<sessionId>.json（一会话一文件，uuid 保证唯一）", () => {
    expect(snapshotFile(DIR, "abc-123")).toBe(join(DIR, "abc-123.json"));
  });

  it("contentHash：sha256 小写 hex（标准向量 'abc'）", async () => {
    expect(await contentHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("recordSnapshot", () => {
  it("首条记录：建文件、字段齐全、previousType 按 previousExists 推导为 none", async () => {
    const fs = memFs();
    const next = await recordSnapshot(fs, DIR, input(), NOW);
    expect(next.snapshots).toHaveLength(1);

    const raw = filesOf(fs)[snapshotFile(DIR, next.sessionId)];
    expect(raw).toBeDefined(); // writeText 契约负责建父目录，这里直接落盘成功
    const e = JSON.parse(raw).snapshots[0];
    expect(e.operation).toBe("write");
    expect(e.relativePath).toBe("章节内容/第37章.md");
    expect(e.previousContent).toBeNull(); // 目标原本不存在：previousContent 必须是 null
    expect(e.previousExists).toBe(false);
    expect(e.previousType).toBe("none");
    expect(e.renameNewPath).toBeNull();
    expect(e.createdPaths).toBeNull();
    expect(e.timestamp).toBe("2026-07-05T12:55:23.302527"); // isoMicros：本地时间 6 位微秒
    expect(e.snapshotId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("previousExists=true 且未显式给 previousType 时推导为 file", async () => {
    const fs = memFs();
    const next = await recordSnapshot(
      fs,
      DIR,
      input({ previousContent: "旧文", previousExists: true }),
      NOW,
    );
    expect(next.snapshots[0].previousType).toBe("file");
    expect(next.snapshots[0].previousContent).toBe("旧文");
  });

  it("同一会话追加进同一文件；不同会话各自建文件", async () => {
    const fs = memFs();
    await recordSnapshot(fs, DIR, input(), NOW);
    const next = await recordSnapshot(fs, DIR, input({ callId: "call_01" }), NOW);
    expect(next.snapshots).toHaveLength(2); // 读旧→追加→写回
    expect(next.snapshots.map((s) => s.callId)).toEqual(["call_00_test", "call_01"]);

    await recordSnapshot(fs, DIR, input({ sessionId: "另一个会话" }), NOW);
    expect(filesOf(fs)[snapshotFile(DIR, "另一个会话")]).toBeDefined();
    // 重新读回原会话文件：仍只有自己的 2 条，未被另一会话污染
    const reloaded = await loadSnapshots(fs, DIR, input().sessionId);
    expect(reloaded.snapshots).toHaveLength(2);
  });
});

describe("loadSnapshots / parseSnapshots 容错", () => {
  it("文件缺失 → 空容器", async () => {
    expect(await loadSnapshots(memFs(), DIR, "无此会话")).toEqual(emptySnapshots("无此会话"));
  });

  it("损坏 JSON → 空容器（不抛错、不阻断写作）", async () => {
    const fs = memFs({ [snapshotFile(DIR, "s1")]: "{broken" });
    expect(await loadSnapshots(fs, DIR, "s1")).toEqual(emptySnapshots("s1"));
  });

  it("文件内 sessionId 优先；缺失时用入参兜底；snapshots 非数组按空处理", () => {
    expect(parseSnapshots("", "入参id").sessionId).toBe("入参id");
    expect(parseSnapshots(JSON.stringify({ snapshots: [] }), "入参id").sessionId).toBe("入参id");
    const withId = parseSnapshots(JSON.stringify({ sessionId: "文件id", snapshots: "不是数组" }), "入参id");
    expect(withId.sessionId).toBe("文件id");
    expect(withId.snapshots).toEqual([]);
  });

  it("serializeSnapshots 单行 JSON 且可往返", async () => {
    const fs = memFs();
    const next = await recordSnapshot(fs, DIR, input(), NOW);
    expect(serializeSnapshots(next)).not.toContain("\n");
    expect(parseSnapshots(serializeSnapshots(next), next.sessionId)).toEqual(next);
  });
});

describe("lastForPath（回滚定位）", () => {
  it("倒序找最近一条；未记录过的路径返回 null", async () => {
    const fs = memFs();
    await recordSnapshot(fs, DIR, input({ callId: "c0" }), NOW);
    await recordSnapshot(fs, DIR, input({ callId: "c1", relativePath: "章节内容/第38章.md" }), NOW);
    await recordSnapshot(fs, DIR, input({ callId: "c2" }), NOW);
    const all = await loadSnapshots(fs, DIR, input().sessionId);
    expect(lastForPath(all, "章节内容/第37章.md")?.callId).toBe("c2"); // 取最近而非最早
    expect(lastForPath(all, "章节内容/第38章.md")?.callId).toBe("c1");
    expect(lastForPath(all, "章节内容/第99章.md")).toBeNull();
  });
});
