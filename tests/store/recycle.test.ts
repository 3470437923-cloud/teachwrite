/**
 * 作品回收站：两段式删除的边界。
 *
 * 重点不是"能删"，而是**删不动时会不会硬删**：
 * 路径段合法性、作品根直接子项、系统条目、链接穿透、活动占用 —— 这些门
 * 每一条都用一个"看起来能删"的输入去撞，确认它被挡住。
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFs } from "../support/nodeFs";
import {
  checkActivity,
  checkPurgeTarget,
  childNameProblem,
  dirSize,
  emptyManifest,
  emptyRecycle,
  formatBytes,
  isReservedDeviceName,
  itemPath,
  loadManifest,
  moveToRecycle,
  parseManifest,
  purgeItem,
  recycleCount,
  restoreFromRecycle,
  serializeManifest,
} from "../../src/core/store/recycle";
import { deleteSessionsForProject, emptyIndex, saveIndex, type SessionIndex } from "../../src/core/store/session";
import { recycleRoot } from "../../src/core/dirs";

const fs = createNodeFs();
let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "deepcompose-recycle-"));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

/** 造一部作品（含目录与文件，形状与 createProject 一致：清单 + 两个子目录） */
async function makeBook(name: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.writeText(path.join(dir, ".openwrite_manifest.json"), JSON.stringify({ version: 1, name }));
  await fs.writeText(path.join(dir, "章节内容", "第1章.md"), "第一章正文");
  await fs.writeText(path.join(dir, "小说资料", "人物库.md"), "人物库");
  return dir;
}

describe("清单解析（容错优先）", () => {
  it("坏 JSON / 非对象 / 条目缺 id 一律回落，不抛", () => {
    expect(parseManifest("").items).toEqual([]);
    expect(parseManifest("{ 坏").items).toEqual([]);
    expect(parseManifest("[]").items).toEqual([]);
    expect(parseManifest('{"items":"x"}').items).toEqual([]);
    expect(parseManifest('{"items":[{"name":"没有id"}]}').items).toEqual([]);
  });

  it("合规条目按字段读入，sizeBytes 取非负整数、缺字段有默认值", () => {
    const m = parseManifest(
      JSON.stringify({
        version: 1,
        items: [{ id: "20260704170528_1", name: "星海拾梦", originalPath: "D:\\书\\星海拾梦", movedAt: "2026-07-04T17:05:28.000Z", sizeBytes: 123.7 }],
      }),
    );
    expect(m.items).toHaveLength(1);
    expect(m.items[0]).toMatchObject({ id: "20260704170528_1", name: "星海拾梦", sizeBytes: 123 });
    const loose = parseManifest('{"items":[{"id":"x"}]}');
    expect(loose.items[0]).toMatchObject({ id: "x", name: "x", originalPath: "", movedAt: "", sizeBytes: 0 });
  });

  it("BOM 与空清单可往返（写出去的就是读回来的）", () => {
    const text = serializeManifest(emptyManifest());
    expect(parseManifest("\uFEFF" + text)).toEqual(emptyManifest());
    expect(parseManifest(text)).toEqual(emptyManifest());
  });
});

describe("名字与设备名", () => {
  it("Windows 保留设备名识别（含带扩展名与大小写）", () => {
    for (const n of ["CON", "con", "NUL.txt", "COM1", "lpt9.md", "PRN", "AUX"]) {
      expect(isReservedDeviceName(n)).toBe(true);
    }
    for (const n of ["COM0", "COM10", "console", "nulll", "aux2"]) {
      expect(isReservedDeviceName(n)).toBe(false);
    }
  });

  it("childNameProblem 逐条挡住危险名字，放过正常作品名", () => {
    expect(childNameProblem("星海拾梦")).toBeNull();
    expect(childNameProblem("My Book 2")).toBeNull();
    expect(childNameProblem("")).not.toBeNull();
    expect(childNameProblem(".")).not.toBeNull();
    expect(childNameProblem("..")).not.toBeNull();
    expect(childNameProblem("a\\b")).not.toBeNull();
    expect(childNameProblem("a/b")).not.toBeNull();
    // 冒号 = NTFS 备用数据流：`book:secret` 能写到作品目录的隐藏流里
    expect(childNameProblem("book:secret")).not.toBeNull();
    expect(childNameProblem("a*b")).not.toBeNull();
    expect(childNameProblem("书名 ")).not.toBeNull();
    expect(childNameProblem("书名.")).not.toBeNull();
    expect(childNameProblem("NUL")).not.toBeNull();
    expect(childNameProblem("a\u0001b")).not.toBeNull();
  });
});

