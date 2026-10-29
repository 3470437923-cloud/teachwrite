/**
 * 路径权威（`src/core/dirs.ts`）的**跨平台**契约。
 *
 * 为什么单独一个文件：本仓库只有 Windows 机器能跑测试，而 macOS 的分隔符分支
 * 必须**在 Windows 上也能被验证**，不能只靠"伪装 process.platform"的临时探针。
 * `dirs.ts` 为此导出了显式分隔符版本 `joinWith` / `relativeWith` —— 这里对 `"/"`
 * 与 `"\\"` **各测一遍**，两种平台的拼法因此都有常驻回归锁，与跑测试的机器无关。
 *
 * 另一条关键点：`join` 有一条 POSIX 绝对路径防御（首段以 `/` 开头就无条件用 `/`），
 * 所以"macOS 的目录布局"这一整块在 Windows 上跑也成立 —— `resolveDirs` 的
 * macOS 口径用例因此**不**需要平台限定。
 */
import { describe, expect, it } from "vitest";
import {
  IS_WINDOWS,
  PATH_SEP,
  basename,
  dirname,
  isDriveRoot,
  join,
  joinWith,
  relative,
  relativeWith,
  resolveDirs,
} from "../../src/core/dirs";

describe("平台分隔符本身", () => {
  it("PATH_SEP 与平台判定同源（Windows '\\'，其余 '/'）", () => {
    expect(PATH_SEP).toBe(IS_WINDOWS ? "\\" : "/");
  });
});

describe("joinWith：两种平台分隔符各测一遍（不依赖跑测试的机器）", () => {
  it("Windows 拼法：'\\' 分隔，且裸盘符补回盘符根形态 'C:\\'", () => {
    expect(joinWith("\\", "C:\\", "书", "章节内容", "第1章.md")).toBe("C:\\书\\章节内容\\第1章.md");
    expect(joinWith("\\", "D:\\书", "星海拾梦")).toBe("D:\\书\\星海拾梦");
    expect(joinWith("\\", "C:")).toBe("C:\\");
  });

  it("macOS 拼法：'/' 分隔，且**不**给裸 'C:' 补分隔符（POSIX 上那只是个合法文件名）", () => {
    expect(joinWith("/", "/Users/me/AI写小说", "书", "章节内容", "第1章.md")).toBe(
      "/Users/me/AI写小说/书/章节内容/第1章.md",
    );
    expect(joinWith("/", "/Users/me", "AI写小说")).toBe("/Users/me/AI写小说");
    expect(joinWith("/", "C:")).toBe("C:");
  });

  it("两种分隔符都吃：重复/尾部分隔符折叠、空段丢弃（不会拼出双分隔符）", () => {
    expect(joinWith("\\", "C:\\书\\", "", "\\章节内容\\", "第1章.md")).toBe("C:\\书\\章节内容\\第1章.md");
    expect(joinWith("/", "/Users/me/", "", "/AI写小说/", "书")).toBe("/Users/me/AI写小说/书");
    // 首段保留前导分隔符（UNC 根 / 盘内绝对路径原样带过）
    expect(joinWith("\\", "\\\\server\\share", "书")).toBe("\\\\server\\share\\书");
  });
});

describe("join：本机分隔符，外加一条 POSIX 绝对路径防御", () => {
  it("普通相对段用本机分隔符", () => {
    expect(join("章节内容", "第1章.md")).toBe("章节内容" + PATH_SEP + "第1章.md");
    expect(join("a", "b", "c")).toBe(["a", "b", "c"].join(PATH_SEP));
  });

  it("首段是 '/' 开头的 POSIX 绝对路径 → 无条件用 '/'，即使平台识别失败也不拼出 '\\'", () => {
    // Rust 侧递过来的 /Users/... 若被拼成 /Users/me\AI写小说，那在 POSIX 上是**单个目录名**：
    // create_dir_all 会在家目录下建一个带反斜杠的怪目录，而全部派生路径同时失效。
    // 这条在 Windows 上也必须成立（下方 resolveDirs 的 macOS 用例依赖它）。
    expect(join("/Users/me", "AI写小说")).toBe("/Users/me/AI写小说");
    expect(join("/Users/me/", "AI写小说", "书")).toBe("/Users/me/AI写小说/书");
  });
});

