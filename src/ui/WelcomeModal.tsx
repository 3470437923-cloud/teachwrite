/**
 * 首启欢迎弹窗(B19 / D-053)。
 *
 * 内容:品牌 logo + 作者声明 + 作者抖音入口 + QQ 群号,给三条出路:
 * 「开始写作」(只关这一次)、「不再显示」(落 welcome_dismissed 永久关闭)、
 * 「看使用教程」(关欢迎窗并打开帮助)。
 *
 * 「永久关闭」的落点是 prefs 扩展键 welcome_dismissed(D-053 的 ADR),只写不删,
 * 与既有封闭键集合纪律一致。作者信息一律取自 Rust app_info(core/author.ts),
 * 这里不抄第二份常量。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import logo from "../assets/logo.png";
import { useDialogFocus } from "./useDialogFocus";
import { pushEsc } from "./escStack";
import {
  DOUYIN_LABEL,
  QQ_LABEL,
  authorStatement,
  openAuthorPage,
  useAuthorInfo,
} from "../core/author";

interface Props {
  open: boolean;
  /** 「开始写作」/ Esc / 点遮罩:本次关闭,下次启动还会来(除非勾了不再显示) */
  onClose: () => void;
  /** 勾选「不再显示」后关闭:落盘 + 关闭 */
  onNeverShow: () => void;
  /** 「看使用教程」:关欢迎窗并打开帮助 */
  onHelp: () => void;
  /** 状态条回显(打开抖音失败之类的如实文案) */
  onStatus: (msg: string) => void;
}

export default function WelcomeModal({ open, onClose, onNeverShow, onHelp, onStatus }: Props) {
  const [never, setNever] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const info = useAuthorInfo();

  useEffect(() => {
    if (open) setNever(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return pushEsc(onClose);
  }, [open, onClose]);

  useDialogFocus(open, panelRef, primaryRef);

  const finish = useCallback(() => {
    if (never) onNeverShow();
    else onClose();
  }, [never, onClose, onNeverShow]);

  const openDouyin = useCallback(async () => {
    const err = await openAuthorPage(info?.douyinUrl ?? "");
    if (err) onStatus("打开抖音链接失败:" + err);
  }, [info, onStatus]);

  const copyGroup = useCallback(() => {
    const qq = info?.qqGroup ?? "";
    if (!qq) return;
    void navigator.clipboard
      ?.writeText(qq)
      .then(() => onStatus("QQ 群号已复制:" + qq))
      .catch(() => onStatus("复制失败,群号可以直接选中复制:" + qq));
  }, [info, onStatus]);

  if (!open) return null;
  return (
    <div
      className="qmodal scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) finish();
      }}
    >
      <div
        className="qbox surface-raised sheet welcome-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="welcome-logo app-mark">
          <img src={logo} alt="" />
        </div>
        <h3 id="welcome-title" className="welcome-h">
          欢迎使用 TeachWrite
        </h3>
        <p className="welcome-sub">本地优先的长篇中文小说写作台。作品是你自己的文件,你的意志高于 AI 的输出。</p>
        <div className="welcome-rows">
          <div className="welcome-row">
            <span className="wr-k">作者</span>
            <span className="wr-v">
              <b>{info?.name ?? "…"}</b>
              {info ? " · " + authorStatement(info.name) : ""}
            </span>
          </div>
          <div className="welcome-row">
            <span className="wr-k">{QQ_LABEL}</span>
            <span className="wr-v">
              QQ 群 <b>{info?.qqGroup ?? "…"}</b>
            </span>
            <button type="button" className="btn btn-quiet a-copy" onClick={copyGroup} disabled={!info}>
              复制群号
            </button>
          </div>
          <div className="welcome-row">
            <span className="wr-k">动态</span>
            <span className="wr-v">在抖音关注作者的更新与写作分享</span>
            <button type="button" className="btn btn-quiet" onClick={() => void openDouyin()} disabled={!info}>
              {DOUYIN_LABEL}
            </button>
          </div>
        </div>
        <div className="welcome-foot">
          <label className="welcome-never">
            <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
            不再显示此弹窗
          </label>
          <div className="welcome-actions">
            <button type="button" className="btn btn-quiet" onClick={onHelp}>
              看使用教程
            </button>
            <button type="button" className="btn btn-accent" ref={primaryRef} onClick={finish}>
              开始写作
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
