/**
 * 会话存储回归测试：标题契约、解析容错、索引排序、并发写入串行化。
 * 目录名 writerd_sessions 是磁盘契约，测试中出现的路径保持原样。
 */
import { describe, expect, it } from "vitest";
import type { FsBridge, StatInfo } from "../../src/core/fsbridge";
import type { ChatMessage } from "../../src/core/ai/protocol";
import {
  TITLE_MAX,
  defaultTitle,
  deleteSession,
  emptyIndex,
  indexFile,
  listSessions,
  loadIndex,
  loadSession,
  newSession,
  parseIndex,
  parseSession,
  saveSession,
  sessionFile,
  titleFromText,
  type SessionIndex,
} from "../../src/core/store/session";

/** 内存版 fs 桥（只实现本组测试用到的原语；stat 返回固定 mtime 便于断言） */
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
    async remove(p: string) {
      delete files[p];
    },
    async stat(p: string): Promise<StatInfo | null> {
      if (!(p in files)) return null;
      return { isDir: false, isLink: false, size: files[p].length, mtimeMs: 1700000000000 };
    },
    __files: files,
  } as unknown as FsBridge;
}

/** 取内存桥背后的文件表（断言落盘形态用） */
function filesOf(fs: FsBridge): Record<string, string> {
  return (fs as unknown as { __files: Record<string, string> }).__files;
}

const DIR = "X:\\writerd_sessions";

/** 构造一条最小合法消息（字段形态与既有会话文件一致） */
let msgSeq = 0;
function msg(role: ChatMessage["role"], text: string): ChatMessage {
  return { id: `m-${++msgSeq}`, role, text, createdAt: "2026-05-21T16:58:00.000000" };
}

describe("标题契约", () => {
  it("defaultTitle 形如 New Chat - 2026-05-21T16:58（本地时间，分钟精度）", () => {
    expect(defaultTitle(new Date(2026, 4, 21, 16, 58, 30))).toBe("New Chat - 2026-05-21T16:58");
  });

  it("titleFromText：压缩空白、30 字截断补 ...", () => {
    expect(titleFromText("  第一章   起草 ")).toBe("第一章 起草");
    expect(titleFromText("")).toBe("");
    expect(titleFromText("   ")).toBe("");
    // 恰好 30 字不加省略号；31 字截到 30 再加
    const exact = "字".repeat(TITLE_MAX);
    expect(titleFromText(exact)).toBe(exact);
    expect(titleFromText(exact + "多")).toBe(exact + "...");
  });

  it("newSession：uuid 作 id、默认标题、空消息、创建即更新时间相同", () => {
    const s = newSession("X:\\books\\a", new Date(2026, 4, 21, 16, 58));
    expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(s.title).toBe("New Chat - 2026-05-21T16:58");
    expect(s.messages).toEqual([]);
    expect(s.createdAt).toBe(s.updatedAt);
  });
});

describe("解析容错", () => {
  it("parseSession：合法还原；损坏/缺关键字段 → null", () => {
    const s = newSession("P");
    s.messages = [msg("user", "你好")];
    expect(parseSession(JSON.stringify(s))).toEqual(s);
    expect(parseSession("{broken")).toBeNull();
    expect(parseSession(JSON.stringify({ id: "a" }))).toBeNull(); // 缺 messages
    expect(parseSession(JSON.stringify({ messages: [] }))).toBeNull(); // 缺 id
    // 字段级容错：title/projectPath 缺失取空串
    const partial = parseSession(JSON.stringify({ id: "a", messages: [] }))!;
    expect(partial.title).toBe("");
    expect(partial.projectPath).toBe("");
  });

  it("parseIndex：损坏 → 空索引；缺 sessions → 空映射", () => {
    expect(parseIndex("{broken")).toEqual(emptyIndex());
    expect(parseIndex(JSON.stringify({ version: 1 }))).toEqual(emptyIndex());
    const idx = parseIndex(JSON.stringify({ version: 1, sessions: { a: { title: "t" } } }));
    expect(Object.keys(idx.sessions)).toEqual(["a"]);
  });
});

