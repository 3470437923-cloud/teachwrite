/**
 * 配置模型：键名沿用既有格式、商业化键永不写出、novel_projects 为 '\n' 分隔。
 * 样本值为实测值（敏感值一律用占位串）。
 */
import { describe, expect, it } from "vitest";
import {
  ACCENT_AUTO,
  DEFAULT_PREFS,
  DEFAULT_SYSTEM_PROMPT,
  DS_BLUE_ARGB,
  accentHex,
  activeProfile,
  activeProvider,
  deriveProfileId,
  nativeThinkingSupported,
  parsePrefs,
  platformOf,
  serializePrefs,
} from "../../src/core/prefs";

/** 既有格式样本：键名逐字，密钥/手机号用占位 */
const REAL_SHAPE = JSON.stringify({
  "flutter.llm_base_url": "https://newapi.example.cn",
  "flutter.api_key": "PLACEHOLDER",
  "flutter.model": "deepseek-v4-pro",
  "flutter.temperature": 0.8,
  "flutter.context_limit": 1000000,
  "flutter.use_anthropic_format": false,
  "flutter.reserved_output_tokens": 16000,
  "flutter.auto_clear_context": true,
  "flutter.saved_providers": JSON.stringify([
    { name: "公益模型", baseUrl: "https://a.example", apiKey: "PLACEHOLDER", model: "m1", useAnthropicFormat: false },
    { name: "示例供应商", baseUrl: "https://newapi.example.cn", apiKey: "PLACEHOLDER", model: "deepseek-v4-pro", useAnthropicFormat: false },
  ]),
  "flutter.panel_session_width": 220.0,
  "flutter.panel_chat_width": 523.0,
  "flutter.panel_directory_width": 200.0,
  "flutter.panel_memo_width": 320.0,
  "flutter.panel_show_session": true,
  "flutter.panel_show_directory": true,
  "flutter.panel_show_memo": false,
  "flutter.skill_list": JSON.stringify([
    {
      id: "builtin_novel-writer",
      name: "novel-writer",
      description: "写小说时使用的技能。",
      directoryPath: "C:\\Users\\X\\Documents\\skills\\novel-writer",
      isBuiltIn: true,
      marketplaceSkillId: null,
      marketplaceVersion: null,
    },
  ]),
  "flutter.active_skill_ids": JSON.stringify(["builtin_novel-writer"]),
  "flutter.default_skills_initialized": true,
  "flutter.custom_accent_color": 4285952412,
  "flutter.is_dark_mode": true,
  "flutter.chat_font_size": 15.0,
  "flutter.editor_font_size": 15.0,
  "flutter.novel_projects": "C:\\A\\书一\nC:\\A\\书二\n",
  "flutter.current_novel_project": "C:\\A\\书二",
  "flutter.webdav_config": JSON.stringify({ url: "", username: "", password: "", remotePath: "", lastSyncTime: "" }),
  "flutter.vip_status": true,
  "flutter.device_id": "SHOULD-NOT-LEAK",
});

