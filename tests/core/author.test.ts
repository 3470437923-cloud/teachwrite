/**
 * 作者信息读取层(B19 / D-053)的回归锁。
 *
 * 钉住"单一真源"的形态:值必须来自 Rust app_info,前端不得再有第二份字面量;
 * 任一必需字段不合法一律判为"取不到"(界面显示占位,绝不编造名字)。
 */
import { describe, expect, it } from "vitest";
import { authorStatement, __parseAuthorForTest as parseAuthor } from "../../src/core/author";

const full = {
  name: "DeepCompose",
  version: "1.1.0",
  author: "Liumorrow",
  copyright: "Copyright © 2026 Liumorrow",
  qqGroup: "1071188925",
  douyinUrl: "https://v.douyin.com/cKG2h8pU1IM/",
  build: "e5ca47a @ 2026-10-08T12:00:00Z",
};

describe("authorFromAppInfo", () => {
  it("完整形态照单收下", () => {
    const a = parseAuthor(full);
    expect(a).not.toBeNull();
    expect(a!.name).toBe("Liumorrow");
    expect(a!.qqGroup).toBe("1071188925");
    expect(a!.douyinUrl).toBe("https://v.douyin.com/cKG2h8pU1IM/");
    expect(a!.build).toContain("e5ca47a");
  });

  it("缺任一必需字段 → null(不拿半截署名冒充)", () => {
    for (const k of ["author", "copyright", "qqGroup", "douyinUrl"]) {
      const bad = { ...full, [k]: undefined };
      expect(parseAuthor(bad)).toBeNull();
    }
  });

  it("非 https 的链接判为不可用(open_url 只放行 https,前端同口径)", () => {
    expect(parseAuthor({ ...full, douyinUrl: "http://v.douyin.com/x" })).toBeNull();
    expect(parseAuthor({ ...full, douyinUrl: "javascript:alert(1)" })).toBeNull();
  });

  it("空串/纯空白字段判为不可用", () => {
    expect(parseAuthor({ ...full, author: "   " })).toBeNull();
    expect(parseAuthor({ ...full, qqGroup: "" })).toBeNull();
    expect(parseAuthor(null)).toBeNull();
    expect(parseAuthor(undefined)).toBeNull();
  });

  it("build 可以缺省(老产物/预览沙箱之外的降级形态)", () => {
    const { build: _drop, ...rest } = full;
    expect(parseAuthor(rest)?.build).toBe("");
  });

  it("声明文案带上作者名,且不含未实现能力的承诺", () => {
    const s = authorStatement("Liumorrow");
    expect(s).toContain("Liumorrow");
    expect(s).toContain("DeepSeek");
    expect(s).toContain("本机");
    // 界面准则:不许出现「以后会有 / 后续批次」式承诺
    expect(s).not.toMatch(/后续批次|敬请期待|将会支持/);
  });
});
