/**
 * 回收站（作品级）。两段式删除的第二段：**还原** 或 **彻底删除**。
 *
 * 为什么单独一个模态而不塞进文件面板：回收站里的条目已经不在作品树里了，
 * 它需要自己的列表（原位置、移入时间、体积）和两个不可逆程度不同的动作。
 *
 * 交互纪律：
 *  - 每行两个动作：还原（安全）/ 彻底删除（危险，红色，且要手打作品名）；
 *  - 顶部「清空回收站」同样走手打确认（一次删光，是这里最重的一个动作）；
 *  - 空态一句「回收站为空」，不留一个看起来坏掉的空框（原版文案就是这五个字）。
 */

import { useCallback, useEffect, useRef, useState, useId } from "react";
import { getFs } from "../core/fsbridge";
import { useDialogFocus } from "./useDialogFocus";
import { pushEsc } from "./escStack";
import {
  emptyRecycle,
  formatBytes,
  loadManifest,
  purgeItem,
  recycleCount,
  restoreFromRecycle,
  type RecycleItem,
} from "../core/store/recycle";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 作品根（回收站就在它下面） */
  booksRoot: string | null;
  /** 状态条提示（成功/失败都用它，和主界面同一个出口） */
  onStatus: (msg: string) => void;
  /** 还原成功后刷新作品列表 */
  onChanged: () => void;
  /** 危险动作的手打确认（由主界面提供，避免两个模态各写一套） */
  askTypedConfirm: (
    title: string,
    body: string,
    expected: string,
    confirmLabel?: string,
    noun?: string,
  ) => Promise<boolean>;
  /** 普通确认（清空回收站前的第一道问句） */
  askConfirm: (title: string, body?: string, opts?: { danger?: boolean; confirmLabel?: string }) => Promise<boolean>;
}

export default function RecycleBin({
  open,
  onClose,
  booksRoot,
  onStatus,
  onChanged,
  askTypedConfirm,
  askConfirm,
}: Props) {
  const [items, setItems] = useState<RecycleItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  const reload = useCallback(async () => {
    if (!booksRoot) {
      setItems([]);
      return;
    }
    setItems((await loadManifest(getFs(), booksRoot)).items);
  }, [booksRoot]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  // escStack：叠层模态（回收站之上再开手打确认）一次 Esc 只关最上层（N-17）
  useEffect(() => {
    if (!open) return;
    return pushEsc(onClose);
  }, [open, onClose]);

  useDialogFocus(open, panelRef, closeRef);

  if (!open) return null;

  const doRestore = async (item: RecycleItem) => {
    if (!booksRoot) return;
    setBusyId(item.id);
    try {
      const r = await restoreFromRecycle(getFs(), booksRoot, item.id);
      if (r.ok) {
        onStatus(`已还原「${item.name}」`);
        onChanged();
      } else {
        onStatus(`还原失败：${r.reason}`);
      }
      await reload();
    } catch (e) {
      onStatus(`还原失败：${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const doPurge = async (item: RecycleItem) => {
    if (!booksRoot) return;
    const ok = await askTypedConfirm(
      "彻底删除",
      `将无法恢复，确定永久删除“${item.name}”吗？`,
      item.name,
      "永久删除",
    );
    if (!ok) return;
    setBusyId(item.id);
    try {
      const r = await purgeItem(getFs(), booksRoot, item.id);
      onStatus(r.ok ? `已永久删除「${item.name}」` : `永久删除失败：${r.reason}`);
      await reload();
    } catch (e) {
      onStatus(`永久删除失败：${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const doEmpty = async () => {
    if (!booksRoot || items.length === 0) return;
    const n = await recycleCount(getFs(), booksRoot);
    const first = await askConfirm(
      "清空回收站",
      `将永久删除回收站中的所有项目（${n} 项），无法恢复。`,
      { danger: true, confirmLabel: "继续" },
    );
    if (!first) return;
    const typed = await askTypedConfirm(
      "清空回收站",
      `最后确认：回收站里共 ${n} 项，删除后无法恢复。`,
      "清空回收站",
      "永久删除",
      "确认词",
    );
    if (!typed) return;
    try {
      const r = await emptyRecycle(getFs(), booksRoot);
      const failed = r.failed.length > 0 ? `，${r.failed.length} 项失败：${r.failed[0].reason}` : "";
      onStatus(`已清空回收站（${r.removed} 项）${failed}`);
      await reload();
    } catch (e) {
      onStatus(`清空回收站失败：${String(e instanceof Error ? e.message : e)}`);
    }
  };

  return (
    <div
      className="qmodal scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="qbox rb-box surface-raised sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
      >
        <h3 id={titleId}>回收站</h3>
        <p className="qhint">
          移入回收站的作品可以还原回原位；彻底删除后无法恢复（软件不会替你留副本）。
          作品的会话记录在移入回收站时一并删除，还原作品不会带回它们。
        </p>

        {items.length === 0 ? (
          <div className="rb-empty">回收站为空</div>
        ) : (
          <div className="rb-list">
            {items.map((it) => (
              <div className="rb-row" key={it.id}>
                <svg viewBox="0 0 20 20" className="ic rb-ic">
                  <path d="M3 4.6A1.6 1.6 0 0 1 4.6 3h5.8l4.6 4.6v8.8A1.6 1.6 0 0 1 13.4 18H4.6A1.6 1.6 0 0 1 3 16.4V4.6z" />
                </svg>
                <div className="rb-main">
                  <div className="rb-name">{it.name}</div>
                  <div className="rb-meta" title={it.originalPath}>
                    {fmtTime(it.movedAt)} 移入 · {formatBytes(it.sizeBytes)} · 原位置 {it.originalPath}
                  </div>
                </div>
                <button
                  className="btn btn-quiet rb-act"
                  disabled={busyId === it.id}
                  onClick={() => void doRestore(it)}
                >
                  还原
                </button>
                <button
                  className="btn btn-danger rb-act"
                  disabled={busyId === it.id}
                  onClick={() => void doPurge(it)}
                >
                  彻底删除
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="a-form-actions">
          <button
            className="btn btn-danger"
            disabled={items.length === 0}
            onClick={() => void doEmpty()}
          >
            清空回收站
          </button>
          <span className="rb-count">{items.length > 0 ? `${items.length} 项` : ""}</span>
          <button ref={closeRef} className="btn btn-quiet" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** ISO → 「2026-07-04 17:05」（解析失败原样回显，不显示 Invalid Date） */
export function fmtTime(iso: string): string {
  if (!iso || iso.length < 16) return iso || "未知时间";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}