describe("配置解析", () => {
  it("逐字段读到既有键名对应的值", () => {
    const p = parsePrefs(REAL_SHAPE);
    expect(p.llmBaseUrl).toBe("https://newapi.example.cn");
    expect(p.model).toBe("deepseek-v4-pro");
    expect(p.temperature).toBe(0.8);
    expect(p.contextLimit).toBe(1000000);
    expect(p.useAnthropicFormat).toBe(false);
    expect(p.reservedOutputTokens).toBe(16000);
    expect(p.autoClearContext).toBe(true);
    expect(p.savedProviders).toHaveLength(2);
    expect(p.savedProviders[0].name).toBe("公益模型");
    expect(p.panelChatWidth).toBe(523.0);
    expect(p.panelShowMemo).toBe(false);
    expect(p.skillList[0].id).toBe("builtin_novel-writer");
    expect(p.skillList[0].isBuiltIn).toBe(true);
    expect(p.activeSkillIds).toEqual(["builtin_novel-writer"]);
    expect(p.customAccentColor).toBe(4285952412); // 0xFF8A919C 中灰（非默认值，不参与旧默认迁移）
    expect(p.chatFontSize).toBe(15.0);
  });

  it("novel_projects 按 '\\n' 拆分为绝对路径数组，忽略空行", () => {
    const p = parsePrefs(REAL_SHAPE);
    expect(p.novelProjects).toEqual(["C:\\A\\书一", "C:\\A\\书二"]);
    expect(p.currentNovelProject).toBe("C:\\A\\书二");
  });

  it("空 / 损坏 JSON 回落默认值，不抛异常", () => {
    expect(parsePrefs("")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("{坏")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("[]")).toEqual(DEFAULT_PREFS);
  });

  it("带 UTF-8 BOM 的配置仍能解析（Windows PowerShell 写文件会带 BOM）", () => {
    const withBom = "\uFEFF" + JSON.stringify({ "flutter.model": "deepseek-v4-pro" });
    expect(parsePrefs(withBom).model).toBe("deepseek-v4-pro");
    expect(parsePrefs("\uFEFF" + REAL_SHAPE).apiKey).toBe("PLACEHOLDER");
  });

  it("类型不符时回落默认值（不做隐式转换）", () => {
    const p = parsePrefs(JSON.stringify({ "flutter.temperature": "0.8", "flutter.panel_chat_width": true }));
    expect(p.temperature).toBe(DEFAULT_PREFS.temperature);
    expect(p.panelChatWidth).toBe(DEFAULT_PREFS.panelChatWidth);
  });

  it("accentHex 把 0xAARRGGBB 转成 #RRGGBB", () => {
    expect(accentHex(4286343935)).toBe("#7C6AFF");
  });
});

describe("主题模式（theme_mode 扩展键）", () => {
  it("默认深色", () => {
    expect(DEFAULT_PREFS.themeMode).toBe("dark");
    expect(parsePrefs("").themeMode).toBe("dark");
  });

  it("显式 theme_mode 两态直读", () => {
    expect(parsePrefs(JSON.stringify({ "flutter.theme_mode": "light" })).themeMode).toBe("light");
    expect(parsePrefs(JSON.stringify({ "flutter.theme_mode": "dark" })).themeMode).toBe("dark");
  });

  it("缺失 theme_mode 时按既有 is_dark_mode 派生（旧配置平滑升级）", () => {
    expect(parsePrefs(JSON.stringify({ "flutter.is_dark_mode": true })).themeMode).toBe("dark");
    expect(parsePrefs(JSON.stringify({ "flutter.is_dark_mode": false })).themeMode).toBe("light");
  });

  it("非法 theme_mode 回落 is_dark_mode 派生", () => {
    const p = parsePrefs(JSON.stringify({ "flutter.theme_mode": "solarized", "flutter.is_dark_mode": false }));
    expect(p.themeMode).toBe("light");
  });

  it("dsblue 旧配置迁移为 dark（dsblue 主题已于 2026-10-06 撤下，本身是暗色主题）", () => {
    expect(parsePrefs(JSON.stringify({ "flutter.theme_mode": "dsblue" })).themeMode).toBe("dark");
  });

  it("往返保留 themeMode", () => {
    const p = parsePrefs(JSON.stringify({ "flutter.theme_mode": "light" }));
    expect(parsePrefs(serializePrefs(p)).themeMode).toBe("light");
  });

  it("默认强调色为「跟随主题」（ACCENT_AUTO=0；旧默认 DS 蓝/紫罗兰迁移为 0）", () => {
    expect(DEFAULT_PREFS.customAccentColor).toBe(ACCENT_AUTO);
    expect(parsePrefs(JSON.stringify({ "flutter.custom_accent_color": DS_BLUE_ARGB })).customAccentColor).toBe(ACCENT_AUTO);
    expect(parsePrefs(JSON.stringify({ "flutter.custom_accent_color": 4286343935 })).customAccentColor).toBe(ACCENT_AUTO);
    // 用户自选的灰阶值不被动
    expect(parsePrefs(JSON.stringify({ "flutter.custom_accent_color": 0xff8a919c })).customAccentColor).toBe(0xff8a919c);
  });
});

