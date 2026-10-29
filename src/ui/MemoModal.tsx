/**
 * 备忘录模态（结构依据实测截图；编辑视图为合理外推）。
 * 数据格式：store/memo.ts（逐字对齐既有实现的备忘录文件格式）。
 *
 * 本轮补上的无障碍缺口：这个模态原来**一个键盘处理都没有** ——
 * 没有 Esc、没有 role="dialog"、没有焦点接管，键盘用户打开后
 * 只能靠鼠标点右上角那个 × 才能出来。现在与 Dialogs.tsx 走同一套
 * 焦点管理（useDialogFocus），Esc 关闭，读屏能听到它是一个对话。
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useDialogFocus } from "./useDialogFocus";
import { pushEsc } from "./escStack";
import {
  addCategory as memoAddCategory,
  DEFAULT_CATEGORY,
  loadMemos,
  newMemo,
  removeCategory as memoRemoveCategory,
  saveMemos,
  type Memo,
  type MemoFile,
} from "../core/store/memo";
import { currentBoot } from "../core/app";
import { getFs } from "../core/fsbridge";
import { isoMicros } from "../core/ids";
import type { ProjectData } from "../core/store/project";

interface Props {
  open: boolean;
  onClose: () => void;
  project: ProjectData | null;
  /** 操作反馈出口（写入主界面状态栏） */
  onStatus: (message: string) => void;
  /** 应用内输入框（替代 window.prompt） */
  askText: (title: string, placeholder?: string) => Promise<string | null>;
}

