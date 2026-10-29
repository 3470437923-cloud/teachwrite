/**
 * 快捷提示词栏（B17，2026-10-06 用户裁决）。
 *
 * 取代旧的 .chat-quick 固定三 chip（备忘录/写下一章/冷读本章——备忘录在标题栏
 * 有入口、冷读在编辑器工具栏有按钮，功能零损失；用户明确「冷读不做提示词」）。
 *
 * 形态：
 *  - 收起：一条窄栏，前几个条目直接可点，尾部「快捷词 ▾」展开全部；
 *  - 展开：完整清单 + 每条「改 / 删」+ 底部「＋ 新建」；编辑是栏内联表单
 *    （名称 + 内容两栏，保存即落盘）。
 * 点击条目 = 把提示词填进输入框（可再改后发送），不直接发送。
 *
 * 持久化：Documents\writerd_quick_prompts.json（store/quickPrompts.ts，additive
 * 契约）。首次启动播种默认清单；之后文件是唯一事实源。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { currentBoot } from "../core/app";
import type { AppDirs } from "../core/dirs";
import { getFs } from "../core/fsbridge";
import {
  DEFAULT_QUICK_PROMPTS,
  loadQuickPrompts,
  newQuickPromptId,
  saveQuickPrompts,
  type QuickPrompt,
} from "../core/store/quickPrompts";

interface Props {
  /** 点击条目：把提示词文本填进输入框（不直接发送） */
  onPick: (text: string) => void;
  /** 装配完成的目录（null = 尚未装配完）。装载 effect 以它为闸——
      组件挂在 MainWorkbench 首帧时 boot() 还没跑完，没有它就读不到文件 */
  dirs: AppDirs | null;
}

/** 收起态直出的条目数（其余收进展开层） */
const PEEK_COUNT = 3;

export default function QuickPromptBar({ onPick, dirs }: Props) {
  const [prompts, setPrompts] = useState<QuickPrompt[]>([]);
  const [open, setOpen] = useState(false);
  /** 正在编辑的条目；id === "" 表示新建 */
  const [editing, setEditing] = useState<QuickPrompt | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  /* 装载 + 首次播种（文件不存在时把默认清单落盘一次，与内置技能「只补缺失」同手法）。
     依赖 dirs：装配完成后才真正读盘（首帧 currentBoot() 尚未装配，直接读会拿到空清单并误判缺失） */
  useEffect(() => {
    if (!dirs) return;
    void (async () => {
      try {
        const loaded = await loadQuickPrompts(getFs(), dirs.quickPromptsFile);
        if (loaded === null) {
          setPrompts([...DEFAULT_QUICK_PROMPTS]);
          await saveQuickPrompts(getFs(), dirs.quickPromptsFile, DEFAULT_QUICK_PROMPTS);
        } else {
          setPrompts(loaded);
        }
      } catch {
        setPrompts([...DEFAULT_QUICK_PROMPTS]); // 读失败按默认清单工作，不打扰界面
      }
    })();
  }, [dirs]);

  /** 落盘（旁路：写失败只影响这份清单，下次启动重新读） */
  const persist = useCallback(
    (next: QuickPrompt[]) => {
      setPrompts(next);
      if (!dirs) return;
      void saveQuickPrompts(getFs(), dirs.quickPromptsFile, next).catch(() => {});
    },
    [dirs],
  );

  // 展开层：点外部 / Esc 收起（与应用内其它弹层同一条纪律；组词中的 Esc 不算）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const saveEditing = useCallback(() => {
    if (!editing) return;
    const text = editing.text.trim();
    if (text === "") return;
    const label = editing.label.trim() || text.slice(0, 12);
    if (editing.id === "") {
      persist([...prompts, { id: newQuickPromptId(), label, text }]);
    } else {
      persist(prompts.map((p) => (p.id === editing.id ? { ...p, label, text } : p)));
    }
    setEditing(null);
  }, [editing, prompts, persist]);  const remove = useCallback(
    (id: string) => persist(prompts.filter((p) => p.id !== id)),
    [prompts, persist],
  );

  const peek = prompts.slice(0, PEEK_COUNT);

  return (
    <div className="qp-wrap" ref={wrapRef}>
      <div className="qp-bar">
        {peek.map((p) => (
          <button key={p.id} type="button" className="chip" title={p.text} onClick={() => onPick(p.text)}>
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className={open ? "chip qp-toggle on" : "chip qp-toggle"}
          aria-expanded={open}
          title="全部快捷词（可新建/修改/删除）"
          onClick={() => setOpen((v) => !v)}
        >
          快捷词
          <svg
            viewBox="0 0 12 12"
            className={open ? "qp-caret open" : "qp-caret"}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 4.6L6 7.6l3-3" />
          </svg>
        </button>
      </div>

      {open ? (
        <div className="qp-pop surface-raised" role="group" aria-label="快捷提示词管理">
          {prompts.map((p) => (
            <div key={p.id} className="qp-row">
              <button
                type="button"
                className="qp-pick"
                title={p.text}
                onClick={() => {
                  onPick(p.text);
                  setOpen(false);
                }}
              >
                {p.label}
              </button>
              <button type="button" className="dt-act qp-rowact" title="修改这条" onClick={() => setEditing({ ...p })}>
                改
              </button>
              <button type="button" className="dt-act danger qp-rowact" title="删除这条" onClick={() => remove(p.id)}>
                删
              </button>
            </div>
          ))}
          {prompts.length === 0 ? <div className="qp-empty">还没有快捷词，点下面新建一条。</div> : null}

          {editing ? (
            <div className="qp-form">
              <input
                className="field"
                value={editing.label}
                placeholder="名称（栏里显示的短名）"
                spellCheck={false}
                onChange={(e) => setEditing({ ...editing, label: e.target.value })}
              />
              <textarea
                className="field qp-form-text"
                value={editing.text}
                placeholder="提示词全文（点击条目时填进输入框）"
                rows={4}
                spellCheck={false}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              />
              <div className="qp-form-acts">
                <button type="button" className="btn btn-quiet" onClick={() => setEditing(null)}>
                  取消
                </button>
                <button type="button" className="btn btn-accent" disabled={editing.text.trim() === ""} onClick={saveEditing}>
                  保存
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="qp-add" onClick={() => setEditing({ id: "", label: "", text: "" })}>
              ＋ 新建快捷词
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