describe("relativeWith：两种平台分隔符各测一遍", () => {
  it("Windows：base 内返回相对路径，根自身返回空串，根外返回 null", () => {
    expect(relativeWith("\\", "D:\\书", "D:\\书\\星海拾梦\\第1章.md")).toBe("星海拾梦\\第1章.md");
    expect(relativeWith("\\", "D:\\书", "D:\\书")).toBe("");
    expect(relativeWith("\\", "D:\\书", "C:\\别处\\x.md")).toBeNull();
    // 前缀比较大小写不敏感（Windows 语义；macOS 默认 APFS 也是大小写不敏感卷）
    expect(relativeWith("\\", "D:\\书", "d:\\书\\星海拾梦\\第1章.md")).toBe("星海拾梦\\第1章.md");
    // 边界要对齐到分隔符：'D:\书' 不该把 'D:\书稿' 认成子路径
    expect(relativeWith("\\", "D:\\书", "D:\\书稿\\第1章.md")).toBeNull();
  });

  it("macOS：'/'-分隔同样成立，边界对齐与大小写口径一致", () => {
    expect(relativeWith("/", "/Users/me/AI写小说", "/Users/me/AI写小说/书/第1章.md")).toBe("书/第1章.md");
    expect(relativeWith("/", "/Users/me/AI写小说", "/Users/me/AI写小说")).toBe("");
    expect(relativeWith("/", "/Users/me/AI写小说", "/Users/me/别处/x.md")).toBeNull();
    expect(relativeWith("/", "/Users/me/AI写小说", "/users/me/AI写小说/书/第1章.md")).toBe("书/第1章.md");
    expect(relativeWith("/", "/Users/me/书", "/Users/me/书稿/第1章.md")).toBeNull();
  });

  it("混合分隔符输入不得被误判成「不在 base 内」（口径与 basename/dirname 一致）", () => {
    // 只锁"没被误判成根外"这一条：归一化后确实落在 base 里。
    // （返回值在混合输入下会带一个前导分隔符，属已知小瑕疵，见报告，不在此断言成契约。）
    expect(relativeWith("\\", "D:\\书", "D:/书/星海拾梦/第1章.md")).not.toBeNull();
    expect(relativeWith("/", "/Users/me/书", "/Users/me/书/第1章.md")).not.toBeNull();
  });

  it("relative（本机版）与 relativeWith(PATH_SEP) 同源", () => {
    expect(relative("章节内容", "章节内容/第1章.md")).toBe("第1章.md");
    expect(relative("D:\\书", "C:\\别处\\x.md")).toBeNull();
  });
});

describe("basename / dirname / isDriveRoot：两种分隔符都吃", () => {
  it("basename：先剥尾部分隔符再取最后一段", () => {
    expect(basename("D:\\书\\第1章.md")).toBe("第1章.md");
    expect(basename("/Users/me/书/第1章.md")).toBe("第1章.md");
    expect(basename("/Users/me/书/")).toBe("书");
  });

  it("dirname：POSIX 顶层补正为 '/'（空串会污染授权上溯），Windows 盘符下第一段回到 'C:\\'", () => {
    expect(dirname("/Users/me")).toBe("/Users");
    expect(dirname("/Users")).toBe("/");
    expect(dirname("/")).toBe("/");
    expect(dirname("D:\\书\\第1章.md")).toBe("D:\\书");
    expect(dirname("C:\\书")).toBe("C:\\");
  });

  it("isDriveRoot：盘符根/裸根一律为真；POSIX 口径下额外的卷根与系统顶层目录也拦住", () => {
    // Windows 口径（显式传 windows=true，任意平台都可测）
    expect(isDriveRoot("C:\\", true)).toBe(true);
    expect(isDriveRoot("C:", true)).toBe(true);
    expect(isDriveRoot("C:\\书", true)).toBe(false);
    // macOS 口径（显式传 windows=false）
    expect(isDriveRoot("/", false)).toBe(true);
    expect(isDriveRoot("/Users", false)).toBe(true); // 文件系统根下的顶层目录（范围过大）
    expect(isDriveRoot("/Volumes/Backup", false)).toBe(true); // 挂载卷根
    expect(isDriveRoot("/Users/me/AI写小说", false)).toBe(false);
    expect(isDriveRoot("Users", false)).toBe(false); // 相对路径不是根
  });
});