export default function MemoModal({ open, onClose, project, onStatus, askText }: Props) {
  const [docked, setDocked] = useState(false);
  const [data, setData] = useState<MemoFile>({ categories: [DEFAULT_CATEGORY], memos: [] });
  const [scopeAll, setScopeAll] = useState(false);
  const [cat, setCat] = useState<string>("全部");
  const [editing, setEditing] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  // B12-8：`project` 也是依赖 —— 挂边态下 `open` 恒为 true，切换作品不会重跑本 effect，
  // 于是列表还显示旧作品的条目，而"新建"已经按新作品作用域落库：看到的和写进的两回事。
  const projectRoot = project?.ref.root ?? "";
  useEffect(() => {
    if (!open) return;
    const b = currentBoot();
    if (!b) return;
    void loadMemos(getFs(), b.dirs.memosFile)
      .then(setData)
      .catch((e) => onStatus(`备忘录读取失败：${String(e)}`));
    setEditing(null);
  }, [open, projectRoot, onStatus]);

  // Esc 关闭（挂边态同样生效 —— 它不是"另一个页面"，只是同一块面板的另一种摆法）；
  // escStack：叠层时一次 Esc 只关最上层（N-17）
  useEffect(() => {
    if (!open) return;
    return pushEsc(onClose);
  }, [open, onClose]);

  // 焦点默认落在"关闭"上：面板一打开，最需要能立刻脱身。
  // N-19：挂边态**不启用**焦点陷阱 —— 挂边时它已不是模态（遮罩撤掉、主界面
  // 可继续操作），Tab 却仍被锁在面板内循环，键盘用户回不到主界面。
  useDialogFocus(open && !docked, panelRef, closeRef);

  /**
   * 逐键全量落盘的串行队列：快速连续输入时多个 saveMemos 在飞，慢盘上
   * 先发出的写可能后完成，磁盘最终停在较旧快照（丢末尾几个字符）。
   * 排队后先发的写必定先完成，磁盘收敛到最新内容。
   */
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const persist = useCallback(
    (next: MemoFile) => {
      setData(next);
      const b = currentBoot();
      if (!b) return;
      saveQueue.current = saveQueue.current.then(async () => {
        try {
          await saveMemos(getFs(), b.dirs.memosFile, next);
        } catch (e) {
          onStatus(`备忘录保存失败：${String(e)}`);
        }
      });
    },
    [onStatus],
  );

  const createMemo = useCallback(() => {
    const m = newMemo(scopeAll ? "" : (project?.ref.root ?? ""));
    void persist({ ...data, memos: [m, ...data.memos] });
    setEditing(m.id);
  }, [data, scopeAll, project, persist]);

  const updateMemo = useCallback(
    (id: string, patch: Partial<Memo>) => {
      void persist({
        ...data,
        memos: data.memos.map((m) => (m.id === id ? { ...m, ...patch, updated_at: isoMicros() } : m)),
      });
    },
    [data, persist],
  );

  const deleteMemo = useCallback(
    (id: string) => {
      void persist({ ...data, memos: data.memos.filter((m) => m.id !== id) });
      if (editing === id) setEditing(null);
    },
    [data, editing, persist],
  );

  const visible = useMemo(() => {
    const scopeRoot = project?.ref.root ?? "";
    return data.memos.filter((m) => {
      if (!scopeAll && m.project_id !== scopeRoot) return false;
      if (cat !== "全部" && (m.category ?? DEFAULT_CATEGORY) !== cat) return false;
      return true;
    });
  }, [data, scopeAll, project, cat]);

  if (!open) return null;

  const editingMemo = editing ? (data.memos.find((m) => m.id === editing) ?? null) : null;

  return (
    <div className={docked ? "memo-modal scrim dock-wrap" : "memo-modal scrim"}>
      <div
        className={docked ? "memo-box surface-raised docked" : "memo-box surface-raised sheet"}
        role="dialog"
        /* 挂边态不是模态：它把主界面让出来且可继续操作，不该对读屏宣称"其后不可交互" */
        aria-modal={docked ? undefined : true}
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="memo-head">
          <svg viewBox="0 0 20 20" className="ic">
            <rect x="3" y="2.8" width="14" height="14.4" rx="2.2" />
            <path d="M6.6 7h6.8M6.6 10.2h6.8M6.6 13.4h4" />
          </svg>
          <span className="ttl" id={titleId}>备忘录</span>
          <div className="memo-head-tools">
            <button
              className={docked ? "memo-tool on" : "memo-tool"}
              title="挂边为侧栏"
              onClick={() => setDocked((v) => !v)}
            >
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M6 3.4v13.2M4 3.6h12a.8.8 0 0 1 .8.8v11.2a.8.8 0 0 1-.8.8H4z" />
              </svg>
              挂边
            </button>
            <button className="memo-tool accent" onClick={createMemo}>
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M10 4.5v11M4.5 10h11" />
              </svg>
              新建
            </button>
            <button className="memo-tool" title="关闭" onClick={onClose} ref={closeRef}>
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
              </svg>
            </button>
          </div>
        </div>

        <div className="memo-filterrow">
          <span className="lbl">
            <svg viewBox="0 0 20 20" className="ic">
              <path d="M3 5h14M6 10h8M8.5 15h3" />
            </svg>
            筛选
          </span>
          <button className="memo-scope" onClick={() => setScopeAll((v) => !v)}>
            <svg viewBox="0 0 20 20" className="ic">
              <path d="M3 4.6A1.6 1.6 0 0 1 4.6 3h5.8l4.6 4.6v8.8A1.6 1.6 0 0 1 13.4 18H4.6A1.6 1.6 0 0 1 3 16.4V4.6z" />
            </svg>
            {/* N-45：作品名必须包 span —— .memo-scope span 的省略规则（长名撑破
                胶囊）此前命中的是裸文本节点，规则一直是死的 */}
            <span>{scopeAll ? "全部作品" : project ? project.ref.name : "未选择作品"}</span>
            <em>▾</em>
          </button>
        </div>

        <div className="memo-cats">
          <button className={cat === "全部" ? "mcat on" : "mcat"} onClick={() => setCat("全部")}>
            全部
          </button>
          {data.categories.map((c) => (
            <button key={c} className={cat === c ? "mcat on" : "mcat"} onClick={() => setCat(c)}>
              {c}
              {c !== DEFAULT_CATEGORY ? (
                <em
                  onClick={(e) => {
                    e.stopPropagation();
                    void persist(memoRemoveCategory(data, c));
                    if (cat === c) setCat("全部");
                  }}
                >
                  ×
                </em>
              ) : null}
            </button>
          ))}
          <button
            className="mcat add"
            title="新增分类"
            onClick={() => {
              void askText("新分类名称", "输入分类名").then((name) => {
                if (name) void persist(memoAddCategory(data, name));
              });
            }}
          >
            +
          </button>
        </div>

        {editingMemo ? (
          <div className="memo-edit">
            <input
              className="field memo-title"
              value={editingMemo.title}
              onChange={(e) => updateMemo(editingMemo.id, { title: e.target.value })}
              spellCheck={false}
            />
            <div className="memo-edit-meta">
              <select
                value={editingMemo.category ?? DEFAULT_CATEGORY}
                onChange={(e) => updateMemo(editingMemo.id, { category: e.target.value })}
              >
                {data.categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <button className="memo-del" onClick={() => deleteMemo(editingMemo.id)}>
                删除
              </button>
              <button className="memo-back" onClick={() => setEditing(null)}>
                返回列表
              </button>
            </div>
            <textarea
              className="field memo-content"
              value={editingMemo.content}
              placeholder="记下灵感、大纲或常用指令…"
              onChange={(e) => updateMemo(editingMemo.id, { content: e.target.value })}
              spellCheck={false}
            />
          </div>
        ) : visible.length > 0 ? (
          <div className="memo-list">
            {visible.map((m) => (
              <button key={m.id} className="memo-card" onClick={() => setEditing(m.id)}>
                <div className="row1">
                  <span className="t">{m.title || "无标题"}</span>
                  {/* 分类缺失兜底：老文件里可能留着已被删掉的分类名（B8 之前删分类不迁移，
                      这类条目在 chips 里没有入口）。显示"未归类"而不是一个点不动的分类名 */}
                  <span className="c">
                    {data.categories.includes(m.category ?? DEFAULT_CATEGORY) ? (m.category ?? DEFAULT_CATEGORY) : "未归类"}
                  </span>
                </div>
                <div className="s">{m.content.slice(0, 120) || "（空）"}</div>
                <div className="d">{m.updated_at.slice(0, 16).replace("T", " ")}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="memo-empty">
            <div className="ee-icon">
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M5 2.6h6.4l3.6 3.6v11.2H5z" />
                <path d="M11.4 2.6v3.6H15" />
                <path d="M10 9v4M8 11h4" />
              </svg>
            </div>
            <div className="ee-t1">暂无备忘录</div>
            <div className="ee-t2">点击右上角「新建」按钮创建</div>
          </div>
        )}
      </div>
    </div>
  );
}
