/**
 * 设置屏 —— TeachWrite「付印单」实色版。
 *
 * 结构:左侧实色导航(7 项:AI 提供商 / Skill / 参数 / 主题 / 数据 / 使用教程 / 关于)
 * + 右侧实色内容区（分组卡片）。
 * 主题页两套主题：曜石黑（dark）/ 晨雾白（light）（dsblue 已于 2026-10-06 撤下，
 * 用户裁决：只留黑白两色，黑白灰极简），外加强调色色板与字号调节
 * （既有实现键 chat_font_size / editor_font_size）。
 * 这两个主题键是**磁盘格式契约**（prefs 里的 theme_mode），不可改名。
 *
 * 只展示**已实现**的能力：未实现的同步/备份/导入导出等入口一律不存在，
 * 宁可少一个按钮，不给用户一个点了只会说"后续批次"的假按钮。
 *
 * 读取 prefs（boot() 装配），保存即写 shared_preferences.json（savePrefs）。
 * 材质配方在 styles/surface.css，布局与组件样式在 styles/app.css。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useMaximized } from "../ui/useMaximized";
import { useDialogFocus } from "../ui/useDialogFocus";
import { pushEsc } from "../ui/escStack";
import logo from "../assets/logo.png";
import { HelpTopics } from "../ui/HelpModal";
import { DOUYIN_LABEL, QQ_LABEL, authorStatement, openAuthorPage } from "../core/author";
import { applyAccentFromPrefs, currentBoot, savePrefs } from "../core/app";
import { ConfirmDialog, type ConfirmRequest } from "../ui/Dialogs";
import { fetchModels, filterModelOptions } from "../core/ai/models";
import { PLATFORM_PRESETS, platformLabel, platformSupportsBalance, platformSupportsThinking, presetOf } from "../core/ai/platforms";
import { NOTICE_BUBBLE_MS, platformNoticeFor, type PlatformNotice } from "../core/ai/platformNotice";
import {
  isActiveProfile,
  platformPatch,
  profileFromPrefs,
  profilePatch,
  removeProfile,
  suggestProfileName,
  upsertProfile,
} from "../core/ai/profiles";
import { getFs } from "../core/fsbridge";
import { isDriveRoot, isSystemEntryName } from "../core/dirs";
import {
  ACCENT_AUTO,
  platformOf,
  platformOfUrl,
  type Prefs,
  type Provider,
  type ProviderPlatform,
  type ThemeMode,
} from "../core/prefs";

type NavSection = "provider" | "skill" | "params" | "theme" | "data" | "help" | "about";

/** 强调色色板（2026-10-06 起全灰阶，用户裁决「黑白灰极简」）：
 *  0 = 跟随主题（暗色主题近白墨、浅色主题近黑墨；解析与应用在 core/app.ts） */
const ACCENT_SWATCHES = [
  { argb: ACCENT_AUTO, label: "跟随主题" },
  { argb: 0xffffffff, label: "纸白" },
  { argb: 0xffc7cbd3, label: "浅灰" },
  { argb: 0xff8a919c, label: "中灰" },
  { argb: 0xff4e5560, label: "深灰" },
  { argb: 0xff14171b, label: "近黑" },
];

/** 两套实色主题（theme_mode 扩展键；键值是磁盘契约，只能改展示名不能改值） */
const THEME_MODES: { mode: ThemeMode; label: string; preview: string }[] = [
  { mode: "light", label: "晨雾白", preview: "t-light" },
  { mode: "dark", label: "曜石黑", preview: "t-dark" },
];

/** 数字输入守卫：空串/非法中间态返回 null（保持原值，不打断输入），合法则原样返回。
 *  修的是旧实现 `parseInt(v) || 默认值` 的老 bug —— 输入 0 或清空会被立刻弹回默认值。 */
function numGuard(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 夹到闭区间（失焦兜底用） */
function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * 数字输入（N-20 / B-5）：本地持有原始文本，"0."、"1."、结尾 "-" 这类输入
 * 中间态不被当场 clamp 吞掉（受控 value 立即回写会把小数点顶掉，用户再敲
 * 数字就落到错误基数上）。文本一旦构成完整数字就**即时提交**（防抖自动保存
 * 依赖「变更即时生效」，不能等失焦）；失焦时强制归一（clamp + 回显合法值，
 * 空/非法回退当前值）。B-5：min/max 同时作为提交钳制与 spinner 边界，
 * 所有数字字段从此都有上界。
 *
 * unit：显示值 = 真实值 / unit，提交值 = 数字 × unit（K 单位字段用 1000）。
 * round：false 允许小数（温度）；true 四舍五入（其余字段均为整数语义）。
 */
function NumInput({
  value,
  min,
  max,
  step,
  unit = 1,
  round = true,
  className = "a-form-input a-num",
  onCommit,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: number;
  round?: boolean;
  className?: string;
  onCommit: (n: number) => void;
  ariaLabel?: string;
}) {
  // null = 跟随 value 回显；非 null = 用户正在输入（本地文本优先）
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? String(value / unit);
  const commit = (raw: string) => {
    const v = numGuard(raw);
    if (v === null) return;
    onCommit(clamp(round ? Math.round(v) : v, min, max) * unit);
  };
  return (
    <input
      className={className}
      type="number"
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      value={shown}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        // 中间态不提交：空串（number 输入的 badInput 也回 ""）、结尾小数点、孤立负号
        if (raw === "" || raw.endsWith(".") || raw === "-") return;
        commit(raw);
      }}
      onBlur={() => {
        if (text !== null && text !== "") commit(text);
        setText(null);
      }}
    />
  );
}

interface Props {
  onBack: () => void;
}