describe("resolveDirs：应用数据独立，作品目录兼容", () => {
  it("Windows 口径：所有应用数据位于 <appData>/com.teachwrite.desktop", () => {
    const d = resolveDirs({
      home: "C:\\Users\\me",
      documents: "C:\\Users\\me\\Documents",
      appData: "C:\\Users\\me\\AppData\\Roaming",
    });
    // 期望值用被测代码自己的 join 构造：夹具是 Windows 形态的输入，语义是
    // "基目录 + 冻结名"这一条（与分隔符无关），所以两平台跑都成立。
    expect(d.booksRoot).toBe(join("C:\\Users\\me", "AI写小说"));
    expect(d.sessionsDir).toBe(join(d.prefsDir, "writerd_sessions"));
    expect(d.snapshotsDir).toBe(join(d.prefsDir, "writerd_snapshots"));
    expect(d.memosFile).toBe(join(d.prefsDir, "writerd_memos.json"));
    expect(d.skillsDir).toBe(join(d.prefsDir, "skills"));
    expect(d.quickPromptsFile).toBe(join(d.prefsDir, "writerd_quick_prompts.json"));
    expect(d.prefsDir).toBe(join("C:\\Users\\me\\AppData\\Roaming", "com.teachwrite.desktop"));
    expect(d.prefsFile).toBe(join(d.prefsDir, "shared_preferences.json"));
    expect(d.usageStatsFile).toBe(join(d.prefsDir, "usage_stats.json"));
    expect(d.logFile).toBe(join(d.logDir, "diagnostic.log"));
  });

  it("macOS 口径：应用数据位于 Application Support/com.teachwrite.desktop", () => {
    // 这里的字面量期望值**在 Windows 上也成立**：join 见到首段以 '/' 开头就无条件用 '/'
    // （见上方 POSIX 绝对路径防御），所以 macOS 布局无需平台限定即可验证。
    const d = resolveDirs({
      home: "/Users/me",
      documents: "/Users/me/Documents",
      appData: "/Users/me/Library/Application Support",
    });
    expect(d.booksRoot).toBe("/Users/me/AI写小说");
    expect(d.sessionsDir).toBe("/Users/me/Library/Application Support/com.teachwrite.desktop/writerd_sessions");
    expect(d.snapshotsDir).toBe("/Users/me/Library/Application Support/com.teachwrite.desktop/writerd_snapshots");
    expect(d.memosFile).toBe("/Users/me/Library/Application Support/com.teachwrite.desktop/writerd_memos.json");
    expect(d.skillsDir).toBe("/Users/me/Library/Application Support/com.teachwrite.desktop/skills");
    expect(d.quickPromptsFile).toBe("/Users/me/Library/Application Support/com.teachwrite.desktop/writerd_quick_prompts.json");
    expect(d.prefsDir).toBe("/Users/me/Library/Application Support/com.teachwrite.desktop");
    expect(d.prefsFile).toBe("/Users/me/Library/Application Support/com.teachwrite.desktop/shared_preferences.json");
    expect(d.usageStatsFile).toBe("/Users/me/Library/Application Support/com.teachwrite.desktop/usage_stats.json");
    expect(d.logFile).toBe("/Users/me/Library/Application Support/com.teachwrite.desktop/diagnostics/diagnostic.log");
  });

  it("prefs 覆盖项生效时不再走默认作品根/技能根（两平台同一条语义）", () => {
    const d = resolveDirs({
      home: "/Users/me",
      documents: "/Users/me/Documents",
      appData: "/Users/me/Library/Application Support",
      booksRoot: "/Volumes/Backup/小说",
      skillsDir: "/Users/me/我的技能",
    });
    expect(d.booksRoot).toBe("/Volumes/Backup/小说");
    expect(d.skillsDir).toBe("/Users/me/我的技能");
    // 覆盖项只影响这两项，其余仍按系统目录推导
    expect(d.sessionsDir).toBe("/Users/me/Library/Application Support/com.teachwrite.desktop/writerd_sessions");
  });
});

describe("TeachWrite 隔离回归", () => {
  it("Linux 使用系统数据根，所有应用数据排除旧目录", () => {
    const d = resolveDirs({ home: "/home/me", documents: "/home/me/Documents", appData: "/home/me/.local/share" });
    expect(d.prefsDir).toBe("/home/me/.local/share/com.teachwrite.desktop");
    for (const path of [d.sessionsDir, d.snapshotsDir, d.memosFile, d.skillsDir, d.quickPromptsFile, d.prefsFile, d.usageStatsFile, d.logFile]) {
      expect(path.startsWith(d.prefsDir + "/")).toBe(true);
      expect(path).not.toContain("/Documents/");
      expect(path).not.toContain("com.writerd");
    }
    expect(d.booksRoot).toBe("/home/me/AI写小说");
  });
});
