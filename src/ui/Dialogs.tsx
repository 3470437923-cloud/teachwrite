/**
 * 应用内对话框（替代 window.prompt / window.confirm）：
 * WebView 原生对话框的标题会显示 tauri.localhost，也没法跟随主题，
 * 所以统一用本组件 —— 一块抬升面 + 遮罩 + 居中排版。
 *
 * 本轮补上的无障碍缺口（都是"看不见但会伤到人"的那一类）：
 *   · 面板缺 role="dialog" / aria-modal / aria-labelledby ——
 *     读屏软件不知道这里出现了一个对话，也不知道它叫什么名字。
 *   · ConfirmDialog 原来完全不接管焦点：打开后焦点还留在触发它的
 *     那个按钮上，Tab 会一路走到遮罩背后的主界面里去。
 *   · 关闭后焦点不归还 —— 键盘用户被丢在文档开头。
 * 现在进入时把焦点移进面板、Tab 在面板内循环、关闭时归还给原元素。
 */

import { useEffect, useId, useRef, useState } from "react";
import { useDialogFocus } from "./useDialogFocus";
import { pushEsc } from "./escStack";

export interface InputRequest {
  title: string;
  placeholder?: string;
  /** 预填值（重命名等场景）；缺省为空串 */
  initial?: string;
  resolve: (value: string | null) => void;
}

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

/**
 * 需要**手打名字**才能确认的危险动作请求（彻底删除）。
 * 与 ConfirmRequest 的差别：确认键在输入完全一致前一直禁用 ——
 * "点一下确认"挡不住手滑，而"把名字打一遍"能。
 */
export interface TypedConfirmRequest {
  title: string;
  body?: string;
  /** 用户必须逐字打出来的名字 */
  expected: string;
  /** 要打的东西叫什么（默认「作品名」；清空回收站这类动作用「确认词」） */
  noun?: string;
  confirmLabel?: string;
  resolve: (ok: boolean) => void;
}

export function InputDialog({ req }: { req: InputRequest | null }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (req) setValue(req.initial ?? "");
  }, [req]);

  // Esc 任意位置可退出（不依赖焦点落在哪里）。
  // escStack：叠层模态一次 Esc 只关最上层（N-17）；组词中的 Esc 不算（N-18）
  useEffect(() => {
    if (!req) return;
    return pushEsc(() => req.resolve(null));
  }, [req]);

  useDialogFocus(Boolean(req), panelRef, inputRef);

  if (!req) return null;
  const done = (v: string | null) => {
    req.resolve(v);
  };
  return (
    <div
      className="qmodal scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) done(null);
      }}
    >
      <div
        className="qbox surface-raised sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
      >
        <h3 id={titleId}>{req.title}</h3>
        <input
          ref={inputRef}
          className="field"
          value={value}
          placeholder={req.placeholder}
          spellCheck={false}
          aria-labelledby={titleId}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.key === "Process") return;
            if (e.key === "Enter") done(value.trim() === "" ? null : value.trim());
            if (e.key === "Escape") done(null);
          }}
        />
        <div className="a-form-actions">
          <button className="btn btn-quiet" onClick={() => done(null)}>
            取消
          </button>
          <button className="btn btn-accent" onClick={() => done(value.trim() === "" ? null : value.trim())}>
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

export function TypedConfirmDialog({ req }: { req: TypedConfirmRequest | null }) {
  const [value, setValue] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (req) setValue("");
  }, [req]);

  useEffect(() => {
    if (!req) return;
    return pushEsc(() => req.resolve(false));
  }, [req]);

  // 焦点落在输入框上：这个弹窗要用户做的是"打字"，不是"找按钮"
  useDialogFocus(Boolean(req), panelRef, inputRef);

  if (!req) return null;
  // 首尾空白不计（作品名本身不许以空格结尾，见 recycle.childNameProblem），
  // 大小写与全角/半角要一致 —— 手打确认的意义就在于"逐字对得上"。
  const matched = value.trim() === req.expected;
  const done = (ok: boolean) => req.resolve(ok);
  return (
    <div
      className="qmodal scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) done(false);
      }}
    >
      <div
        className="qbox surface-raised sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
      >
        <h3 id={titleId}>{req.title}</h3>
        {req.body ? <p className="confirm-body">{req.body}</p> : null}
        <p className="qhint">
          请输入{req.noun ?? "作品名"} <b>{req.expected}</b> 以确认：
        </p>
        <input
          ref={inputRef}
          className="field"
          value={value}
          spellCheck={false}
          aria-labelledby={titleId}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.key === "Process") return;
            if (e.key === "Enter" && matched) done(true);
            if (e.key === "Escape") done(false);
          }}
        />
        <div className="a-form-actions">
          <button className="btn btn-quiet" onClick={() => done(false)}>
            取消
          </button>
          <button className="btn btn-danger" disabled={!matched} onClick={() => done(true)}>
            {req.confirmLabel ?? "彻底删除"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ req }: { req: ConfirmRequest | null }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!req) return;
    return pushEsc(() => req.resolve(false));
  }, [req]);

  // 焦点默认落在确认键上 —— 这是一次"要不要做"的问句，
  // 停在"取消"上会让连续确认的操作者每次都要多按一次 Tab。
  useDialogFocus(Boolean(req), panelRef, confirmRef);

  if (!req) return null;
  const done = (ok: boolean) => req.resolve(ok);
  return (
    <div
      className="qmodal scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) done(false);
      }}
    >
      <div
        className="qbox surface-raised sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
      >
        <h3 id={titleId}>{req.title}</h3>
        {req.body ? <p className="confirm-body">{req.body}</p> : null}
        <div className="a-form-actions">
          <button className="btn btn-quiet" onClick={() => done(false)}>
            取消
          </button>
          <button
            ref={confirmRef}
            className={req.danger ? "btn btn-danger" : "btn btn-accent"}
            onClick={() => done(true)}
          >
            {req.confirmLabel ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}