describe("彻底删除的四道安全门", () => {
  const booksRoot = "D:\\书";

  it("① 只接受作品根直接子项或回收站条目", () => {
    expect(checkPurgeTarget({ booksRoot, target: "D:\\书\\星海拾梦", isLink: false })).toBeNull();
    expect(
      checkPurgeTarget({ booksRoot, target: "D:\\书\\.openwrite_recycle\\20260704170528_1", isLink: false }),
    ).toBeNull();
    // 更深一层：作品内部的目录不该被"彻底删除"入口直接删
    expect(checkPurgeTarget({ booksRoot, target: "D:\\书\\星海拾梦\\章节内容", isLink: false })).not.toBeNull();
    // 别处
    expect(checkPurgeTarget({ booksRoot, target: "D:\\别的地方\\星海拾梦", isLink: false })).not.toBeNull();
    expect(checkPurgeTarget({ booksRoot, target: "D:\\", isLink: false })).not.toBeNull();
  });

  it("②③ 系统条目与非法名字被挡住", () => {
    expect(checkPurgeTarget({ booksRoot, target: "D:\\书\\writerd_x", isLink: false })).not.toBeNull();
    expect(checkPurgeTarget({ booksRoot, target: "D:\\书\\.openwrite_manifest.json", isLink: false })).not.toBeNull();
    expect(checkPurgeTarget({ booksRoot, target: "D:\\书\\recycle_manifest.json", isLink: false })).not.toBeNull();
    expect(checkPurgeTarget({ booksRoot, target: "D:\\书\\NUL", isLink: false })).not.toBeNull();
  });

  it("④ 链接 / junction 一律拒绝（防穿透到别处）", () => {
    expect(checkPurgeTarget({ booksRoot, target: "D:\\书\\星海拾梦", isLink: true })).toContain("链接");
  });
});

describe("活动门", () => {
  it("正在生成 / 会话属于它 / 编辑器开着它的文件 —— 三种占用都要拦住", () => {
    const target = "D:\\书\\星海拾梦";
    expect(checkActivity({ busy: true, sessionProjectPath: null, openFilePath: null }, target)).toContain("生成");
    expect(
      checkActivity({ busy: false, sessionProjectPath: "D:\\书\\星海拾梦", openFilePath: null }, target),
    ).toContain("对话");
    // 大小写与分隔符不该成为绕过口子（Windows 同一目录的两种写法）
    expect(
      checkActivity({ busy: false, sessionProjectPath: "d:/书/星海拾梦/", openFilePath: null }, target),
    ).toContain("对话");
    expect(
      checkActivity({ busy: false, sessionProjectPath: null, openFilePath: "D:\\书\\星海拾梦\\章节内容\\第1章.md" }, target),
    ).toContain("编辑器");
    // 别的作品不受影响
    expect(
      checkActivity(
        { busy: false, sessionProjectPath: "D:\\书\\另一部", openFilePath: "D:\\书\\另一部\\第1章.md" },
        target,
      ),
    ).toBeNull();
  });
});