describe("配置序列化", () => {
  it("往返后语义一致（JSON 字段仍是字符串、novel_projects 仍是换行文本）", () => {
    const p = parsePrefs(REAL_SHAPE);
    const text = serializePrefs(p);
    const raw = JSON.parse(text) as Record<string, unknown>;
    expect(typeof raw["flutter.saved_providers"]).toBe("string");
    expect(raw["flutter.novel_projects"]).toBe("C:\\A\\书一\nC:\\A\\书二");
    expect(parsePrefs(text)).toEqual(p);
  });

  it("商业化键永不写出（即使源文件里有）", () => {
    const text = serializePrefs(parsePrefs(REAL_SHAPE));
    expect(text).not.toContain("vip_");
    expect(text).not.toContain("device_id");
    expect(text).not.toContain("SHOULD-NOT-LEAK");
  });

  it("写出的是单行 JSON", () => {
    const text = serializePrefs(DEFAULT_PREFS);
    expect(text.includes("\n")).toBe(false);
  });

  it("默认系统提示词非空且非照搬文案", () => {
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(30);
    expect(DEFAULT_SYSTEM_PROMPT).toContain("小说");
  });
});

describe("当前供应商判定", () => {
  it("baseUrl + model 同时匹配才算选中", () => {
    const p = parsePrefs(REAL_SHAPE);
    expect(activeProvider(p)?.name).toBe("示例供应商");
    const p2 = { ...p, model: "其他" };
    expect(activeProvider(p2)).toBeNull();
  });
});

describe("往返与容错回归锁（审计补强）", () => {
  it("tool_round_limit / max_output_tokens 可往返（回归锁：parsePrefs 曾漏读这两键，改后重启丢回默认）", () => {
    const p = parsePrefs(JSON.stringify({ "flutter.tool_round_limit": 20, "flutter.max_output_tokens": 8000 }));
    expect(p.toolRoundLimit).toBe(20);
    expect(p.maxOutputTokens).toBe(8000);
    const p2 = parsePrefs(serializePrefs(p));
    expect(p2.toolRoundLimit).toBe(20);
    expect(p2.maxOutputTokens).toBe(8000);
  });

  it("JSON 键形态不符回落默认值（数组键收到非数组 / 对象键收到数组）", () => {
    const p = parsePrefs(
      JSON.stringify({
        "flutter.skill_list": JSON.stringify({ bogus: 1 }),
        "flutter.active_skill_ids": JSON.stringify("不是数组"),
        "flutter.webdav_config": JSON.stringify([1, 2]),
      }),
    );
    expect(p.skillList).toEqual(DEFAULT_PREFS.skillList);
    expect(p.activeSkillIds).toEqual(DEFAULT_PREFS.activeSkillIds);
    expect(p.webdavConfig).toEqual(DEFAULT_PREFS.webdavConfig);
  });

  it("同步三键 UI 已下线但仍往返写出（磁盘契约：is_connected / webdav_config / webdav_sync_meta）", () => {
    const text = serializePrefs(parsePrefs(REAL_SHAPE));
    expect(text).toContain('"flutter.is_connected"');
    expect(text).toContain('"flutter.webdav_config"');
    expect(text).toContain('"flutter.webdav_sync_meta"');
  });

  it("platform_notice_dismissed 可往返（D-027 新增键：缺失/类型不符回落 false）", () => {
    const p = parsePrefs(JSON.stringify({ "flutter.platform_notice_dismissed": true }));
    expect(p.platformNoticeDismissed).toBe(true);
    expect(parsePrefs(serializePrefs(p)).platformNoticeDismissed).toBe(true);
    expect(parsePrefs("{}").platformNoticeDismissed).toBe(false);
    expect(parsePrefs(JSON.stringify({ "flutter.platform_notice_dismissed": "yes" })).platformNoticeDismissed).toBe(
      false,
    );
  });

  it("whale_idle_pause 可往返（D-030 新增键：缺失/类型不符回落 true —— 默认「闲置就停」）", () => {
    const p = parsePrefs(JSON.stringify({ "flutter.whale_idle_pause": false }));
    expect(p.whaleIdlePause).toBe(false);
    expect(parsePrefs(serializePrefs(p)).whaleIdlePause).toBe(false);
    // 老配置文件里没有这个键 → 默认开（鲸鱼闲置即停）
    expect(parsePrefs("{}").whaleIdlePause).toBe(true);
    expect(parsePrefs(JSON.stringify({ "flutter.whale_idle_pause": "no" })).whaleIdlePause).toBe(true);
  });
  it("welcome_dismissed 可往返(D-053 新增键:缺失/类型不符回落 false —— 默认会弹首启欢迎窗)", () => {
    const p = parsePrefs(JSON.stringify({ "flutter.welcome_dismissed": true }));
    expect(p.welcomeDismissed).toBe(true);
    expect(parsePrefs(serializePrefs(p)).welcomeDismissed).toBe(true);
    // 老配置没有这个键 → 默认 false(第一次启动要见到欢迎窗)
    expect(parsePrefs("{}").welcomeDismissed).toBe(false);
    expect(parsePrefs(REAL_SHAPE).welcomeDismissed).toBe(false);
    expect(parsePrefs(JSON.stringify({ "flutter.welcome_dismissed": "yes" })).welcomeDismissed).toBe(false);
    // 写出的键名逐字(snake_case + flutter. 前缀,与既有扩展键同一口径)
    expect(serializePrefs({ ...DEFAULT_PREFS, welcomeDismissed: true })).toContain('"flutter.welcome_dismissed":true');
  });
});

