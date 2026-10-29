/**
 * 快捷提示词（B17）：聊天输入区上方提示词栏的可编辑清单。
 *
 * 落盘（additive 契约，2026-10-06 用户裁决「自己判断」后定）：新文件
 * TeachWrite 专属应用数据根下的 `writerd_quick_prompts.json`，与备忘录同手法（单文件 JSON、
 * 可随时删除、不动 prefs 封闭键集合），全局一份、不按作品分。
 * 形态：{"version":1,"prompts":[{"id","label","text"}]}。
 *
 * 纪律：文件缺失/损坏 → 回落内置默认清单（不抛错）；首次启动由调用方把默认
 * 清单落盘一次（与内置技能「只补缺失」同一手法），之后用户增删改都以文件为准。
 */

import type { FsBridge } from "../fsbridge";

export interface QuickPrompt {
  id: string;
  /** 条目名（栏里显示的短名） */
  label: string;
  /** 点击后填进输入框的完整提示词 */
  text: string;
}

export const QUICK_PROMPTS_VERSION = 1;

/**
 * 内置默认清单。四个文本与 MainWorkbench 欢迎页快捷提示同源（欢迎页是静态展示，
 * 提示词栏才是可编辑的那份；两者由同一份常量派生，不各写一遍）。
 */
export const DEFAULT_QUICK_PROMPTS: readonly QuickPrompt[] = [
  {
    id: "write-next",
    label: "梳理本章写作目标",
    text: "请按 novel-writer 和我讨论当前章节的写作目标。先读 小说资料/00-项目状态.md、当前细纲与必要资料，指出我需要决定的场景任务、人物动机、冲突和信息安排，并给自检问题。只做讨论，不把回复当作已保存的场景导览，不写正文、对白、示范或替代句，不改动正文，不替我勾选或推进。正式导览由我使用右侧的生成入口发起。",
  },
  {
    id: "onboarding-fill",
    label: "补齐开书材料",
    text: "请读 小说资料/00-项目状态.md 和 01-开书定位.md，逐项和我讨论待填写的定位与设定，讨论清楚后再整理进小说资料；关键方向不确定的保留为待决定项。只做资料准备，不生成正文、对白、示范或替代句。",
  },
  {
    id: "xigang-next",
    label: "梳理下一段细纲",
    text: "请按现有细纲规则，先列出接下来三章的规划范围、依据、场景目标、冲突与变化，和我讨论后再整理进小说资料。只写梗概和作者需决定的问题，不生成正文、对白、示范或替代句，不把规划当成已经发生的事实。",
  },
  {
    id: "style-habits",
    label: "总结我的改稿习惯",
    text: "请读 小说资料/个人改稿/ 下的改稿对比记录、规则台账和 writerd_oplog 日志，归纳我跨章重复出现的改稿判断，逐条列出并用 question 请我确认；确认的条目按现有格式合并进 06-写作风格.md。只总结判断、适用场景和边界，不复制我的原句，不生成修改稿、示范或替代句。",
  },
];

/** 解析提示词文件：缺失/损坏/形态不对一律回落默认清单（复制一份，调用方可直接改） */
export function parseQuickPrompts(text: string): QuickPrompt[] {
  try {
    const cleaned = text.replace(/^﻿/, "");
    if (!cleaned.trim()) return [...DEFAULT_QUICK_PROMPTS];
    const raw: unknown = JSON.parse(cleaned);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [...DEFAULT_QUICK_PROMPTS];
    const arr = (raw as { prompts?: unknown }).prompts;
    if (!Array.isArray(arr)) return [...DEFAULT_QUICK_PROMPTS];
    const out: QuickPrompt[] = [];
    for (const it of arr) {
      if (!it || typeof it !== "object" || Array.isArray(it)) continue;
      const o = it as Record<string, unknown>;
      if (typeof o.id !== "string" || typeof o.text !== "string") continue;
      out.push({ id: o.id, label: typeof o.label === "string" && o.label !== "" ? o.label : o.text.slice(0, 12), text: o.text });
    }
    return out;
  } catch {
    return [...DEFAULT_QUICK_PROMPTS];
  }
}

/** 序列化（两空格缩进，与备忘录文件同风格） */
export function serializeQuickPrompts(prompts: readonly QuickPrompt[]): string {
  return JSON.stringify({ version: QUICK_PROMPTS_VERSION, prompts }, null, 2);
}

/** 读取：文件不存在返回 null（调用方据此做首次播种），存在则按容错口径解析 */
export async function loadQuickPrompts(fs: FsBridge, file: string): Promise<QuickPrompt[] | null> {
  if (!(await fs.exists(file))) return null;
  return parseQuickPrompts(await fs.readText(file));
}

/** 写盘（父目录由 fs 桥自动创建） */
export async function saveQuickPrompts(fs: FsBridge, file: string, prompts: readonly QuickPrompt[]): Promise<void> {
  await fs.writeText(file, serializeQuickPrompts(prompts));
}

/** 新条目 id（毫秒时间戳 + 随机后缀；与 ids.newMemo 同一量级的碰撞纪律） */
export function newQuickPromptId(now = new Date()): string {
  return `qp_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
