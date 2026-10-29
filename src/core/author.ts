import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

/**
 * 作者与社群信息(B19 / D-053)—— 前端只读取,不持有值。
 *
 * 唯一真源在 Rust:src-tauri/src/lib.rs 的 AUTHOR / QQ_GROUP / DOUYIN_URL 常量,
 * 经 app_info 命令下发;同一组常量由 build.rs 写进 PE 版本资源(LegalCopyright),
 * 所以「界面显示的署名」和「产物文件属性里的署名」永远同源 —— 想改署名必须重编 Rust。
 *
 * 为什么不在这里再抄一遍常量:本项目的纪律是「一处真源,不各写一遍」
 * (见 store/quickPrompts.ts 与关于页的版本号口径)。两处字面量迟早漂移。
 * 取不到 app_info 时(理论上只有预览沙箱未实现的路径)界面显示"未知",
 * 而不是用一个可能过期的本地常量冒充。
 */

/** Rust app_info 下发的作者与社群部分(字段缺失一律按"取不到"处理) */
export interface AuthorInfo {
  name: string;
  copyright: string;
  qqGroup: string;
  douyinUrl: string;
  /** 构建烙印:提交号 @ 构建时间 */
  build: string;
}

interface AppInfoLike {
  author?: unknown;
  copyright?: unknown;
  qqGroup?: unknown;
  douyinUrl?: unknown;
  build?: unknown;
}

/** 从 Rust 的 app_info 结果里取作者信息;任一必需字段不合法就返回 null */
export function authorFromAppInfo(info: AppInfoLike | null | undefined): AuthorInfo | null {
  if (!info) return null;
  const name = str(info.author);
  const copyright = str(info.copyright);
  const qqGroup = str(info.qqGroup);
  const douyinUrl = str(info.douyinUrl);
  if (name === "" || copyright === "" || qqGroup === "" || !douyinUrl.startsWith("https://")) return null;
  return { name, copyright, qqGroup, douyinUrl, build: str(info.build) };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 抖音入口按钮文案(分享口令里的「长按复制」那套话术不进软件:这里是点击直达) */
export const DOUYIN_LABEL = "作者抖音主页";

/** QQ 群行的标签 */
export const QQ_LABEL = "交流群";

/** 一句作者声明(关于页与欢迎弹窗同一口径;名字来自 Rust) */
export function authorStatement(name: string): string {
  return (
    "TeachWrite 基于 " + name + " 开发的 DeepCompose 构建,是免费的本地软件;与 DeepSeek 官方没有隶属或背书关系," +
    "你的作品与 API Key 都只留在本机。"
  );
}

/** 取不到作者信息时的占位(界面不许出现空洞,也不许编造名字) */
export const AUTHOR_UNKNOWN = "作者信息未取得";

/**
 * 读取一次并缓存:欢迎弹窗、关于页、帮助页脚共用同一份结果。
 * app_info 是**同步返回**的常量命令,缓存它没有一致性风险(不会中途变)。
 * 失败(理论上只在非 Tauri 环境)折算成 null,由界面显示占位文案。
 */
let cached: Promise<AuthorInfo | null> | null = null;

export function loadAuthorInfo(): Promise<AuthorInfo | null> {
  if (cached === null) {
    cached = invoke<AppInfoLike | null>("app_info")
      .then((info) => authorFromAppInfo(info))
      .catch(() => null);
  }
  return cached;
}

/** 测试/预览重挂载时可清缓存(正常路径不需要) */
export function resetAuthorInfoCache(): void {
  cached = null;
}

/**
 * 用系统默认浏览器打开作者主页(桌面端走 Rust open_url;它对 URL 做 https 白名单)。
 * 返回 null = 成功,否则是给用户看的失败原因(不静默)。
 */
export async function openAuthorPage(url: string): Promise<string | null> {
  if (!url) return "作者主页地址未取得";
  try {
    await invoke("open_url", { url });
    return null;
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
}

/** 界面用的 hook:未取到之前返回 null(界面按"暂无"渲染,不闪空位) */
export function useAuthorInfo(): AuthorInfo | null {
  const [info, setInfo] = useState<AuthorInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void loadAuthorInfo().then((a) => {
      if (alive) setInfo(a);
    });
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/** 供单测:校验 Rust 下发的形态(纯函数,不触网) */
export const __parseAuthorForTest = authorFromAppInfo;