describe("供应商平台与具名配置（DeepCompose 扩展，DECISIONS D-006 / D-007）", () => {
  const CFG = JSON.stringify({
    "flutter.active_api_profile": "p-deepseek",
    "flutter.saved_providers": JSON.stringify([
      {
        id: "p-deepseek",
        name: "DeepSeek 主号",
        baseUrl: "https://api.deepseek.com",
        apiKey: "PLACEHOLDER",
        model: "deepseek-flash",
        useAnthropicFormat: false,
        platform: "deepseek",
        thinking: true,
        reasoningEffort: "high",
        reasoningReplay: "auto",
      },
      {
        name: "本地网关",
        baseUrl: "http://127.0.0.1:8899/v1",
        apiKey: "PLACEHOLDER",
        model: "local-model",
        useAnthropicFormat: false,
      },
    ]),
  });

  it("扩展字段全量往返（platform / thinking / reasoningEffort / reasoningReplay）", () => {
    const p = parsePrefs(CFG);
    expect(p.savedProviders[0].platform).toBe("deepseek");
    expect(p.savedProviders[0].thinking).toBe(true);
    expect(p.savedProviders[0].reasoningEffort).toBe("high");
    expect(p.savedProviders[0].reasoningReplay).toBe("auto");
    expect(p.activeApiProfile).toBe("p-deepseek");
    const back = parsePrefs(serializePrefs(p));
    expect(back.savedProviders).toEqual(p.savedProviders);
    expect(back.activeApiProfile).toBe("p-deepseek");
    expect(serializePrefs(p)).toContain('"flutter.active_api_profile"');
  });

  it("老条目缺扩展字段：补派生 id、按 baseUrl 推断平台，未知字段保留", () => {
    const p = parsePrefs(
      JSON.stringify({
        "flutter.saved_providers": JSON.stringify([
          {
            name: "公益模型",
            baseUrl: "https://a.example",
            apiKey: "k",
            model: "m1",
            useAnthropicFormat: false,
            vendorExtra: 42,
          },
          {
            name: "硅基",
            baseUrl: "https://api.siliconflow.cn/v1",
            apiKey: "k",
            model: "m2",
            useAnthropicFormat: false,
          },
        ]),
      }),
    );
    expect(p.savedProviders[0].id).toBe(deriveProfileId("公益模型", "https://a.example"));
    expect(p.savedProviders[0].platform).toBe("custom");
    expect((p.savedProviders[0] as unknown as Record<string, unknown>).vendorExtra).toBe(42);
    expect(p.savedProviders[1].platform).toBe("siliconflow");
    // 派生是纯函数：二次往返稳定，不会每次启动都换 id
    expect(parsePrefs(serializePrefs(p)).savedProviders).toEqual(p.savedProviders);
  });

  it("非法枚举值被丢弃（不把垃圾写回磁盘）", () => {
    const p = parsePrefs(
      JSON.stringify({
        "flutter.saved_providers": JSON.stringify([
          {
            name: "x",
            baseUrl: "https://x.example",
            apiKey: "",
            model: "m",
            useAnthropicFormat: false,
            platform: "openai",
            reasoningEffort: "ultra",
            reasoningReplay: 5,
            thinking: "yes",
          },
        ]),
      }),
    );
    const e = p.savedProviders[0] as unknown as Record<string, unknown>;
    expect(e.platform).toBe("custom");
    expect("reasoningEffort" in e).toBe(false);
    expect("reasoningReplay" in e).toBe(false);
    expect("thinking" in e).toBe(false);
  });

  it("非对象元素被丢弃（坏数据不进运行期）", () => {
    const p = parsePrefs(
      JSON.stringify({
        "flutter.saved_providers": JSON.stringify([
          "not-an-object",
          42,
          { name: "ok", baseUrl: "https://ok.example", apiKey: "", model: "m", useAnthropicFormat: false },
        ]),
      }),
    );
    expect(p.savedProviders).toHaveLength(1);
    expect(p.savedProviders[0].name).toBe("ok");
  });

  it("activeProfile 优先按 id 命中（改全局键不影响选中项）", () => {
    const p = parsePrefs(CFG);
    const p2 = { ...p, model: "被改过的模型" };
    expect(activeProfile(p2)?.name).toBe("DeepSeek 主号");
    expect(activeProfile(p2)?.id).toBe("p-deepseek");
  });

  it("active_api_profile 指向不存在的 id 时回退「baseUrl + model」旧语义", () => {
    const p = parsePrefs(CFG);
    const p2 = {
      ...p,
      activeApiProfile: "p-不存在",
      llmBaseUrl: "http://127.0.0.1:8899/v1",
      model: "local-model",
    };
    expect(activeProfile(p2)?.name).toBe("本地网关");
    expect(activeProfile({ ...p2, model: "不再匹配" })).toBeNull();
  });

  it("platformOf / nativeThinkingSupported：只有官方直连或显式声明才发思考参数", () => {
    const p = parsePrefs(CFG);
    expect(platformOf(p.savedProviders[0])).toBe("deepseek");
    expect(platformOf(p.savedProviders[1])).toBe("custom");
    expect(nativeThinkingSupported(p.savedProviders[0])).toBe(true);
    expect(nativeThinkingSupported(p.savedProviders[1])).toBe(false);
    expect(nativeThinkingSupported({ ...p.savedProviders[1], supportsThinking: true })).toBe(true);
  });

  it("deriveProfileId 稳定、可区分、形态固定", () => {
    expect(deriveProfileId("a", "b")).toBe(deriveProfileId("a", "b"));
    expect(deriveProfileId("a", "b")).not.toBe(deriveProfileId("a", "c"));
    expect(deriveProfileId("a", "b")).not.toBe(deriveProfileId("b", "a"));
    expect(deriveProfileId("a", "b")).toMatch(/^p[0-9a-f]{8}$/);
  });
});