describe("saveSession / loadSession / deleteSession", () => {
  it("保存后能原样读回；索引条目含 userMessageCount、字节 size、stat 的 mtimeMs", async () => {
    const fs = memFs();
    const s = newSession("P");
    s.title = titleFromText("帮我起草第一章，主角叫林晚，先写开场的一个具体事件");
    s.messages = [msg("user", "起草"), msg("assistant", "好的"), msg("user", "继续")];
    const index = await saveSession(fs, DIR, s);

    // 会话文件与索引都落了盘（路径按既有契约拼 writerd_sessions 目录）
    expect(filesOf(fs)[sessionFile(DIR, s.id)]).toBeDefined();
    expect(filesOf(fs)[indexFile(DIR)]).toBeDefined();

    const back = await loadSession(fs, DIR, s.id);
    expect(back).toEqual(s);

    const e = index.sessions[s.id];
    expect(e.title).toBe(s.title);
    expect(e.userMessageCount).toBe(2); // 只数 role=user
    expect(e.size).toBe(new TextEncoder().encode(JSON.stringify(s)).length); // 字节数而非字符数
    expect(e.mtimeMs).toBe(1700000000000); // 来自写后 stat（按日分组的时间来源）

    // 索引可从磁盘读回且与返回值一致
    expect(await loadIndex(fs, DIR)).toEqual(index);
  });

  it("并发 saveSession 不丢索引条目（进程内串行化回归锁）", async () => {
    // 修复前两个并发保存都「读旧索引→写回」，后写者会覆盖掉先写者的条目
    const fs = memFs();
    const a = newSession("P");
    const b = newSession("P");
    await Promise.all([saveSession(fs, DIR, a), saveSession(fs, DIR, b)]);
    const idx = await loadIndex(fs, DIR);
    expect(Object.keys(idx.sessions).sort()).toEqual([a.id, b.id].sort());
  });

  it("deleteSession：删文件 + 清索引；重复删除幂等", async () => {
    const fs = memFs();
    const s = newSession("P");
    await saveSession(fs, DIR, s);
    await deleteSession(fs, DIR, s.id);
    expect(await loadSession(fs, DIR, s.id)).toBeNull();
    expect((await loadIndex(fs, DIR)).sessions[s.id]).toBeUndefined();
    // 文件已不在也不抛错（fs.remove 对缺失文件是 no-op）
    await expect(deleteSession(fs, DIR, s.id)).resolves.toBeUndefined();
  });

  it("loadSession：文件缺失或损坏 → null", async () => {
    const fs = memFs();
    expect(await loadSession(fs, DIR, "不存在")).toBeNull();
    filesOf(fs)[sessionFile(DIR, "bad")] = "{broken";
    expect(await loadSession(fs, DIR, "bad")).toBeNull();
  });
});

describe("listSessions", () => {
  /** 直接构造索引（时间戳定长微秒 ISO，字典序即时间序） */
  function entry(title: string, projectPath: string, updatedAt: string) {
    return { title, projectPath, createdAt: updatedAt, updatedAt, userMessageCount: 0, size: 0, mtimeMs: 0 };
  }
  const idx: SessionIndex = {
    version: 1,
    sessions: {
      a: entry("早", "P1", "2026-05-21T10:00:00.000000"),
      b: entry("晚", "P1", "2026-05-21T12:00:00.000000"),
      c: entry("中", "P2", "2026-05-21T11:00:00.000000"),
    },
  };

  it("按 updatedAt 倒序；projectPath 过滤；不传则全量", () => {
    expect(listSessions(idx).map((e) => e.id)).toEqual(["b", "c", "a"]);
    expect(listSessions(idx, "P1").map((e) => e.id)).toEqual(["b", "a"]);
    expect(listSessions(idx, null).map((e) => e.id)).toEqual(["b", "c", "a"]);
  });

  it("updatedAt 并列时保持稳定顺序（比较器三值化回归锁）", () => {
    // 修复前的二值比较器对并列项返回 -1，违反比较器契约、顺序不可预期
    const tie: SessionIndex = {
      version: 1,
      sessions: {
        x: entry("x", "P", "2026-05-21T10:00:00.000000"),
        y: entry("y", "P", "2026-05-21T10:00:00.000000"),
      },
    };
    expect(listSessions(tie).map((e) => e.id)).toEqual(["x", "y"]);
  });

  it("过滤口径与删除一致：路径大小写/分隔符不同也能列出（B-3 回归锁）", () => {
    // 修复前 listSessions 用严格相等、deleteSessionsForProject 用 samePath：
    // 大小写不一致时列表过滤不出、删除却能匹配，留下孤儿会话
    const mixed: SessionIndex = {
      version: 1,
      sessions: {
        a: entry("甲", "C:\\Books\\作品A", "2026-05-21T10:00:00.000000"),
      },
    };
    expect(listSessions(mixed, "c:\\books\\作品A").map((e) => e.id)).toEqual(["a"]);
    expect(listSessions(mixed, "C:/Books/作品A/").map((e) => e.id)).toEqual(["a"]);
  });
});

describe("parseIndex 字段级容错", () => {
  it("脏条目字段回落默认值；非对象条目整条丢弃（N-29 回归锁：samePath 不再撞 TypeError）", () => {
    const idx = parseIndex(
      JSON.stringify({
        version: 1,
        sessions: {
          good: { title: "好", projectPath: "P1", updatedAt: "2026-05-21T10:00:00.000000" },
          dirty: { title: 1, projectPath: 42, updatedAt: null, mtimeMs: "x" },
          junk: "not-an-object",
        },
      }),
    );
    expect(Object.keys(idx.sessions).sort()).toEqual(["dirty", "good"]);
    expect(idx.sessions.dirty.projectPath).toBe("");
    expect(idx.sessions.dirty.mtimeMs).toBe(0);
    // 过滤与排序对脏数据不再抛
    expect(() => listSessions(idx, "P1")).not.toThrow();
  });
});
