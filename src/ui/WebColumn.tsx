/**
 * 网页版参考栏（D-057，2026-10-09 用户裁决）。
 *
 * 白名单站点（DeepSeek 网页版 / 朱雀AI检测）以主窗口子 webview 的形式内嵌成栏。
 * 隔离（用户原话「不能支持这个浏览器ai接入任何东西」）：
 *  - 远程页面零 IPC（capabilities 不开远程口，命令层还有 Rust 白名单硬校验）；
 *  - 数据零通道：没有剪贴板桥、没有回写、没有任何"把内容带给网页"的接线；
 *  - 登录态在独立数据目录（Rust 侧 data_dir），与本软件的配置互不相关。
 *
 * 生命周期纪律（本组件存在的根本原因）：子 webview **不随 React 卸载自动消失** ——
 * 栏收起（宿主宽度塌到阈值以下）、进设置屏（suspended）、组件卸载，
 * 三条路都必须显式 web_close，否则网页会"飘"在别的界面上。
 * 重新展开时 web_open 复用已存在的子视图（不重载页面）。
 *
 * 同步策略：ResizeObserver 管宿主尺寸变化；兄弟栏开合只动 x 坐标不动尺寸，
 * RO 探不到 → 再补一个 400ms 的兜底轮询（一次 getBoundingClientRect，很便宜）。
 * invoke 经 promise 链串行，杜绝 open/move/close 乱序。
 */

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  /** 白名单 key（Rust 侧只认这两个值） */
  siteKey: "deepseek" | "zhuque";
  title: string;
  onClose: () => void;
  /** 主工作台被设置屏盖住时 true（N-05 常驻挂载：DOM 还在但不可见） */
  suspended: boolean;
}

/** 宿主小于这个尺寸就视为"栏不可见"，关闭子视图 */
const MIN_HOST = 40;

export default function WebColumn({ siteKey, title, onClose, suspended }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** 子视图当前是否开着（决定下次 sync 发 open 还是 move/close） */
  const openRef = useRef(false);
  /** invoke 串行链：open/move/close 必须按序到达 Rust */
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  /** 上一次同步的几何；没变化就不发 invoke（400ms 轮询不至于刷屏） */
  const lastRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    let disposed = false;
    const call = (cmd: string, args: Record<string, unknown>, onErr?: () => void) => {
      chainRef.current = chainRef.current
        .then(() => invoke(cmd, args))
        .catch(() => {
          onErr?.();
        });
    };
    const sync = () => {
      if (disposed) return;
      const el = hostRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const visible = !suspended && r.width >= MIN_HOST && r.height >= MIN_HOST;
      if (!visible) {
        if (openRef.current) {
          openRef.current = false;
          lastRef.current = null;
          call("web_close", { key: siteKey });
        }
        return;
      }
      const geo = { x: r.left, y: r.top, w: r.width, h: r.height };
      const last = lastRef.current;
      const moved =
        !last ||
        Math.abs(last.x - geo.x) > 0.5 ||
        Math.abs(last.y - geo.y) > 0.5 ||
        Math.abs(last.w - geo.w) > 0.5 ||
        Math.abs(last.h - geo.h) > 0.5;
      if (!openRef.current) {
        openRef.current = true;
        lastRef.current = geo;
        // open 失败（数据目录首次创建失败等）→ 复位标记，下一轮轮询重试，
        // 不能留在"以为开着"的假态里（否则栏位永远空白）
        call("web_open", { key: siteKey, ...geo }, () => {
          openRef.current = false;
          lastRef.current = null;
        });
      } else if (moved) {
        lastRef.current = geo;
        call("web_move", { key: siteKey, ...geo });
      }
    };
    const ro = new ResizeObserver(sync);
    if (hostRef.current) ro.observe(hostRef.current);
    const timer = window.setInterval(sync, 400);
    sync();
    return () => {
      disposed = true;
      ro.disconnect();
      window.clearInterval(timer);
      if (openRef.current) {
        openRef.current = false;
        call("web_close", { key: siteKey });
      }
    };
  }, [siteKey, suspended]);

  return (
    <aside className="panel panel-web surface-rail" aria-label={title}>
      <div className="panel-head">
        <div className="ttl">{title}</div>
        <button
          className="icon-btn"
          title={`关闭${title}`}
          aria-label={`关闭${title}`}
          onClick={onClose}
        >
          <svg viewBox="0 0 20 20" className="ic">
            <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
          </svg>
        </button>
      </div>
      <div className="web-hint">参考窗口：与本软件的作品和配置完全隔离，内容不会进入作品</div>
      <div className="web-host" ref={hostRef} />
    </aside>
  );
}
