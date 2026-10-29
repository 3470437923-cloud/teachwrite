/**
 * 使用教程(B19 / D-053):软件内置的文字使用教程。
 *
 * 两种用法共用同一份内容(core/help.ts):
 *  1) HelpModal —— 主界面标题栏「帮助」按钮打开的模态;
 *  2) HelpTopics —— 设置屏「帮助」分页内嵌同一批内容(不弹层,像文档页)。
 *
 * 形态:左侧分类导航 + 右侧自然段正文。实色体系:无玻璃、无渐变、无模糊。
 * 无障碍:模态接管焦点与 Esc(useDialogFocus + escStack);导航是 tab 语义,
 * 方向键可换类;正文区可键盘滚动(tabIndex)。
 * 页脚的作者/群/抖音取自 Rust app_info(单一真源,见 core/author.ts)。
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useDialogFocus } from "./useDialogFocus";
import { pushEsc } from "./escStack";
import { HELP_FOOTER_HINT, HELP_TOPICS } from "../core/help";
import { DOUYIN_LABEL, QQ_LABEL, openAuthorPage, useAuthorInfo } from "../core/author";

/** 页脚:作者署名 + QQ 群(可选中/复制)+ 抖音入口(取自 Rust,取不到就显示占位) */
function HelpFooter({ onStatus }: { onStatus?: (msg: string) => void }) {
  const info = useAuthorInfo();
  const open = async () => {
    const err = await openAuthorPage(info?.douyinUrl ?? "");
    if (err) onStatus?.("打开失败:" + err);
  };
  return (
    <div className="help-foot">
      <span>{HELP_FOOTER_HINT}</span>
      <span className="help-foot-sep" aria-hidden="true" />
      {info ? (
        <span className="help-foot-author">
          作者 <b>{info.name}</b> · {QQ_LABEL} <b className="help-qq">{info.qqGroup}</b>
        </span>
      ) : null}
      <button type="button" className="btn btn-quiet help-dy" onClick={() => void open()} disabled={!info}>
        {DOUYIN_LABEL}
      </button>
    </div>
  );
}

/** 分类导航 + 正文(弹层与设置分页共用) */
export function HelpTopics({ compact = false, onStatus }: { compact?: boolean; onStatus?: (m: string) => void }) {
  const [i, setI] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const topic = HELP_TOPICS[Math.min(i, HELP_TOPICS.length - 1)];
  const headingId = useId();

  // 换类时把正文滚回顶部(否则停在上一节的滚动位置,像"内容没变")
  const pick = useCallback((n: number) => {
    setI(n);
    bodyRef.current?.scrollTo({ top: 0 });
  }, []);

  const onNavKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        pick((i + 1) % HELP_TOPICS.length);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        pick((i - 1 + HELP_TOPICS.length) % HELP_TOPICS.length);
      }
    },
    [i, pick],
  );

  return (
    <div className={compact ? "help-body help-compact" : "help-body"}>
      <div className="help-nav" role="tablist" aria-orientation="vertical" aria-label="帮助分类">
        {HELP_TOPICS.map((t, n) => (
          <button
            key={t.label}
            type="button"
            role="tab"
            aria-selected={n === i}
            className={n === i ? "help-item on" : "help-item"}
            onClick={() => pick(n)}
            onKeyDown={onNavKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="help-main" ref={bodyRef} tabIndex={0} role="tabpanel" aria-labelledby={headingId}>
        <h3 id={headingId} className="help-h">
          {topic.label}
        </h3>
        {topic.paragraphs.map((p, n) => (
          <p key={n} className="help-p">
            {p}
          </p>
        ))}
        <HelpFooter onStatus={onStatus} />
      </div>
    </div>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  onStatus?: (msg: string) => void;
}

export default function HelpModal({ open, onClose, onStatus }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    return pushEsc(onClose);
  }, [open, onClose]);

  useDialogFocus(open, panelRef, closeRef);

  if (!open) return null;
  return (
    <div
      className="qmodal scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="qbox surface-raised sheet help-modal"
        role="dialog"
        aria-modal="true"
        aria-label="使用教程"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="help-head">
          <div className="help-title">使用教程</div>
          <button type="button" className="btn btn-quiet" ref={closeRef} onClick={onClose}>
            关闭
          </button>
        </div>
        <HelpTopics onStatus={onStatus} />
      </div>
    </div>
  );
}

