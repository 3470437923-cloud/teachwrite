/**
 * 路径分级授权的边界（KL-TL-04）。
 * 这里只测纯函数：`..` 穿越的归一化、根内判定、以及 NTFS 备用数据流（ADS）拒绝。
 *
 * 跨平台口径（macOS 移植批次）：
 *  - 期望值一律用被测代码自己的 `join` / `PATH_SEP` 构造，不把 `\` 硬编码进断言 ——
 *    Windows 与 macOS 因此验证的是**同一条语义**（"归一化后用本机分隔符"），
 *    而不是"Windows 的实现细节"。
 *  - ADS（路径里的冒号）是 **NTFS 专有**语义：`src/core/tools/pathGuard.ts` 的冒号检查
 *    被 `IS_WINDOWS` 包住（POSIX 上冒号是合法文件名字符，Finder 把它显示成 `/`），
 *    所以那一组按平台限定；macOS 侧另给一条**互补**用例：根内文件名带冒号必须放行。
 */
import { describe, expect, it } from "vitest";
import {
  NEEDS_CONFIRMATION_PREFIX,
  guardPath,
  isInside,
  normalizeForCompare,
  resolveToolPath,
  type GuardRoots,
} from "../../src/core/tools/pathGuard";
import { IS_WINDOWS, join } from "../../src/core/dirs";

const roots: GuardRoots = {
  projectRoot: "D:\\书\\星海拾梦",
  skillsDir: "C:\\Users\\me\\AppData\\Roaming\\writerd\\skills",
  booksRoot: "D:\\书",
};

describe("normalizeForCompare / isInside", () => {
  it("统一分隔符与大小写，折叠 '.' 与 '..'", () => {
    // 输入混用 '/' 与 '\'，归一化后一律是**本机分隔符**并转小写：
    // Windows 得 'd:\书\星海拾梦\章节内容'，macOS 得 'd:/书/星海拾梦/章节内容'
    expect(normalizeForCompare("D:/书\\星海拾梦/./章节内容")).toBe(join("d:", "书", "星海拾梦", "章节内容"));
    expect(normalizeForCompare("D:\\书\\星海拾梦\\章节内容\\..\\小说资料")).toBe(
      join("d:", "书", "星海拾梦", "小说资料"),
    );
  });

  it("根内判定按本机分隔符对齐边界（C:\\ab 不算在 C:\\a 内）", () => {
    expect(isInside("D:\\书", "D:\\书\\星海拾梦\\第1章.md")).toBe(true);
    expect(isInside("D:\\书", "D:\\书")).toBe(true);
    expect(isInside("D:\\书\\星", "D:\\书\\星海拾梦")).toBe(false);
    expect(isInside("", "D:\\书\\星海拾梦")).toBe(false);
  });
});

describe("guardPath：授权根内放行、根外需确认", () => {
  it("项目内 / 作品根内的相对与绝对路径都放行", () => {
    expect(guardPath("章节内容\\第1章.md", roots).ok).toBe(true);
    expect(guardPath("D:\\书\\雾都谍影\\第1章.md", roots).ok).toBe(true);
    expect(guardPath("", roots).ok).toBe(true); // 空 = 项目根
  });

  it("根外一律逐字拒绝（确认机制未启用）", () => {
    const r = guardPath("C:\\Windows\\System32\\drivers\\etc\\hosts", roots);
    expect(r.ok).toBe(false);
    expect(r.message?.startsWith(NEEDS_CONFIRMATION_PREFIX)).toBe(true);
  });

  it("`..` 穿越穿越到根外也拒绝（归一化用词法回退，抵消盘符也不放行）", () => {
    const r = guardPath("..\\..\\..\\Windows\\win.ini", roots);
    expect(r.ok).toBe(false);
  });
});

/**
 * resolveToolPath 的分隔符口径与平台无关（"解析不改路径，只按本机口径归一"），
 * 所以它单独成组，不跟 ADS 一起被平台限定掉。
 */
describe("resolveToolPath：解析不改路径", () => {
  it("相对路径拼到项目根上，输入里的 '\\' 归一为本机分隔符，冒号尾巴原样保留", () => {
    // Windows: D:\书\星海拾梦\章节内容\第1章.md:payload
    // macOS  : D:\书\星海拾梦/章节内容/第1章.md:payload
    expect(resolveToolPath("章节内容\\第1章.md:payload", roots).abs).toBe(
      join(roots.projectRoot!, "章节内容", "第1章.md:payload"),
    );
  });
});

describe.runIf(IS_WINDOWS)("guardPath：NTFS 备用数据流（ADS，Windows 专有）", () => {
  it("根内路径挂冒号尾巴也拒绝 —— 否则判定看主路径、写入落隐藏流", () => {
    const r = guardPath("章节内容\\第1章.md:payload", roots);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("冒号");
  });

  it("盘符相对写法 `C:file` 同样拒绝（会拼出含冒号的路径）", () => {
    const r = guardPath("C:file", roots);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("冒号");
  });

  it("盘符本身的冒号（`C:\\...`）不算 ADS —— 不能把正常绝对路径一起拒了", () => {
    const r = guardPath("C:\\Users\\me\\AppData\\Roaming\\writerd\\skills\\x.md", roots);
    expect(r.ok).toBe(true);
  });
});

/**
 * POSIX 上冒号是**合法文件名字符**，所以 ADS 检查必须只属于 Windows；
 * 这里给 macOS 一条互补回归锁：正常带冒号的文件名不得被误拒。
 * （误拒的后果和 ADS 漏拒一样严重：用户整批文件读不到。）
 */
describe.runIf(!IS_WINDOWS)("guardPath：POSIX 上冒号是合法文件名字符（macOS 专有）", () => {
  it("根内文件名带冒号必须放行", () => {
    const r = guardPath("章节内容/第1章:初稿.md", roots);
    expect(r.ok).toBe(true);
    expect(r.resolved.abs).toBe(join(roots.projectRoot!, "章节内容", "第1章:初稿.md"));
  });

  it("POSIX 没有盘符概念：`C:file` 只是普通文件名，按项目内相对路径放行", () => {
    expect(guardPath("C:file", roots).ok).toBe(true);
  });
});
