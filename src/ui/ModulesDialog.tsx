/**
 * 追踪模块管理（B8）：启用/停用 + 中途建仓。
 *
 * 入口在作品下拉菜单「追踪模块…」。启用状态的真源是 00-项目状态.md 的
 * 「- 启用模块：」行（AI 每次任务第一个读它）；老作品没有这一行时按盘上
 * 实际存在的追踪表推断，第一次勾选会把这行补进 00（该书从此按新结构校验）。
 *
 * 中途建仓：勾选启用而文件不存在时，问用户是否建仓——确认后把建仓任务
 * 发给 AI（先报预估读取量，经 question 确认再动手；产物先落 待确认/ 过目）。
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useDialogFocus } from "./useDialogFocus";
import { pushEsc } from "./escStack";
import { getFs } from "../core/fsbridge";
import { join, projectDocsDir } from "../core/dirs";
import { readProjectStatus } from "../core/store/project";
import { setModulesInStateDoc } from "../core/store/status";
import { recordSnapshot } from "../core/store/snapshot";
import { currentBoot } from "../core/app";
import { TRACKER_MODULES, STATE_DOC, type TrackerModule } from "../core/store/templates";
import { buildBootstrapPrompt } from "../core/ai/reflow";
import type { ProjectData } from "../core/store/project";

interface Props {
  open: boolean;
  onClose: () => void;
  project: ProjectData | null;
  /** 状态条提示 */
  onStatus: (msg: string) => void;
  /** 建仓任务交给主对话发送（复用现有发送管线） */
  onSendPrompt: (text: string) => void;
  /** 确认弹窗（建仓的预估确认） */
  askConfirm: (title: string, body?: string, opts?: { danger?: boolean; confirmLabel?: string }) => Promise<boolean>;
}

export default function ModulesDialog({ open, onClose, project, onStatus, onSendPrompt, askConfirm }: Props) {
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [present, setPresent] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  useDialogFocus(open, panelRef, closeRef);
  useEffect(() => {
    if (!open) return;
    return pushEsc(onClose);
  }, [open, onClose]);

  /** 读 00 的启用声明 + 盘上文件存在性 */
  const reload = useCallback(async () => {
    if (!project) return;
    const fs = getFs();
    const st = await readProjectStatus(fs, project.ref.root);
    const docNames = new Set(project.docs.map((d) => d.name));
    const presentSet = new Set<string>();
    for (const m of TRACKER_MODULES) {
      if (docNames.has(m.template.name)) presentSet.add(m.key);
    }
    setPresent(presentSet);
    // 00 有声明按声明；老作品没声明 → 按盘上文件推断（只读推断，不写）
    setEnabled(st?.modules !== null && st?.modules !== undefined ? new Set(st.modules) : presentSet);
  }, [project]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  /** 写 00 的启用模块行（写前快照，与手动保存同纪律） */
  const persistModules = useCallback(
    async (next: Set<string>): Promise<boolean> => {
      if (!project) return false;
      const fs = getFs();
      const b = currentBoot();
      const file = join(projectDocsDir(project.ref.root), STATE_DOC);
      try {
        const prev = await fs.readText(file);
        const ordered = TRACKER_MODULES.map((m) => m.key).filter((k) => next.has(k));
        const nextText = setModulesInStateDoc(prev, ordered);
        if (nextText === null) {
          onStatus("00-项目状态.md 的形态不认识（缺少「当前章节」行），无法写入启用模块");
          return false;
        }
        if (b) {
          await recordSnapshot(fs, b.dirs.snapshotsDir, {
            sessionId: "module-toggle",
            callId: `module_${Date.now()}`,
            operation: "write",
            relativePath: `小说资料/${STATE_DOC}`,
            previousContent: prev,
            previousExists: true,
            previousType: "file",
          });
        }
        await fs.writeText(file, nextText);
        setEnabled(next);
        return true;
      } catch (e) {
        onStatus(`写入失败：${String(e)}`);
        return false;
      }
    },
    [project, onStatus],
  );

  /** 勾选/取消一个模块；启用而文件缺失时问是否建仓 */
  const toggle = useCallback(
    async (key: TrackerModule) => {
      if (!project || busy) return;
      setBusy(true);
      try {
        const next = new Set(enabled);
        const turningOn = !next.has(key);
        if (turningOn) next.add(key);
        else next.delete(key);
        const ok = await persistModules(next);
        if (!ok) return;
        const tpl = TRACKER_MODULES.find((m) => m.key === key)!;
        if (turningOn && !present.has(key)) {
          const go = await askConfirm(
            `建仓「${key}」？`,
            `启用了「${key}」但 ${tpl.template.name} 还不存在。建仓会让 AI 分段读取本书（细纲/摘要 → 人物库 → 按需回读正文），把当前事实重构成这张表，先写进 待确认/ 给你过目，不直接落位。读取量随章节数增长，token 消耗在建仓任务开始前会再报一次并等你确认。`,
            { confirmLabel: "建仓" },
          );
          if (go) {
            onClose();
            onSendPrompt(buildBootstrapPrompt(key, tpl.template.name));
            onStatus(`「${key}」建仓任务已发送（产物在 待确认/ 过目后落位）`);
          } else {
            onStatus(`「${key}」已启用；${tpl.template.name} 还没建，可以稍后在对话里让 AI 建仓`);
          }
        } else {
          onStatus(turningOn ? `「${key}」已启用` : `「${key}」已停用（文件保留，AI 不再维护）`);
        }
      } finally {
        setBusy(false);
      }
    },
    [project, busy, enabled, present, persistModules, askConfirm, onClose, onSendPrompt, onStatus],
  );

  if (!open) return null;

  return (
    <div
      className="qmodal scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
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
        <h3 id={titleId}>追踪模块</h3>
        <p className="qhint">
          勾选决定 AI 维护哪些追踪表（写在 00-项目状态.md 的「启用模块」行）。停用不删文件；
          启用而文件还没建的，可以让 AI 建仓补建。
        </p>
        {TRACKER_MODULES.map((m) => {
          const on = enabled.has(m.key);
          const has = present.has(m.key);
          return (
            <label key={m.key} className="a-check-row" style={{ display: "flex", gap: 8, padding: "4px 0" }}>
              <input type="checkbox" checked={on} disabled={busy} onChange={() => void toggle(m.key)} />
              <span style={{ flex: 1 }}>
                {m.key} <span style={{ color: "var(--tx-dim)" }}>（{m.template.name}）</span>
              </span>
              <span style={{ color: on ? (has ? "var(--tx-dim)" : "var(--warn)") : "var(--tx-dim)" }}>
                {on ? (has ? "已建" : "未建·勾选后可建仓") : "未启用"}
              </span>
            </label>
          );
        })}
        <div className="a-form-actions">
          <button ref={closeRef} className="btn btn-quiet" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