export default function SettingsScreen({ onBack }: Props) {
  const boot = currentBoot();
  const [section, setSection] = useState<NavSection>("provider");
  /**
   * 分节切换的推入方向：+1 = 往下走（新分节从右推入），-1 = 往上走（从左推入）。
   * 方向在点击那一刻算好（与 setSection 同批更新），这样运动会和导航方向
   * 一致 —— 空间一致是转场可读的前提，方向错了会让人以为"跳回去了"。
   */
  const [paneDir, setPaneDir] = useState(1);
  const [form, setForm] = useState<Prefs>(() => ({
    ...(boot?.prefs ?? ({} as Prefs)),
  }));
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [flash, setFlash] = useState(""); // 各分页的操作即时反馈（不落盘）
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const win = getCurrentWindow();
  const maxed = useMaximized();

  // C-6：原先这里有 `if (!boot)` 的「配置未加载」兜底屏，但该分支按其自身注释
  // 即不可达 —— boot 失败时 MainWorkbench 渲染自己的「启动失败」屏且不暴露齿轮
  // 入口，设置屏永远拿得到装配结果。死分支已删；`boot?.prefs` 在 form 初始化处
  // 本就是 null 安全的，各分节对 dirs 也都有 `boot?.dirs` 判空。

  /* ── 自动保存（修复"API 设置疑似不自动保存 / 有时保存错误"）──
     纪律：update/patch 只标脏，落盘走唯一出口 doSave(formRef.current) ——
     formRef 永远指向最新表单，手动保存、防抖保存、卸载兜底保存拿到的
     都是同一份最新值，不存在"保存的是上一次渲染的旧表单"这条路径。 */
  const formRef = useRef(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  /** 唯一落盘出口：immediate=true 为手动「保存」/Ctrl+S，否则为防抖自动保存 */
  const doSave = useCallback(async (immediate: boolean) => {
    // N-22 附带护栏：boot 未装配（正常流程到不了这里）时不落盘 ——
    // form 会是 `{} as Prefs` 的残缺表单，写出去等于把真实配置清成默认值
    if (!currentBoot()) return;
    setSaving(true);
    try {
      await savePrefs(formRef.current);
      dirtyRef.current = false;
      setDirty(false);
      setSaveMsg(immediate ? "配置已保存" : "已自动保存");
    } catch (e) {
      setSaveMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, []);

  // 防抖自动保存：最后一次改动 900ms 后落盘（连续输入不会每键一次写盘）
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void doSave(false), 900);
    return () => clearTimeout(t);
  }, [form, dirty, doSave]);

  // 离开设置页（卸载/Esc 返回）时兜底：防抖窗口内的最后改动不能丢
  useEffect(
    () => () => {
      if (dirtyRef.current) void doSave(false);
    },
    [doSave],
  );

  const update = <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaveMsg("");
  };

  /**
   * 多键一次性更新：平台切换 / 应用具名配置这类"要么全改、要么全不改"的动作走这里。
   * 与 update 一样是函数式更新，因此同一批里连续调用不会互相覆盖。
   */
  const patch = useCallback((p: Partial<Prefs>) => {
    setForm((prev) => ({ ...prev, ...p }));
    setDirty(true);
    setSaveMsg("");
  }, []);

  /**
   * 连接检测拉到清单后的「首次便利选择」：当前确实未选模型时才填第一个。
   * 必须走函数式更新读最新 form —— 检测请求在途时用户可能已手选模型，
   * detect 的闭包里那份旧 form 拿来做判空会把手选值覆盖掉（N-24）。
   */
  const ensureModel = useCallback((m: string) => {
    if (formRef.current.model?.trim()) return;
    setForm((prev) => (prev.model?.trim() ? prev : { ...prev, model: m }));
    dirtyRef.current = true; // 立即置位：防抖/卸载兜底读的都是 dirtyRef
    setDirty(true);
    setSaveMsg("");
  }, []);

  /**
   * Skill 开关（C-2）：走统一管道 —— 改 form、立即落盘**同步算好的最新表单**。
   * 开关是有"即时生效"预期的操作，不等 900ms 防抖；这里直接以 formRef 为源
   * 计算下一份表单并同步写回 formRef（不能等下一轮渲染，否则紧随其后的落盘
   * 会拿到旧值）。失败则重新置脏，交给防抖管道重试。
   */
  const toggleSkill = useCallback(async (id: string) => {
    const cur = formRef.current.activeSkillIds ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    const nextForm: Prefs = { ...formRef.current, activeSkillIds: next };
    formRef.current = nextForm;
    setForm(nextForm);
    setSaveMsg("");
    try {
      await savePrefs(nextForm);
      dirtyRef.current = false;
      setDirty(false);
      setFlash("");
    } catch (e) {
      dirtyRef.current = true;
      setDirty(true);
      setFlash(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const handleSave = async () => {
    await doSave(true);
  };

  /**
   * 「重置数据」后同步本地表单：重置已把默认配置写盘，若不同步 form/清 dirty，
   * 之后任何一次防抖/卸载兜底保存都会把**重置前的整份旧表单**写回磁盘 ——
   * 重置被静默回滚（连 API Key 都"复活"）。
   */
  const handleResetSync = (next: Prefs) => {
    setForm(next);
    formRef.current = next; // 卸载兜底读的是 formRef：必须立即同步，不能等下一轮渲染
    dirtyRef.current = false;
    setDirty(false);
  };

  /** 数据页改存储路径：立即写盘并重推进程内目录（返回主界面即按新路径装配） */
  const handlePathsChange = async (next: Prefs) => {
    setForm(next);
    try {
      await savePrefs(next);
      setFlash("已保存，返回主界面即按新路径生效");
    } catch (e) {
      setFlash(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** 切换主题：即时生效 + 立即持久化。 */
  const applyThemeMode = (mode: ThemeMode) => {
    const next: Prefs = {
      ...form,
      themeMode: mode,
      isDarkMode: mode !== "light",
    };
    setForm(next);
    document.documentElement.dataset.theme = mode;
    applyAccentFromPrefs(next);
    void savePrefs(next);
    setSaveMsg("");
  };

  /** 切换强调色：即时生效 + 立即持久化 */
  const applyAccent = (argb: number) => {
    const next: Prefs = { ...form, customAccentColor: argb };
    setForm(next);
    applyAccentFromPrefs(next);
    void savePrefs(next);
    setSaveMsg("");
  };

  // Ctrl+S 保存（既有实现参数页口径：参数保存后立即生效，也可以按 Ctrl+S 保存）。
  // preventDefault 只在确有「保存」动作的分页执行：Skill/数据/关于三页没有保存语义，
  // 无条件吞掉会让 Ctrl+S 在那里"静默失灵"（C-5）。依赖数组补齐，不再每渲染重挂监听。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        if (section === "provider" || section === "params" || section === "theme") {
          e.preventDefault();
          void doSave(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [section, doSave]);

  const askConfirm = useCallback(
    (title: string, body?: string, opts?: { danger?: boolean; confirmLabel?: string }) =>
      new Promise<boolean>((resolve) => {
        setConfirmReq({ title, body, ...opts, resolve });
      }),
    [],
  );

  /** 左侧导航项（图标为自绘内联 SVG，零图标依赖） */
  const navItems: { key: NavSection; label: string; icon: ReactElement }[] = [
    {
      key: "provider",
      label: "AI 提供商",
      icon: (
        <svg viewBox="0 0 20 20" className="ic">
          <rect x="2.5" y="4" width="15" height="12" rx="2.5" />
          <path d="M2.5 8.5h15" />
        </svg>
      ),
    },
    {
      key: "skill",
      label: "Skill",
      icon: (
        <svg viewBox="0 0 20 20" className="ic">
          <path d="M10 2.6l2.3 4.7 5.2.75-3.75 3.65.9 5.2L10 14.4l-4.65 2.5.9-5.2L2.5 8.05l5.2-.75L10 2.6z" />
        </svg>
      ),
    },
    {
      key: "params",
      label: "参数",
      icon: (
        <svg viewBox="0 0 20 20" className="ic">
          <path d="M3 5.5h6M13 5.5h4M3 14.5h4M11 14.5h6" />
          <circle cx="11" cy="5.5" r="1.9" />
          <circle cx="9" cy="14.5" r="1.9" />
        </svg>
      ),
    },
    {
      key: "theme",
      label: "主题",
      icon: (
        <svg viewBox="0 0 20 20" className="ic">
          <path d="M10 3a7 7 0 1 0 0 14c1 0 1.6-.7 1.6-1.5 0-.45-.2-.8-.5-1.1-.3-.3-.45-.65-.45-1.1 0-.8.7-1.45 1.55-1.45h1.35c1.4 0 2.45-1.1 2.45-2.45C16 6.4 13.3 3 10 3z" />
          <circle cx="7" cy="8.4" r="1" className="ic-fill" stroke="none" />
          <circle cx="10.6" cy="6.6" r="1" className="ic-fill" stroke="none" />
        </svg>
      ),
    },
    {
      key: "data",
      label: "数据",
      icon: (
        <svg viewBox="0 0 20 20" className="ic">
          <ellipse cx="10" cy="5.4" rx="6.5" ry="2.6" />
          <path d="M3.5 5.4v9.2c0 1.44 2.9 2.6 6.5 2.6s6.5-1.16 6.5-2.6V5.4" />
          <path d="M3.5 10c0 1.44 2.9 2.6 6.5 2.6s6.5-1.16 6.5-2.6" />
        </svg>
      ),
    },
    {
      key: "help",
      label: "使用教程",
      icon: (
        <svg viewBox="0 0 20 20" className="ic">
          <path d="M3.4 3.6h5.1c.9 0 1.5.6 1.5 1.4v10c0-.7-.6-1.2-1.4-1.2H3.4z" />
          <path d="M16.6 3.6h-5.1c-.9 0-1.5.6-1.5 1.4v10c0-.7.6-1.2 1.4-1.2h5.2z" />
        </svg>
      ),
    },
    {
      key: "about",
      label: "关于",
      icon: (
        <svg viewBox="0 0 20 20" className="ic">
          <circle cx="10" cy="10" r="7.5" />
          <path d="M10 13.6v.05" />
          <path d="M7.9 7.8a2.1 2.1 0 1 1 2.9 1.95c-.55.24-.8.6-.8 1.2" />
        </svg>
      ),
    },
  ];

  return (
    <div className="win" id="screenA">
      {/* ── 标题栏 ── */}
      <div
        className="titlebar"
        onMouseDown={(e) => {
          // 标题栏空白处按住拖动（按钮除外）；Tauri 的 drag-region 属性在本构建未生效，改用显式 API
          if (e.button !== 0) return;
          const el = e.target as HTMLElement;
          if (el.closest("button")) return;
          void win.startDragging();
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          void win.toggleMaximize();
        }}
      >
        <div className="brand">
          <div className="brand-mark app-mark"><img src={logo} alt="" /></div>
          <div className="brand-name">TeachWrite</div>
        </div>
        <div className="win-tools">
          {/* 自绘窗控——仅 Windows；macOS 用系统原生三键（见 app.css 的
              html[data-os="macos"] .win-ctrls 规则） */}
          <span className="win-ctrls">
            <button className="wbtn" title="最小化" onClick={() => void win.minimize()}>
              <svg viewBox="0 0 20 20" className="ic"><path d="M5 10h10" /></svg>
            </button>
            <button
              className="wbtn"
              title={maxed ? "向下还原" : "最大化"}
              aria-label={maxed ? "向下还原" : "最大化"}
              onClick={() => void win.toggleMaximize()}
            >
              {maxed ? (
                <svg viewBox="0 0 20 20" className="ic">
                  <rect x="3.4" y="6.6" width="10" height="10" rx="2" />
                  <path d="M6.6 6.6V5.4a2 2 0 0 1 2-2h5.8a2 2 0 0 1 2 2v5.8a2 2 0 0 1-2 2h-1.2" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" className="ic">
                  <rect x="4" y="4.5" width="11" height="11" rx="2" />
                </svg>
              )}
            </button>
            <button className="wbtn close" title="关闭" onClick={() => void win.close()}>
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
              </svg>
            </button>
          </span>
        </div>
      </div>

      {/* ── 主体：实色侧栏导航 + 实色内容区 ── */}
      <div className="a-main">
        <div className="a-nav surface-rail">
          <div className="a-nav-head">
            <button className="a-back" title="返回主界面" onClick={onBack}>
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M11.5 4.5L6 10l5.5 5.5" />
              </svg>
            </button>
            <div className="a-nav-title">设置</div>
          </div>
          <div className="a-nav-items">
            {navItems.map((item) => (
              <button
                key={item.key}
                className={`a-nav-item ${section === item.key ? "on" : ""}`}
                onClick={() => {
                  if (item.key !== section) {
                    const from = navItems.findIndex((n) => n.key === section);
                    const to = navItems.findIndex((n) => n.key === item.key);
                    setPaneDir(to >= from ? 1 : -1);
                  }
                  setSection(item.key);
                  setFlash("");
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="a-content surface-sheet">
          {/* key 换 → 分节重新挂载并播放推入动画；方向由导航顺序决定 */}
          <div key={section} className="a-pane" data-dir={paneDir}>
            {section === "provider" && (
              <ProviderSection
                form={form}
                update={update}
                patch={patch}
                askConfirm={askConfirm}
                ensureModel={ensureModel}
                saving={saving}
                saveMsg={saveMsg}
                onSave={handleSave}
              />
            )}
            {section === "skill" && (
              <SkillSection form={form} flash={flash} onToggle={(id) => void toggleSkill(id)} />
            )}
            {section === "params" && (
              <ParamsSection form={form} update={update} saving={saving} saveMsg={saveMsg} onSave={handleSave} />
            )}
            {section === "theme" && (
              <ThemeSection
                form={form}
                update={update}
                flash={flash}
                onThemeMode={applyThemeMode}
                onAccent={applyAccent}
                saving={saving}
                saveMsg={saveMsg}
                onSave={handleSave}
              />
            )}
            {section === "data" && (
              <DataSection
                form={form}
                flash={flash}
                onFlash={setFlash}
                askConfirm={askConfirm}
                onPathsChange={handlePathsChange}
                onReset={handleResetSync}
              />
            )}
              {section === "help" && <HelpTopics compact onStatus={setFlash} />}
            {section === "about" && <AboutSection />}
          </div>
        </div>
      </div>

      <ConfirmDialog req={confirmReq} />
    </div>
  );
}

/* ── AI 提供商配置分节（平台预设 + 具名配置 + 连接检测） ── */

/** 密钥遮罩：只露头尾。星号数固定，不按真实长度画（长度本身也是信息） */
function maskKey(key: string): string {
  const k = key.trim();
  if (k === "") return "未填写";
  if (k.length <= 8) return "sk-****";
  return `${k.slice(0, 5)}****${k.slice(-4)}`;
}

function ProviderSection({
  form,
  update,
  patch,
  askConfirm,
  ensureModel,
  saving,
  saveMsg,
  onSave,
}: {
  form: Prefs;
  update: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  patch: (p: Partial<Prefs>) => void;
  askConfirm: (title: string, body?: string, opts?: { danger?: boolean; confirmLabel?: string }) => Promise<boolean>;
  /** 检测拉到清单后的首次便利选择（函数式判空，见父级注释） */
  ensureModel: (m: string) => void;
  saving: boolean;
  saveMsg: string;
  onSave: () => void;
}) {
  /**
   * 「当前平台」的判定：本会话里显式点过的平台优先，否则由地址推断
   * （与落库 `normalizeProvider` 的推断同一条规则）。手改地址会把显式选择清掉，
   * 交回推断 —— 否则会出现"地址已是自定义端点、界面却还高亮 DeepSeek"的谎报。
   */
  const [chosen, setChosen] = useState<ProviderPlatform | null>(null);
  const current = chosen ?? platformOfUrl(form.llmBaseUrl);
  const preset = presetOf(current);

  const [conn, setConn] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [connMsg, setConnMsg] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [showKey, setShowKey] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [localMsg, setLocalMsg] = useState("");
  const [notice, setNotice] = useState<PlatformNotice | null>(null);
  const [pendingPlatform, setPendingPlatform] = useState<ProviderPlatform | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  /** 连接检测的请求序号：只认最新一次，旧响应迟到即丢弃 */
  const detectSeq = useRef(0);
  // N-25：确认弹窗形态的平台提示要接管焦点（移入 + Tab 循环 + 关闭归还），
  // 否则焦点还留在触发按钮上，Tab 会走进遮罩背后的表单
  const noticePanelRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus(notice?.kind === "dialog", noticePanelRef);

  // 提示生命周期：气泡 2.5–3s 自动消失（D-022）；确认弹窗等用户选择，Esc 视为"保留当前选择"
  useEffect(() => {
    if (!notice) return;
    if (notice.kind === "bubble") {
      const t = setTimeout(() => setNotice(null), NOTICE_BUBBLE_MS);
      return () => clearTimeout(t);
    }
    // escStack：叠层时一次 Esc 只关最上层（N-17）；组词中的 Esc 不算
    return pushEsc(closeNotice);
    // closeNotice 是当次渲染的闭包，依赖 notice 即可（每开一次弹窗重挂一次）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice]);

  const detect = async () => {
    if (!form.llmBaseUrl?.trim() || !form.apiKey?.trim()) {
      setConn("error");
      setConnMsg("请先填写接口地址与 API Key");
      return;
    }
    // 请求序号（N-24）：慢的旧响应迟到时不许覆盖新状态与手选模型
    const seq = ++detectSeq.current;
    setConn("testing");
    setConnMsg("");
    try {
      const list = await fetchModels(form.llmBaseUrl.trim(), form.apiKey.trim(), form.useAnthropicFormat);
      if (seq !== detectSeq.current) return;
      setModels(list);
      setConn(list.length > 0 ? "ok" : "error");
      setConnMsg(list.length > 0 ? `连接正常，获取到 ${list.length} 个模型` : "连接正常，但端点未返回模型清单");
      // 首次配置便利：当前未选模型时自动选第一个（函数式判空，见 ensureModel 注释）
      if (list.length > 0) ensureModel(list[0]);
    } catch (e) {
      if (seq !== detectSeq.current) return;
      setConn("error");
      setConnMsg(String(e instanceof Error ? e.message : e));
    }
  };

  // 端点信息变化时重置检测结果；两者齐全时自动检测一次。
  // C-1 收口：自动检测只对「未动过的 Key」放行 —— 键入中的半截 Key 不发往上游
  //（手动「检测连接」不受限）。stableKey 在挂载时定格，Key 的任何变化都视为
  // "正在编辑/刚换过"，之后由用户显式点检测；地址/协议变化仍自动复检（那才是
  // 这条自动路径的本意：换了端点提醒你确认连通性）。
  const stableKeyRef = useRef(form.apiKey);
  useEffect(() => {
    setConn("idle");
    setConnMsg("");
    setModels([]);
    if (form.apiKey === stableKeyRef.current && form.llmBaseUrl?.trim() && form.apiKey?.trim()) {
      const t = setTimeout(() => void detect(), 600);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.llmBaseUrl, form.apiKey, form.useAnthropicFormat]);

  /** 选中平台：内置地址随平台填入（自定义平台保留已填地址，交给用户改），再按 D-022 提示 */
  const choosePlatform = (next: ProviderPlatform) => {
    const diff = platformPatch(next, presetOf(next), form);
    if (Object.keys(diff).length > 0) patch(diff);
    setChosen(next);
    setProfileName(suggestProfileName(form.savedProviders, next));
    setLocalMsg("");
    const n = platformNoticeFor(next, form.platformNoticeDismissed);
    if (!n) return;
    if (n.kind === "bubble") {
      setNotice(n);
      return;
    }
    setPendingPlatform(next);
    setNotice(n);
  };

  /** 关掉提示：只做「不再提示」的落位，不改平台选择（点过平台就算选过了） */
  const closeNotice = () => {
    if (dontAskAgain && !form.platformNoticeDismissed) patch({ platformNoticeDismissed: true });
    setNotice(null);
    setPendingPlatform(null);
    setDontAskAgain(false);
  };

  /** 弹窗里的「换回 DeepSeek」：地址与协议一并拨回官方 */
  const revertToDeepSeek = () => {
    const diff = platformPatch("deepseek", presetOf("deepseek"), form);
    if (Object.keys(diff).length > 0) patch(diff);
    setChosen("deepseek");
    setProfileName(suggestProfileName(form.savedProviders, "deepseek"));
    closeNotice();
  };

  /** 保存为新档位（档位名即身份：id 由 name + baseUrl 派生，改名 = 另存一条） */
  const saveAsNew = () => {
    const name = profileName.trim() === "" ? suggestProfileName(form.savedProviders, current) : profileName.trim();
    const entry = profileFromPrefs(form, name);
    const next = upsertProfile(form.savedProviders, entry);
    if (next === form.savedProviders) {
      setLocalMsg("请先填写接口地址");
      return;
    }
    patch({ savedProviders: next, activeApiProfile: entry.id ?? "" });
    setProfileName("");
    setLocalMsg(`已保存「${name}」`);
  };

  /** 用当前表单值覆盖某条档位（id 强行沿用旧值，否则改了地址会变成"另存一条"） */
  const overwriteProfile = (p: Provider) => {
    const entry: Provider = { ...profileFromPrefs(form, p.name), id: p.id };
    const next = upsertProfile(form.savedProviders, entry);
    if (next === form.savedProviders) {
      setLocalMsg("请先填写接口地址");
      return;
    }
    patch({ savedProviders: next, activeApiProfile: entry.id ?? "" });
    setLocalMsg(`已用当前值覆盖「${p.name}」`);
  };

  /** 应用某条档位（写回全局键，并把 activeApiProfile 指向它） */
  const applyEntry = (p: Provider) => {
    patch(profilePatch(p));
    setChosen(null);
    setLocalMsg(`已切换到「${p.name}」（改动会自动保存）`);
  };

  /** 删除某条档位（只删本地配置，不碰任何作品文件） */
  const deleteProfile = async (p: Provider) => {
    const ok = await askConfirm(`删除配置「${p.name}」？`, "只删除这条本地接口配置，不影响作品文件与会话记录。", {
      danger: true,
      confirmLabel: "删除",
    });
    if (!ok) return;
    patch({
      savedProviders: removeProfile(form.savedProviders, p.id ?? ""),
      activeApiProfile: form.activeApiProfile === p.id ? "" : form.activeApiProfile,
    });
    setLocalMsg(`已删除「${p.name}」`);
  };

  // 模型输入提示：预设建议 + 实测清单去重（真实清单以「检测连接」为准，D-008）
  const modelOptions = Array.from(new Set([...preset.suggestedModels, ...models]));
  // 该平台没有 Anthropic 端点时禁用该协议（留着必然 404，见 KL-DF-04）；自定义平台不拦
  const anthropicUnavailable = current !== "custom" && preset.anthropicBaseUrl === "";
  // 官方直连选了 Anthropic 协议但地址还是 OpenAI 端点时给出「改用 Anthropic 端点」的一键纠正
  const anthropicEndpointMismatch =
    current === "deepseek" && form.useAnthropicFormat && !form.llmBaseUrl.includes("/anthropic");

  return (
    <div className="a-settings-panel">
      {/* 平台：三个内置入口，地址内置（可改）；点选即填，并按 D-022 给出提示 */}
      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">平台</span>
          <span className="a-card-side">{platformLabel(current)}</span>
        </div>
        <div className="a-card-desc">
          内置接口地址随平台自动填入（仍可改）。DeepSeek 官方直连可使用思考模式、余额查询与用量统计。
        </div>
        <div className="a-platform-grid" role="radiogroup" aria-label="平台">
          {PLATFORM_PRESETS.map((p) => {
            const on = current === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={on}
                className={`a-platform-tile ${on ? "on" : ""}`}
                onClick={() => choosePlatform(p.id)}
              >
                <span className="a-platform-name">{p.label}</span>
                <span className="a-platform-hint">{p.hint}</span>
                <span className="a-platform-url">{p.baseUrl || "自填端点"}</span>
              </button>
            );
          })}
        </div>
        <div className="a-cap-row">
          <span className={`d-badge ${platformSupportsThinking(current) ? "ok" : "off"}`}><i />思考模式</span>
          <span className={`d-badge ${platformSupportsBalance(current) ? "ok" : "off"}`}><i />余额查询</span>
          <span className="d-badge ok"><i />用量统计</span>
        </div>
      </div>

      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">接入参数</span>
          {conn === "ok" ? (
            <span className="d-badge ok"><i />已连接</span>
          ) : conn === "testing" ? (
            <span className="d-badge off"><i />检测中…</span>
          ) : conn === "error" ? (
            <span className="d-badge bad"><i />连接失败</span>
          ) : (
            <span className="d-badge off"><i />未检测</span>
          )}
          <button className="a-toolbtn" style={{ marginLeft: 8 }} onClick={() => void detect()} disabled={conn === "testing"}>
            {conn === "testing" ? "检测中…" : "检测连接"}
          </button>
          <span className="a-card-side">{form.model?.trim() || "未选择模型"}</span>
        </div>
        {connMsg ? (
          <div className={conn === "error" ? "a-flash error" : "a-flash ok"} role="status">{connMsg}</div>
        ) : null}
        <div className="a-card-desc">
          填好地址与 Key 后会自动检测连接并拉取模型清单，也可以手动检测。所有改动都会自动保存，也可点下方「保存」立即生效。
        </div>

        <div className="a-form-row">
          <label className="a-form-label">
            接口地址（Base URL）
            {preset.baseUrl && form.llmBaseUrl === preset.baseUrl ? (
              <span className="a-model-hint">（{platformLabel(current)} 内置地址）</span>
            ) : null}
          </label>
          <input
            className="a-form-input"
            type="text"
            placeholder="https://api.deepseek.com"
            value={form.llmBaseUrl}
            onChange={(e) => {
              // 手改地址即放弃「显式平台选择」，交回地址推断，避免界面高亮与地址不符
              setChosen(null);
              update("llmBaseUrl", e.target.value);
            }}
            spellCheck={false}
          />
        </div>

        <div className="a-form-row">
          <label className="a-form-label">API Key</label>
          <div className="a-key-row">
            <input
              className="a-form-input"
              type={showKey ? "text" : "password"}
              placeholder="sk-..."
              value={form.apiKey}
              onChange={(e) => update("apiKey", e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <button type="button" className="a-toolbtn" aria-pressed={showKey} onClick={() => setShowKey((v) => !v)}>
              {showKey ? "隐藏" : "显示"}
            </button>
          </div>
          <div className="a-key-mask">当前：{maskKey(form.apiKey)}</div>
        </div>

        <div className="a-form-row">
          <label className="a-form-label">
            模型{models.length > 0 ? <span className="a-model-hint">（检测到 {models.length} 个，点开下拉选择）</span> : null}
          </label>
          {/* 只能选、不能手填（用户裁决）：手填与已选值混在一起时，"当前到底
              用的是哪个模型"要靠猜；点选则永远确定。清单来自预设建议 +
              「检测连接」实测拉取，长清单在弹层内可滚动、可按子串筛选。
              不用原生 datalist：WebView2 里弹层高度不受控、只按前缀过滤，
              长清单显示不全（用户实测"选项堆叠、模型多了看不清"）。 */}
          <ModelSelect
            value={form.model}
            options={modelOptions}
            onChange={(v) => update("model", v)}
          />
        </div>

        <div className="a-form-row a-form-row-inline">
          <div className="a-form-col">
            <label className="a-form-label">温度</label>
            {/* 旧实现 `parseFloat(v) || 0.8`：输入 0 或清空都会被弹回 0.8。
                NumInput：空串/非法中间态不提交；越界值**当场**夹回 [0,2] —— 只等
                onBlur 夹取的话，900ms 防抖自动保存会抢先把非法温度落盘（之后每次
                生成请求都带非法 temperature，全部报错）。 */}
            <NumInput
              value={form.temperature}
              min={0}
              max={2}
              step={0.1}
              round={false}
              ariaLabel="温度"
              onCommit={(n) => update("temperature", n)}
            />
            {platformSupportsThinking(current) ? (
              <div className="a-form-row-note">思考模式下温度不生效（官方规则）。</div>
            ) : null}
          </div>
          <div className="a-form-col">
            <label className="a-form-label">协议格式</label>
            <div className="a-form-toggle">
              <button
                className={`a-toggle-btn ${!form.useAnthropicFormat ? "on" : ""}`}
                onClick={() => update("useAnthropicFormat", false)}
              >
                OpenAI
              </button>
              <button
                className={`a-toggle-btn ${form.useAnthropicFormat ? "on" : ""}`}
                onClick={() => update("useAnthropicFormat", true)}
                disabled={anthropicUnavailable}
                title={anthropicUnavailable ? `${platformLabel(current)} 未确认 Anthropic 端点` : undefined}
              >
                Anthropic
              </button>
            </div>
            {anthropicUnavailable ? (
              <div className="a-form-row-note">该平台未确认 Anthropic 端点，需切到「自定义 API」自填。</div>
            ) : null}
            {anthropicEndpointMismatch ? (
              <div className="a-form-row-note">
                选了 Anthropic 协议，地址却还是 OpenAI 端点。
                <button type="button" className="a-linkbtn" onClick={() => update("llmBaseUrl", preset.anthropicBaseUrl)}>
                  改用 {preset.anthropicBaseUrl}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* 具名配置：保存多条 url + key 并一键切换（D-007） */}
      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">具名配置</span>
          <span className="a-card-side">{form.savedProviders.length} 条</span>
        </div>
        <div className="a-card-desc">
          把当前地址与 Key 存成一条命名配置，之后点「应用」即可切换。档位名即身份：改名会另存为新档位。
        </div>
        {form.savedProviders.length === 0 ? (
          <div className="a-empty-line">还没有已保存的配置。</div>
        ) : (
          <div className="a-profile-list">
            {form.savedProviders.map((p) => {
              const on = isActiveProfile(form, p);
              return (
                <div key={p.id ?? p.name} className={`a-profile-row ${on ? "on" : ""}`}>
                  <div className="a-profile-main">
                    <div className="a-profile-name">
                      {p.name}
                      {on ? <span className="a-profile-tag">当前</span> : null}
                    </div>
                    <div className="a-profile-meta">
                      {platformLabel(platformOf(p))} · {p.model || "未选模型"} · {maskKey(p.apiKey)} ·{" "}
                      {p.useAnthropicFormat ? "Anthropic" : "OpenAI"}
                    </div>
                  </div>
                  <div className="a-profile-actions">
                    <button type="button" className="a-toolbtn" disabled={on} onClick={() => applyEntry(p)}>
                      应用
                    </button>
                    <button type="button" className="a-toolbtn" onClick={() => overwriteProfile(p)}>
                      用当前值覆盖
                    </button>
                    <button type="button" className="a-toolbtn danger" onClick={() => void deleteProfile(p)}>
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="a-form-row a-form-row-inline">
          <div className="a-form-col grow">
            <label className="a-form-label">配置名</label>
            <input
              className="a-form-input"
              type="text"
              value={profileName}
              placeholder={suggestProfileName(form.savedProviders, current)}
              onChange={(e) => setProfileName(e.target.value)}
              spellCheck={false}
            />
          </div>
          <button type="button" className="a-toolbtn" onClick={saveAsNew} disabled={!form.llmBaseUrl.trim()}>
            保存为新配置
          </button>
        </div>
        <div className="a-form-row-note">具名配置的增删改与切换都只改本地配置，会自动保存写盘。</div>

        <div className="a-form-actions">
          <button className="a-btn-primary" onClick={onSave} disabled={saving}>
            {saving ? "保存中..." : "保存"}
          </button>
          {saveMsg && (
            <span className={`a-save-msg ${saveMsg.includes("失败") ? "error" : ""}`}>{saveMsg}</span>
          )}
          {localMsg && <span className="a-save-msg">{localMsg}</span>}
        </div>
      </div>

      {/* 平台提示（D-022）：DeepSeek = 非阻塞气泡；第三方 = 确认弹窗 + 「不再提示」 */}
      {notice?.kind === "bubble" ? (
        <div className="a-notice-bubble" role="status">
          {notice.text}
        </div>
      ) : null}
      {notice?.kind === "dialog" ? (
        <div
          className="qmodal scrim"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeNotice();
          }}
        >
          <div
            ref={noticePanelRef}
            className="qbox surface-raised sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="kc-platform-notice"
            tabIndex={-1}
          >
            <h3 id="kc-platform-notice">换成第三方 API？</h3>
            <p className="confirm-body">{notice.text}</p>
            <label className="a-check-row">
              <input type="checkbox" checked={dontAskAgain} onChange={(e) => setDontAskAgain(e.target.checked)} />
              不再提示
            </label>
            <div className="a-form-actions">
              <button type="button" className="btn btn-quiet" onClick={revertToDeepSeek}>
                换回 DeepSeek
              </button>
              <button type="button" className="btn btn-accent" onClick={closeNotice}>
                仍要使用
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── Skill 管理分节（清单 + 开关；开启项注入系统提示词） ── */
function SkillSection({
  form,
  flash,
  onToggle,
}: {
  form: Prefs;
  flash: string;
  /** 开关切换：父级统一管道（改 form + 立即落盘最新表单，见 toggleSkill 注释） */
  onToggle: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [onlyOn, setOnlyOn] = useState(false);
  const [active, setActive] = useState<string[]>(form.activeSkillIds ?? []);
  const [collapsed, setCollapsed] = useState<{ builtin: boolean; custom: boolean }>({
    builtin: false,
    custom: false,
  });

  const skills = form.skillList ?? [];
  const match = (s: Prefs["skillList"][number]) => {
    const q = query.trim().toLowerCase();
    if (q && !s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) return false;
    if (onlyOn && !active.includes(s.id)) return false;
    return true;
  };
  const builtin = skills.filter((s) => s.isBuiltIn && match(s));
  const custom = skills.filter((s) => !s.isBuiltIn && match(s));
  const onCount = skills.filter((s) => active.includes(s.id)).length;

  // 开关：本地即时回显 + 父级统一管道（C-2：不再自走 savePrefs 绕过 dirty/save）
  const toggle = (id: string) => {
    setActive((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    onToggle(id);
  };

  return (
    <div className="a-settings-panel">
      <div className="a-skill-topline">
        Skill 定义了 AI 的工作流程和行为规范，开关打开的 Skill 会注入到系统提示词。已开启 {onCount} / 共 {skills.length}。
      </div>
      <div className="a-skill-toolbar">
        <div className="a-search">
          <svg viewBox="0 0 20 20" className="ic">
            <circle cx="9" cy="9" r="5.4" />
            <path d="M13 13l3.6 3.6" />
          </svg>
          <input
            placeholder="搜索 Skill"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </div>
        <button className={onlyOn ? "a-toolbtn on" : "a-toolbtn"} onClick={() => setOnlyOn((v) => !v)}>
          已开启
        </button>
      </div>
      {flash ? <div className="a-flash" role="status">{flash}</div> : null}

      {builtin.length > 0 ? (
        <>
          <SkillGroupHead
            label="内置"
            n={builtin.length}
            collapsed={collapsed.builtin}
            onToggle={() => setCollapsed((c) => ({ ...c, builtin: !c.builtin }))}
          />
          {!collapsed.builtin && builtin.map((s) => (
            <SkillRow key={s.id} s={s} on={active.includes(s.id)} onToggle={toggle} />
          ))}
        </>
      ) : null}
      {custom.length > 0 ? (
        <>
          <SkillGroupHead
            label="自定义"
            n={custom.length}
            collapsed={collapsed.custom}
            onToggle={() => setCollapsed((c) => ({ ...c, custom: !c.custom }))}
          />
          {!collapsed.custom && custom.map((s) => (
            <SkillRow key={s.id} s={s} on={active.includes(s.id)} onToggle={toggle} />
          ))}
        </>
      ) : null}
      {skills.length === 0 ? (
        <div className="a-empty">
          技能清单为空。内置技能随应用发布，首次启动会自动释放到技能目录；自定义技能放进同一目录后，重启应用即可被扫描到。
        </div>
      ) : null}
    </div>
  );
}

/* C-3：Row / GroupHead 提为模块级组件 —— 原先定义在 SkillSection 体内，
   每次渲染都是新的组件身份，搜索框每敲一个字整组技能行 unmount/remount
   （本地 state 丢失 + 全量 DOM 重建）。 */

/** 单条技能行：头像 + 名称/描述 + 启用开关 */
function SkillRow({
  s,
  on,
  onToggle,
}: {
  s: Prefs["skillList"][number];
  on: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="a-skill-row">
      <div className="a-skill-ava">{s.name.slice(0, 1).toUpperCase()}</div>
      <div className="a-skill-main">
        <div className="a-skill-name">{s.name}</div>
        <div className="a-skill-desc">{s.description || "（无描述）"}</div>
      </div>
      <button
        className={on ? "a-switch on" : "a-switch"}
        title={on ? "点击停用" : "点击启用"}
        onClick={() => onToggle(s.id)}
      >
        <i />
      </button>
    </div>
  );
}

/** 分组头：标题 + 计数 + 折叠开关 */
function SkillGroupHead({
  label,
  n,
  collapsed,
  onToggle,
}: {
  label: string;
  n: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="a-group-head" onClick={onToggle}>
      <span>
        {label} <em>{n}</em>
      </span>
      <svg
        viewBox="0 0 12 12"
        className={collapsed ? "caret" : "caret open"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 4.5L6 7.5l3-3" />
      </svg>
    </div>
  );
}

/* ── 参数分节（既有实现：温度滑杆 + 系统提示词 + 上下文压缩） ── */
function ParamsSection({
  form,
  update,
  saving,
  saveMsg,
  onSave,
}: {
  form: Prefs;
  update: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  saving: boolean;
  saveMsg: string;
  onSave: () => void;
}) {
  return (
    <div className="a-settings-panel">
      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">温度</span>
          <span className="a-card-num">{form.temperature}</span>
        </div>
        <div className="a-card-desc">控制回复的随机性：越低越稳定确定，越高越多样随机。</div>
        {/* 不再下发 --fill：滑杆改为纯实色轨道、不绘制已填充段
            （旋钮位置 + 右上角数字读数已经表达了值，再刷一条彩色进度
            是重复表达）。这里的内联变量已随之移除。 */}
        <input
          className="a-slider"
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={form.temperature}
          onChange={(e) => update("temperature", parseFloat(e.target.value))}
        />
      </div>

      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">系统提示词</span>
        </div>
        <div className="a-card-desc">自定义 AI 助手的行为，留空则使用默认的小说写作助手提示词。</div>
        <textarea
          className="a-textarea"
          value={form.systemPrompt}
          rows={5}
          onChange={(e) => update("systemPrompt", e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">上下文自动压缩</span>
        </div>
        <div className="a-card-desc">
          当对话内容超过设定阈值时，自动把更早的对话压缩成摘要，只影响发给 AI 的上下文，不删除聊天记录。
        </div>
        <div className="a-card-row">
          <span>启用自动压缩</span>
          <button
            className={form.autoClearContext ? "a-switch on" : "a-switch"}
            onClick={() => update("autoClearContext", !form.autoClearContext)}
          >
            <i />
          </button>
        </div>
        <div className="a-card-row">
          <span>
            上下文窗口 (K){" "}
            <svg viewBox="0 0 20 20" className="ic a-help">
              <circle cx="10" cy="10" r="7.5" />
              <path d="M10 13.6v.05" />
              <path d="M7.9 7.8a2.1 2.1 0 1 1 2.9 1.95c-.55.24-.8.6-.8 1.2" />
            </svg>
          </span>
          <NumInput
            value={form.contextLimit}
            min={1}
            max={4096}
            unit={1000}
            ariaLabel="上下文窗口（K）"
            onCommit={(n) => update("contextLimit", n)}
          />
        </div>
        <div className="a-card-row">
          <span>
            输出预留 (K){" "}
            <svg viewBox="0 0 20 20" className="ic a-help">
              <circle cx="10" cy="10" r="7.5" />
              <path d="M10 13.6v.05" />
              <path d="M7.9 7.8a2.1 2.1 0 1 1 2.9 1.95c-.55.24-.8.6-.8 1.2" />
            </svg>
          </span>
          <NumInput
            value={form.reservedOutputTokens}
            min={1}
            max={384}
            unit={1000}
            ariaLabel="输出预留（K）"
            onCommit={(n) => update("reservedOutputTokens", n)}
          />
        </div>
      </div>

      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">生成与工具</span>
        </div>
        <div className="a-card-desc">控制 AI 单次回复的长度上限与自动执行工具调用的轮次上限。</div>
        <div className="a-card-row">
          <span>一次回复上限 (K){" "}
            <svg viewBox="0 0 20 20" className="ic a-help">
              <circle cx="10" cy="10" r="7.5" />
              <path d="M10 13.6v.05" />
              <path d="M7.9 7.8a2.1 2.1 0 1 1 2.9 1.95c-.55.24-.8.6-.8 1.2" />
            </svg>
          </span>
          <NumInput
            value={form.maxOutputTokens}
            min={1}
            // 上限 384K = DeepSeek 官方最大输出（DECISIONS D-024），原值 200K 会挡住用户用满
            max={384}
            unit={1000}
            ariaLabel="一次回复上限（K）"
            onCommit={(n) => update("maxOutputTokens", n)}
          />
        </div>
        <div className="a-card-row">
          <span>工具调用轮次上限</span>
          {/* B16：滑杆取代数字框；最右端 = 无上限（落盘 0）。
              用户裁决：一次完整回流做不完的 50 上限太小；无上限 = 跑到模型自己停手。 */}
          <input
            className="a-slider"
            type="range"
            min={1}
            max={51}
            step={1}
            aria-label="工具调用轮次上限"
            value={form.toolRoundLimit > 0 ? Math.min(50, form.toolRoundLimit) : 51}
            onChange={(e) => {
              const v = Number(e.target.value);
              update("toolRoundLimit", v >= 51 ? 0 : v);
            }}
          />
          <span className="a-card-num">{form.toolRoundLimit > 0 ? form.toolRoundLimit : "无上限"}</span>
        </div>
      </div>

      <div className="a-params-footer">
        <span className="a-form-hint">改动会自动保存并立即生效，也可以按 Ctrl+S 立即保存</span>
        <button className="a-btn-primary" onClick={onSave} disabled={saving}>
          {saving ? "保存中..." : "保存参数"}
        </button>
        {saveMsg && (
          <span className={`a-save-msg ${saveMsg.includes("失败") ? "error" : ""}`}>{saveMsg}</span>
        )}
      </div>
    </div>
  );
}

/* ── 主题分节（三套实色主题 + 强调色 + 字号） ── */
function ThemeSection({
  form,
  update,
  flash,
  onThemeMode,
  onAccent,
  saving,
  saveMsg,
  onSave,
}: {
  form: Prefs;
  update: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  flash: string;
  onThemeMode: (mode: ThemeMode) => void;
  onAccent: (argb: number) => void;
  saving: boolean;
  saveMsg: string;
  onSave: () => void;
}) {
  return (
    <div className="a-settings-panel">
      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">界面主题</span>
        </div>
        <div className="a-card-desc">
          三套实色配色，各自成套（画布、侧轨、纸面、浮起面、井底与文字层级一次换齐），
          点击即时生效并保存。面板一律不透明，层级靠明度差而不是靠模糊。
        </div>
        <div className="a-themecards">
          {THEME_MODES.map((t) => (
            <button
              key={t.mode}
              className={form.themeMode === t.mode ? "a-themecard on" : "a-themecard"}
              onClick={() => onThemeMode(t.mode)}
              title={`切换到「${t.label}」主题`}
            >
              <span className={`a-tc-prev ${t.preview}`} />
              <span className="a-tc-label">
                {t.label}
                {form.themeMode === t.mode ? (
                  <svg viewBox="0 0 20 20" className="ic tick">
                    <path d="M4.5 10.5l3.5 3.5 7.5-8" />
                  </svg>
                ) : null}
              </span>
            </button>
          ))}
        </div>
        {flash ? <div className="a-flash" role="status">{flash}</div> : null}
      </div>

      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">强调色</span>
        </div>
        <div className="a-card-desc">用于选中态、主按钮与用户会话气泡；派生的浅底 / 描边 / 文字色随之联动。</div>
        <div className="a-swatches">
          {ACCENT_SWATCHES.map((s) => {
            const rgb = `#${(s.argb & 0xffffff).toString(16).padStart(6, "0")}`;
            const on = form.customAccentColor === s.argb;
            const isAuto = s.argb === ACCENT_AUTO;
            return (
              <button
                key={s.argb}
                className={on ? "a-swatch on" : "a-swatch"}
                /* 色板必须是**实色**。「跟随主题」用左右双半实色（白纸/墨黑），
                   不用渐变 —— 零渐变是硬约束。 */
                style={isAuto ? undefined : { background: rgb }}
                onClick={() => onAccent(s.argb)}
                title={isAuto ? "跟随主题（暗色主题近白、浅色主题近黑）" : `${s.label} · ${rgb.toUpperCase()}`}
              >
                {isAuto ? <span className="a-swatch-auto" aria-hidden="true" /> : null}
                {on ? (
                  <svg viewBox="0 0 20 20" className="ic">
                    <path d="M4.5 10.5l3.5 3.5 7.5-8" />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">字号</span>
          <span className="a-card-side">对话与编辑器正文字号</span>
        </div>
        {/* 两个字号框与其它数字输入同一守卫：清空/非法中间态不落盘，越界当场夹取。
            旧实现裸 Number(v)：清空 → Number("")===0 → 自动保存把字号存成 0px，
            主界面 --chat-fs/--editor-fs 变 0，聊天区与编辑器文字全部消失。 */}
        <div className="a-card-row">
          <span>对话字号</span>
          <NumInput
            value={form.chatFontSize}
            min={11}
            max={24}
            className="field a-num"
            ariaLabel="对话字号"
            onCommit={(n) => update("chatFontSize", n)}
          />
        </div>
        <div className="a-card-row">
          <span>编辑器字号</span>
          <NumInput
            value={form.editorFontSize}
            min={11}
            max={28}
            className="field a-num"
            ariaLabel="编辑器字号"
            onCommit={(n) => update("editorFontSize", n)}
          />
        </div>
        <div className="a-form-actions">
          {/* 字号是 form 的一部分，走统一保存；旧实现借 onAccent 顺手存盘，语义混乱 */}
          <button className="btn btn-accent" onClick={onSave} disabled={saving}>
            {saving ? "保存中..." : "保存字号"}
          </button>
          {saveMsg && (
            <span className={`a-save-msg ${saveMsg.includes("失败") ? "error" : ""}`}>{saveMsg}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── 数据分节（存储位置为真实路径：可更改、可打开；可重置配置） ── */
function DataSection({
  form,
  flash,
  onFlash,
  askConfirm,
  onPathsChange,
  onReset,
}: {
  form: Prefs;
  flash: string;
  onFlash: (s: string) => void;
  askConfirm: (title: string, body?: string, opts?: { danger?: boolean; confirmLabel?: string }) => Promise<boolean>;
  onPathsChange: (next: Prefs) => Promise<void>;
  /** 重置写盘成功后同步父级表单（否则自动保存会把旧表单写回，重置被静默回滚） */
  onReset: (next: Prefs) => void;
}) {
  const boot = currentBoot();
  const dirs = boot?.dirs;
  const skillCount = form.skillList?.length ?? 0;
  const [bookCount, setBookCount] = useState<number | null>(null);

  // 真实统计：数作品根下非系统子目录（一个目录 = 一部作品）；读失败按 0 计
  useEffect(() => {
    let alive = true;
    if (!dirs) return;
    void (async () => {
      try {
        const entries = await getFs().list(dirs.booksRoot);
        if (alive) setBookCount(entries.filter((e) => e.isDir && !isSystemEntryName(e.name)).length);
      } catch {
        if (alive) setBookCount(0);
      }
    })();
    return () => {
      alive = false;
    };
  }, [dirs]);

  /** 更改存储目录：系统文件夹选择器 → 盘符根守卫 → 写配置 */
  const pickDir = async (which: "books" | "skills") => {
    const chosen = await openDialog({
      directory: true,
      multiple: false,
      title: which === "books" ? "选择小说作品目录" : "选择 Skill 目录",
    });
    const path = typeof chosen === "string" ? chosen.trim() : "";
    if (!path) return; // 用户取消
    if (isDriveRoot(path)) {
      onFlash("不能选择磁盘根目录，请选择具体文件夹");
      return;
    }
    await onPathsChange({
      ...form,
      customNovelsDir: which === "books" ? path : form.customNovelsDir,
      customSkillsDir: which === "skills" ? path : form.customSkillsDir,
    });
  };

  /** 在资源管理器中打开目录（Rust open_dir；失败如实回显原因） */
  const openDir = async (path?: string) => {
    if (!path) return;
    try {
      await invoke("open_dir", { path });
    } catch (e) {
      onFlash(`打开失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="a-settings-panel">
      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">数据概览</span>
        </div>
        <div className="a-statbar">
          {bookCount === null ? "统计中…" : `${bookCount} 部作品`} · {skillCount} 个 Skill
        </div>
        <div className="a-card-desc">
          作品与 Skill 全部以本地目录和文件存放，应用不建数据库、不留云端副本。
        </div>
      </div>

      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">存储位置</span>
        </div>
        <div className="a-card-row col">
          <span className="a-path-label">小说作品目录</span>
          <span className="a-path">{dirs?.booksRoot ?? "（未加载）"}</span>
        </div>
        <div className="a-form-actions">
          <button className="a-toolbtn" onClick={() => void pickDir("books")}>
            更改
          </button>
          <button className="a-toolbtn" onClick={() => void openDir(dirs?.booksRoot)}>
            打开目录
          </button>
        </div>
        <div className="a-card-row col">
          <span className="a-path-label">Skill 目录</span>
          <span className="a-path">{dirs?.skillsDir ?? "（未加载）"}</span>
        </div>
        <div className="a-form-actions">
          <button className="a-toolbtn" onClick={() => void pickDir("skills")}>
            更改
          </button>
          <button className="a-toolbtn" onClick={() => void openDir(dirs?.skillsDir)}>
            打开目录
          </button>
        </div>
        <div className="a-card-desc">
          更改后立即写入配置，返回主界面即按新路径装配；会话、快照与备忘录固定在文档目录下，不在此更改。
        </div>
        {flash ? <div className="a-flash" role="status">{flash}</div> : null}
      </div>

      <div className="a-card danger">
        <div className="a-card-head">
          <span className="a-card-title">危险操作</span>
        </div>
        <div className="a-card-desc">清除软件配置（恢复默认设置），不会删除作品目录下的任何文件。</div>
        <div className="a-form-actions">
          <button
            className="a-btn-danger"
            onClick={() => {
              void (async () => {
                const ok = await askConfirm("清除软件配置？", "将恢复默认设置，不会删除作品目录下的任何文件。", { danger: true, confirmLabel: "重置" });
                if (!ok) return;
                try {
                  const { parsePrefs, serializePrefs, DEFAULT_PREFS } = await import("../core/prefs");
                  const fresh = parsePrefs(serializePrefs({ ...DEFAULT_PREFS }));
                  await savePrefs(fresh);
                  onReset(fresh); // 同步本地表单并清脏：防止自动保存把重置前的旧表单写回去
                  onFlash("配置已重置为默认（主题与强调色返回主界面后生效）");
                } catch (e) {
                  onFlash(`重置失败：${e instanceof Error ? e.message : String(e)}`);
                }
              })();
            }}
          >
            重置数据
          </button>
        </div>
      </div>
    </div>
  );
}

/** Rust app_info 的完整形态(名称/版本之外,B19 起还带署名、社群与构建烙印;预览沙箱同形) */
interface AppInfoFull {
  name: string;
  version: string;
  author?: string;
  copyright?: string;
  qqGroup?: string;
  douyinUrl?: string;
  build?: string;
}

/* ── 关于分节(名称/版本/署名与社群均取自 Rust 侧 app_info,与产物永远一致;B19/D-053) ── */
function AboutSection() {
  const boot = currentBoot();
  const [info, setInfo] = useState<AppInfoFull | null>(null);

  // 预览沙箱未实现 app_info（替身返回 null）：回落常量，界面不出现空洞
  useEffect(() => {
    let alive = true;
    void invoke<AppInfoFull | null>("app_info")
      .then((i) => {
        if (alive) setInfo(i);
      })
      .catch(() => {
        /* 取不到就用回落文案，关于页不该因此报错 */
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 打开目录（失败静默：关于页的入口不该弹错误） */
  const [authorNote, setAuthorNote] = useState("");
  /** 打开作者主页(Rust open_url;失败如实回显,不静默) */
  const openAuthor = async () => {
    const err = await openAuthorPage(info?.douyinUrl ?? "");
    setAuthorNote(err ? "打开失败:" + err : "已在系统浏览器打开作者主页");
  };
  const copyGroup = async () => {
    const qq = info?.qqGroup ?? "";
    if (!qq) return;
    try {
      await navigator.clipboard.writeText(qq);
      setAuthorNote("QQ 群号已复制:" + qq);
    } catch {
      setAuthorNote("复制失败,群号可直接选中复制:" + qq);
    }
  };

  const openDir = async (path?: string) => {
    if (!path) return;
    try {
      await invoke("open_dir", { path });
    } catch {
      /* 忽略 */
    }
  };

  return (
    <div className="a-settings-panel">
      <div className="a-about-hero">
        <div className="a-about-logo"><img src={logo} alt="" /></div>
        <h2>{info?.name || "TeachWrite"}</h2>
        <span className="a-version">版本 {info?.version || "1.1.0"}</span>
          {info?.author ? <span className="author-name">作者 {info.author}</span> : null}
          {info?.build ? <span className="a-build">构建 {info.build}</span> : null}
        <p>你的 AI 小说写作助手</p>
      </div>

        <div className="a-card">
          <div className="a-card-head">
            <span className="a-card-title">作者与社群</span>
          </div>
          <div className="a-card-desc">
            {info?.author ? authorStatement(info.author) : "作者信息未取得(检查产物是否完整)。"}
          </div>
          {info?.qqGroup ? (
            <div className="a-group">
              <span className="a-card-title">{QQ_LABEL}</span>
              <span className="a-qq">{info.qqGroup}</span>
              <button className="btn btn-quiet a-copy" onClick={() => void copyGroup()}>复制群号</button>
            </div>
          ) : null}
          <button className="a-list-row" onClick={() => void openAuthor()} disabled={!info?.douyinUrl}>
            <span>{DOUYIN_LABEL}</span>
            <em>›</em>
          </button>
          {authorNote ? (
            <div className="a-card-desc" role="status">
              {authorNote}
            </div>
          ) : null}
          {info?.copyright ? (
            <div className="a-card-desc">
              {info.copyright} · 本软件以 GPL-3.0 发布,再分发须保留本署名。
            </div>
          ) : null}
        </div>

      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">与 DeepSeek 官方的关系</span>
        </div>
        <div className="a-card-desc">
          TeachWrite 是独立的第三方本地软件，与 DeepSeek（杭州深度求索）没有隶属、赞助或背书关系。
          内置 DeepSeek 官方接口的接入预设，只是因为它是一个常用的模型服务；你填的 API Key 只存在本机配置里，
          请求直接从你的电脑发往你选择的接口，我们不中转、不收集。
        </div>
      </div>

      <div className="a-card">
        <div className="a-card-head">
          <span className="a-card-title">数据与隐私</span>
        </div>
        <div className="a-card-desc">
          作品、会话、快照与配置只存在本机磁盘；除你自己配置的 AI 接口外，应用不做任何其它网络请求。
        </div>
        <button className="a-list-row" onClick={() => void openDir(boot?.dirs.prefsDir)}>
          <span>打开配置目录</span>
          <em>›</em>
        </button>
        <button className="a-list-row" onClick={() => void openDir(boot?.dirs.sessionsDir)}>
          <span>打开会话记录目录</span>
          <em>›</em>
        </button>
      </div>
    </div>
  );
}

/* ── 模型选择框（自绘：只能选择，不能手填） ──
   为什么只能选：手填与已选值共用一个输入框时，"当前生效的到底是哪个模型"
   要靠用户自己记住；点选则永远确定（选中项高亮 + 按钮回显）。
   为什么自绘：原生 datalist 在 WebView2 里弹层高度与样式都不受控，
   长清单显示不全，且只按前缀过滤。这里的弹层 = 完整清单（滚动）+
   子串筛选（筛选只缩小列表，不改变已选值）+ 空清单时的明确引导。 */
function ModelSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // 与应用内其它弹层同一条纪律：点外部 / Esc 收起。
  // Esc 要 stopPropagation —— App 外壳在 window 上还挂着一个「Esc 返回主界面」，
  // 不拦住的话收下拉会顺手把整个设置页也退掉。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 展开时清空上次的筛选并把焦点放进筛选框（清单长时才渲染它）
  useEffect(() => {
    if (!open) return;
    setQuery("");
    if (options.length > 6) {
      const raf = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open, options.length]);

  const filtered = filterModelOptions(options, query);
  const current = value.trim();

  return (
    <div className="a-combo" ref={wrapRef}>
      <button
        type="button"
        className="a-form-input a-combo-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="模型"
        title={current || "请选择模型"}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={current ? "a-combo-val" : "a-combo-val dim"}>
          {current || "请选择模型（先点「检测连接」拉取清单）"}
        </span>
        <svg
          viewBox="0 0 12 12"
          className={open ? "caret open" : "caret"}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 4.6L6 7.6l3-3" />
        </svg>
      </button>
      {open ? (
        <div className="a-combo-pop surface-raised" role="listbox" aria-label="可选模型">
          {options.length > 6 ? (
            <input
              ref={searchRef}
              className="a-combo-search"
              value={query}
              placeholder="输入以筛选…"
              spellCheck={false}
              aria-label="筛选模型"
              onChange={(e) => setQuery(e.target.value)}
            />
          ) : null}
          <div className="a-combo-list">
            {options.length === 0 ? (
              <div className="a-combo-none">尚未拉取到模型清单，请先点上方「检测连接」</div>
            ) : filtered.length === 0 ? (
              <div className="a-combo-none">没有匹配「{query}」的模型</div>
            ) : (
              filtered.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="option"
                  aria-selected={m === current}
                  className={m === current ? "a-combo-opt on" : "a-combo-opt"}
                  title={m}
                  onClick={() => {
                    onChange(m);
                    setOpen(false);
                  }}
                >
                  {m}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