describe("移入 → 还原 / 彻底删除（真盘往返）", () => {
  it("移入：目录搬进回收站、清单记条目、原位置不再存在", async () => {
    const dir = await makeBook("星海拾梦");
    const item = await moveToRecycle(fs, root, {
      name: "星海拾梦",
      originalPath: dir,
      id: "20260704170528_1",
      when: new Date("2026-07-04T09:05:28.000Z"),
    });
    expect(item.id).toBe("20260704170528_1");
    expect(item.movedAt).toBe("2026-07-04T09:05:28.000Z");
    expect(await fs.exists(dir)).toBe(false);
    expect(await fs.exists(itemPath(root, item.id))).toBe(true);
    // 清单落盘后能被重新读出来
    const manifest = await loadManifest(fs, root);
    expect(manifest.items.map((i) => i.id)).toEqual([item.id]);
    expect(await recycleCount(fs, root)).toBe(1);
    expect(item.sizeBytes).toBeGreaterThan(0);
  });

  it("移入前先查名字与父目录：非法名 / 非直接子项一律不动盘", async () => {
    const dir = await makeBook("星海拾梦");
    await expect(moveToRecycle(fs, root, { name: "NUL", originalPath: path.join(root, "NUL") })).rejects.toThrow();
    await expect(
      moveToRecycle(fs, root, { name: "章节内容", originalPath: path.join(dir, "章节内容") }),
    ).rejects.toThrow();
    expect(await fs.exists(dir)).toBe(true);
  });

  it("移入：清单写失败 → 作品目录原封不动（N-04 回归锁：先改名后写清单会让作品消失）", async () => {
    const dir = await makeBook("星海拾梦");
    // 造一个"只对回收站清单写失败"的桥
    const failing = {
      ...fs,
      async writeText(p: string, c: string): Promise<void> {
        if (p.endsWith("recycle_manifest.json")) throw new Error("磁盘被占用");
        return fs.writeText(p, c);
      },
    };
    await expect(
      moveToRecycle(failing, root, { name: "星海拾梦", originalPath: dir, id: "id_fail" }),
    ).rejects.toThrow(/磁盘被占用/);
    // 顺序纪律（先记清单后搬目录）：清单失败时目录必须还在原位
    expect(await fs.exists(dir)).toBe(true);
    expect(await fs.exists(itemPath(root, "id_fail"))).toBe(false);
  });

  it("彻底删除：条目目录已被手工删掉 → 直接清条目成功返回（N-26）", async () => {
    const dir = await makeBook("星海拾梦");
    const item = await moveToRecycle(fs, root, { name: "星海拾梦", originalPath: dir, id: "id_gone" });
    await fsp.rm(itemPath(root, item.id), { recursive: true, force: true });
    const r = await purgeItem(fs, root, "id_gone");
    expect(r.ok).toBe(true);
    expect(await recycleCount(fs, root)).toBe(0);
  });

  it("还原：搬回原位、清单清空；原位置已占用时**不覆盖**", async () => {
    const dir = await makeBook("星海拾梦");
    const item = await moveToRecycle(fs, root, { name: "星海拾梦", originalPath: dir, id: "id_1" });
    const back = await restoreFromRecycle(fs, root, item.id);
    expect(back.ok).toBe(true);
    expect(await fs.exists(dir)).toBe(true);
    expect((await loadManifest(fs, root)).items).toEqual([]);

    // 再来一次：搬走后又造一个同名目录占位
    await moveToRecycle(fs, root, { name: "星海拾梦", originalPath: dir, id: "id_2" });
    await fs.mkdir(dir);
    await fs.writeText(path.join(dir, "占位.md"), "别人的目录");
    const blocked = await restoreFromRecycle(fs, root, "id_2");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("已有同名作品");
    // 占位目录没被动过
    expect(await fs.readText(path.join(dir, "占位.md"))).toBe("别人的目录");
    expect(await recycleCount(fs, root)).toBe(1);
  });

  it("条目目录被手工删掉后再点还原：清掉死条目并如实说明", async () => {
    const dir = await makeBook("星海拾梦");
    const item = await moveToRecycle(fs, root, { name: "星海拾梦", originalPath: dir, id: "id_3" });
    await fsp.rm(itemPath(root, item.id), { recursive: true, force: true });
    const r = await restoreFromRecycle(fs, root, "id_3");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("回收站文件不存在");
    expect(await recycleCount(fs, root)).toBe(0);
  });

  it("彻底删除：目录真的没了、清单也清了；重复删除报「条目不存在」", async () => {
    const dir = await makeBook("星海拾梦");
    const item = await moveToRecycle(fs, root, { name: "星海拾梦", originalPath: dir, id: "id_4" });
    const first = await purgeItem(fs, root, item.id);
    expect(first.ok).toBe(true);
    expect(await fs.exists(itemPath(root, item.id))).toBe(false);
    expect(await fs.exists(dir)).toBe(false);
    expect(await recycleCount(fs, root)).toBe(0);
    const again = await purgeItem(fs, root, "id_4");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain("不存在");
  });

  it("清空回收站：多条一起删，只留下清单与回收站目录本身", async () => {
    const a = await makeBook("第一部");
    const b = await makeBook("第二部");
    await moveToRecycle(fs, root, { name: "第一部", originalPath: a, id: "id_a" });
    await moveToRecycle(fs, root, { name: "第二部", originalPath: b, id: "id_b" });
    const r = await emptyRecycle(fs, root);
    expect(r.removed).toBe(2);
    expect(r.failed).toEqual([]);
    expect(await fs.exists(itemPath(root, "id_a"))).toBe(false);
    expect(await fs.exists(itemPath(root, "id_b"))).toBe(false);
    // 回收站根还在（清单要留在里面），但里面没有目录了
    const entries = await fs.list(recycleRoot(root));
    expect(entries.filter((e) => e.isDir)).toEqual([]);
    expect(await recycleCount(fs, root)).toBe(0);
  });

  it("把回收站里的条目再删一次是幂等的（清单不会留下幽灵）", async () => {
    const dir = await makeBook("星海拾梦");
    const item = await moveToRecycle(fs, root, { name: "星海拾梦", originalPath: dir, id: "id_5" });
    await fsp.rm(itemPath(root, item.id), { recursive: true, force: true });
    const r = await purgeItem(fs, root, "id_5");
    // 目录已经不在了 → removeChild 是 no-op，安全门照过，清单被清掉
    expect(r.ok).toBe(true);
    expect(await recycleCount(fs, root)).toBe(0);
  });

  it("dirSize 递归统计文件字节（目录本身不计）", async () => {
    const dir = await makeBook("星海拾梦");
    const size = await dirSize(fs, dir);
    const expectBytes = Buffer.byteLength("第一章正文", "utf8") + Buffer.byteLength("人物库", "utf8") + Buffer.byteLength('{"version":1,"name":"星海拾梦"}', "utf8");
    expect(size).toBe(expectBytes);
  });

  it("缺失目录按 0 计（不抛）", async () => {
    expect(await dirSize(fs, path.join(root, "根本没有"))).toBe(0);
  });
});

describe("作品删除时的会话清理", () => {
  const sessionsDir = () => path.join(root, "writerd_sessions");

  function idx(): SessionIndex {
    return {
      ...emptyIndex(),
      sessions: {
        s1: entry("D:\\书\\星海拾梦"),
        s2: entry("d:/书/星海拾梦/"), // 同一目录的另一种写法
        s3: entry("D:\\书\\别的作品"),
      },
    };
  }
  function entry(projectPath: string) {
    return {
      title: "t",
      projectPath,
      createdAt: "2026-07-04T09:00:00.000000Z",
      updatedAt: "2026-07-04T09:00:00.000000Z",
      userMessageCount: 1,
      size: 10,
      mtimeMs: 1,
    };
  }

  it("删掉该作品的会话（含大小写/分隔符变体），别的作品不受影响", async () => {
    await saveIndex(fs, sessionsDir(), idx());
    for (const id of ["s1", "s2", "s3"]) await fs.writeText(path.join(sessionsDir(), `${id}.json`), "{}");
    const n = await deleteSessionsForProject(fs, sessionsDir(), "D:\\书\\星海拾梦");
    expect(n.count).toBe(2);
    // id 列表要一并交回：调用方拿它去清 AI 侧会话级内存缓存（KL-AI-11）
    expect(n.ids.sort()).toEqual(["s1", "s2"]);
    const after = JSON.parse(await fs.readText(path.join(sessionsDir(), "index.json"))) as SessionIndex;
    expect(Object.keys(after.sessions)).toEqual(["s3"]);
    expect(await fs.exists(path.join(sessionsDir(), "s1.json"))).toBe(false);
    expect(await fs.exists(path.join(sessionsDir(), "s3.json"))).toBe(true);
  });

  it("没有会话时返回 0 且不重写索引", async () => {
    await saveIndex(fs, sessionsDir(), idx());
    const before = await fs.readText(path.join(sessionsDir(), "index.json"));
    const n = await deleteSessionsForProject(fs, sessionsDir(), "D:\\书\\没有会话的作品");
    expect(n.count).toBe(0);
    expect(n.ids).toEqual([]);
    expect(await fs.readText(path.join(sessionsDir(), "index.json"))).toBe(before);
  });
});

describe("formatBytes", () => {
  it("按 1024 进制粗粒度，负数/NaN 归 0", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 1024 * 3.5)).toBe("3.5 MB");
  });
});