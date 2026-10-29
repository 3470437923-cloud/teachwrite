/**
 * 主工作台 —— TeachWrite「付印单」三栏实色布局。
 *
 * 布局：左 = 文件（作品选择 + 目录树）· 中 = 编辑器 · 右 = AI 对话。
 * 会话切换在对话面板顶部的下拉选择框里（没有独立的对话列表栏）。
 *
 * 左栏目录树固定保留三类内容：小说资料 / 章节内容 / 待确认
 * （它们同时是磁盘上的三个目录，类别由路径决定，不随 UI 变化）。
 *
 * 数据纪律（与存储层同一口径）：写前快照、操作日志、候选未采用不回写、
 * 用户手改是最高权威（回流只出报告，动文字必须过 question）。
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useMaximized } from "./useMaximized";
import { useDialogFocus } from "./useDialogFocus";
import { pushEsc } from "./escStack";
import { FOLLOW_SPRING, isNearBottom, springScrollCancel, springScrollToBottom } from "./motion";
import logo from "../assets/logo.png";
import { boot, applyAccentFromPrefs, applyThemeFromPrefs, currentBoot, onBootReplaced, savePrefs } from "../core/app";
import { getFs } from "../core/fsbridge";
import { PROJECT_DIRS, dirname, join, projectManifestFile, PATH_SEP } from "../core/dirs";
import { isoMicros } from "../core/ids";
import {
  chapterLabelOf,
  createProject,
  kindForRel,
  loadProject,
  readProjectStatus,
  scanBooksRoot,
  validateProject,
  type ContentNode,
  type FileKind,
  type FileRef,
  type ProjectData,
  type ProjectRef,
} from "../core/store/project";
import { parseChapterName, stripMd } from "../core/store/chapter";
import { childNameProblem } from "../core/store/names";
import { isManagedDocName } from "../core/store/docschema";
import { appendOplog, diffLines, isLightEdit, pendingRefrows, readOplog, type DiffResult } from "../core/store/oplog";
import { pairedDiff } from "../core/store/pairedDiff";
import { unifyDoubleQuotes } from "../core/store/quotes";
import { createTauriTransport } from "../core/ai/transport";
import { reloadIndex, send as sendChat, sendIsolated } from "../core/ai/controller";
import TitlebarUsage from "./TitlebarUsage";
import WebColumn from "./WebColumn";
import { ZERO_USAGE, addTotals, type UsageTotals } from "../core/usage/stats";
import {
  DEFAULT_THINKING_LEVEL,
  THINKING_STOPS,
  effectiveThinking,
  thinkingSupportedFor,
  type ThinkingLevel,
} from "../core/ai/thinking";
import { AI_MODES, DEFAULT_AI_MODE, type AiMode } from "../core/ai/mode";
import { buildReflowPrompt, buildStyleReflowPrompt, newReflowId, normalizeReflowMode, reflowSessionTitle, reflowTracksFor, REFLOW_MODES, type ReflowMode } from "../core/ai/reflow";
import {
  buildColdFixMessage,
  buildColdReadUserMessage,
  coldReadSystem,
  parseColdReadIssues,
  type ColdReadChannel,
  type ColdReadPrior,
} from "../core/ai/coldread";
import ColdReadPanel, { type ColdPanelState, type ColdRow } from "./ColdReadPanel";
import { useStreamBatcher } from "./useStreamBatcher";
import HelpModal from "./HelpModal";
import WelcomeModal from "./WelcomeModal";
import type { AgentEvent } from "../core/ai/agent";
import type { ChatMessage as ChatMessageType } from "../core/ai/protocol";
import type { QuestionItem } from "../core/tools/exec";
import { isToolErrorResult } from "../core/tools/exec";
import {
  listSessions,
  loadSession,
  newSession,
  uuid,
  type SessionFile,
  type SessionListEntry,
} from "../core/store/session";
import { recordSnapshot } from "../core/store/snapshot";
import { settleSavedTab, settleAdoptedTab, hasNewUnsavedEdits } from "../core/store/authorWrite";
import { serializeManifest } from "../core/store/manifest";
import { scanSkills, mergeSkillList } from "../core/skills/scan";
import { releaseBuiltinSkills } from "../core/skills/builtin";
import MemoModal from "./MemoModal";
import DocTableView from "./DocTable";
import ModulesDialog from "./ModulesDialog";
import { defaultTableView, docTableFor, hasRealTable, applyCellEdit, applyInsertBlock, applyRangeDelete, buildEntryBlock, type CellAddr, type DocTablePart } from "../core/store/doctable";
import { ConfirmDialog, InputDialog, TypedConfirmDialog, type ConfirmRequest, type InputRequest, type TypedConfirmRequest } from "./Dialogs";
import RecycleBin from "./RecycleBin";
import { checkActivity, loadManifest, moveToRecycle } from "../core/store/recycle";
import { deleteSessionsForProject } from "../core/store/session";
import { dropCompressCache } from "../core/ai/compress";
import NewBookWizard from "./NewBookWizard";
import QuickPromptBar from "./QuickPromptBar";
import { useTeaching } from "./useTeaching";
import { DEFAULT_QUICK_PROMPTS } from "../core/store/quickPrompts";
import { onboardingOverrides, type OnboardingAnswers } from "../core/store/onboarding";
import type { TrackerModule } from "../core/store/templates";
import { RULES_DOC, STYLE_DOC } from "../core/store/templates";

interface OpenTab {
  /** 相对作品根路径（'\' 分隔） */
  rel: string;
  path: string;
  name: string;
  kind: FileKind;
  /** 打开时的磁盘内容（写前快照的 previousContent 来源） */
  baseContent: string;
  content: string;
  dirty: boolean;
  /** 正文/候选：是否处于用户编辑态（修改按钮开启） */
  editing: boolean;
  /** 进入编辑态时的内容（回流 diff 基线） */
  editBase: string | null;
}

/** 字数统计：统一按非空白字符计（与「文章总字数」口径一致） */
export function countWords(text: string): number {
  return text.replace(/\s/g, "").length;
}

/** 从工具结果 JSON 里取出错误文案（渲染用） */
export function extractError(result: string): string {
  try {
    const j = JSON.parse(result) as { error?: string };
    return j.error ?? "";
  } catch {
    return "";
  }
}

/** 会话相对时间（N 分钟前 / N 小时前 / 昨天 / 日期）。
 *  N-43：mtime 缺失（索引容错归零）不再显示「1月1日」—— epoch 0 不是
 *  "1970 年 1 月 1 日建的会话"，是"不知道什么时候建的"。 */
export function relTime(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return "时间未知";
  const diff = now - ms;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < hour) return `${Math.max(1, Math.floor(diff / min))} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return "昨天";
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 会话按日分组（今天 / 昨天 / 更早） */
export function groupSessions(
  sessions: SessionListEntry[],
  now = Date.now(),
): { label: string; items: SessionListEntry[] }[] {
  const day = 24 * 60 * 60_000;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  const groups: { label: string; items: SessionListEntry[] }[] = [
    { label: "今天", items: [] },
    { label: "昨天", items: [] },
    { label: "更早", items: [] },
  ];
  for (const s of sessions) {
    const ms = s.mtimeMs ?? 0;
    if (ms >= t0) groups[0].items.push(s);
    else if (ms >= t0 - day) groups[1].items.push(s);
    else groups[2].items.push(s);
  }
  return groups.filter((g) => g.items.length > 0);
}

/**
 * 历史消息行(B19:memo 化)。
 *
 * 为什么要单独成组件并 memo:流式期间在变的只有 streamText / streamThink / toolLog,
 * session.messages 里每条旧消息的**对象引用都没变**(只在回合结束时整体替换一次)。
 * 但旧写法把这段 JSX 摊在主工作台里,于是每帧都要重新 diff 全部历史
 * (真实最大会话:108 条消息 + 120K 字符思考流 + 171 行工具调用)——
 * 快捷提示词跑的正是这条最长的流程,主线程被逐帧占满,表现为「偶尔崩溃/无响应」。
 * 抽成 memo 组件后,流式期间的每次重渲染整段历史子树直接跳过。
 */
const ChatMessageRow = memo(function ChatMessageRow({ m }: { m: ChatMessageType }) {
  if (m.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{m.text}</div>
      </div>
    );
  }
  return (
    <div className="msg ai">
      <div className="who">TeachWrite</div>
      {m.thinking ? <div className="think">{m.thinking}</div> : null}
      {(m.toolCalls ?? []).map((t) => {
        // N-42:失败判定走契约结构(isToolErrorResult),不再子串嗅探
        const bad = isToolErrorResult(t.result);
        return (
          <div key={t.callId} className="tool-line">
            <svg viewBox="0 0 20 20" className="ic ic-14">
              <path d="M7.5 3.5h-3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-3" />
              <path d="M11.5 8.5l6-6M17.5 5.5v-3h-3" />
            </svg>
            {t.name} {bad ? <span className="bad">✕</span> : <span className="ok">✓</span>}
            {bad ? " " + extractError(t.result ?? "") : ""}
          </div>
        );
      })}
      {m.text ? <div className="bubble">{m.text}</div> : null}
    </div>
  );
});

/** 目录树默认开合：全部展开，「已处理」归档默认折叠 */
function defaultTreeFolders(tree: ContentNode[], acc: Record<string, boolean> = {}): Record<string, boolean> {
  for (const n of tree) {
    if (n.isDir) {
      acc[n.rel] = n.name !== PROJECT_DIRS.processed;
      defaultTreeFolders(n.children, acc);
    }
  }
  return acc;
}

/** 点击弹层外部 / Esc 时收起（会话下拉与作品下拉共用） */
function useDismiss(active: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [active, ref, close]);
}

/** 旧常量名为兼容保留：当前仅讨论章节写作目标，不请求AI正文。
 *  文本真源在 core/store/quickPrompts.ts（DEFAULT_QUICK_PROMPTS 首条）——
 *  快捷提示词栏的默认条目与这里的欢迎页/一键指令同源，不各写一遍。 */
export const WRITE_NEXT_MESSAGE = DEFAULT_QUICK_PROMPTS[0].text;

/** 对话空态的快捷提示（点击预填输入框，用户可改后再发送）。
 *  与快捷提示词栏的默认清单同源（同一份常量派生，避免两处文案漂移） */
const STARTER_TIPS: { label: string; text: string }[] = DEFAULT_QUICK_PROMPTS.map((p) => ({ label: p.label, text: p.text }));

/** 兼容旧调用者：采用已由作者在应用内完成，AI只核对正式正文后的资料。 */
export function adoptMessage(pendingRel: string): string {
  const rel = pendingRel.replace(/\\/g, "/");
  return "【作者已采用旧稿】来源 " + rel + "。作者采用动作不重复确认。请先读取对应章节内容的实际正式正文，按它核对小说资料。" +
    "你不得保存、修改或移动正文与候选稿，不得自行推进章节或创建归档凭据。每次资料变更仍须作者确认。" +
    "只增量维护00声明启用的追踪表，注明来源章节；中断先补余项，不重复累计。资料回流后由作者核对并确认归档，才开放下一章导览。";
}
/** 保存门：失败时保留编辑态；采用阶段负责结束编辑与发送，不启动候选回流。 */
export async function adoptAfterSave(
  save: () => Promise<boolean>,
  adopt: () => Promise<void>,
): Promise<boolean> {
  if (!(await save())) return false;
  await adopt();
  return true;
}

/** 标签是否处于可输入状态：资料永远可编辑；正文/候选仅在用户点了「修改」后可编辑 */
export function tabEditable(t: OpenTab): boolean {
  return t.kind === "doc" || t.editing;
}

export default function MainWorkbench({
  onOpenSettings,
  suspended = false,
}: {
  onOpenSettings: () => void;
  /** 设置屏在侧（N-05：本组件常驻挂载、仅隐藏）：全局按键监听挂闸，防双份 Ctrl+S */
  suspended?: boolean;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [project, setProject] = useState<ProjectData | null>(null);
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [activeRel, setActiveRel] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // ── 面板与目录状态（可见性持久化到 prefs 面板键） ──
  const [showFiles, setShowFiles] = useState(true);
  const [showChat, setShowChat] = useState(true);
  const [bookMenu, setBookMenu] = useState(false);
  const [sessMenu, setSessMenu] = useState(false);
  /** 目录树文件夹开合（key = 目录相对路径；缺省视为展开，「已处理」默认折叠） */
  const [treeFolders, setTreeFolders] = useState<Record<string, boolean>>({});
  /** 冷读悬浮面板（D-045）：null = 关闭；全部状态在内存里，关窗即弃 */
  const [cold, setCold] = useState<ColdPanelState | null>(null);
  const fileselRef = useRef<HTMLDivElement | null>(null);
  const sessRef = useRef<HTMLDivElement | null>(null);
  useDismiss(bookMenu, fileselRef, () => setBookMenu(false));
  useDismiss(sessMenu, sessRef, () => setSessMenu(false));

  // ── 对话状态 ──
  const [session, setSession] = useState<SessionFile | null>(null);
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamThink, setStreamThink] = useState("");
  const [toolLog, setToolLog] = useState<{ name: string; status: "run" | "ok" | "bad" }[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);
  /** 截断提示（非错误：正文已落盘可用，只是可能少了个尾巴） */
  const [truncNote, setTruncNote] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    items: QuestionItem[];
    resolve: (a: string[][]) => void;
  } | null>(null);
  const [qSel, setQSel] = useState<Record<number, string[]>>({});
  const chatScroll = useRef<HTMLDivElement | null>(null);
  /** 是否自动跟随到最新一条：用户往上翻时置 false，翻回底部再置 true */
  const pinned = useRef(true);
  /**
   * 弹簧写入守卫（流式滚动锁死的修复核心）：弹簧写 scrollTop 会触发 scroll 事件，
   * 不区分的话 onChatScroll 会把弹簧自己写的每一帧都当成「用户滚了」——
   * 跟随被反复取消又重算，用户的上滚紧接着被下一帧拽回底部，表现为
   * 「流式输出时对话框定住、怎么都滑不动」。记的是**最后写入的值**而不是布尔旗：
   * 浏览器合并派发 scroll 事件时布尔旗会张冠李戴（实测：上滚与弹簧写入合并成
   * 一条事件，用户滚动被吞）；scroll 事件读到的 scrollTop 永远是最新值，
   * 与弹簧最后写入值一致 = 程序写入，不一致 = 用户滚动。
   */
  const lastSpringWrite = useRef<number | null>(null);
  /** 是否贴底（pinned 的 state 镜像，渲染「回到底部」悬浮钮用） */
  const [atBottom, setAtBottom] = useState(true);
  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });
  /** 挂起中的 question 弹窗（停止生成时强制空选择收尾，避免弹窗残留卡住 agent 循环） */
  const pendingQuestionRef = useRef<{ items: QuestionItem[]; resolve: (v: string[][]) => void } | null>(null);
  const transport = useMemo(() => createTauriTransport(), []);
  /** 冷读专用传输实例（D-058）：中止槽按实例隔离，冷读的「停止」不会误杀聊天/回流的流，
   *  反之亦然；两条流可以真并发（账号级并发上限远够）。 */
  const coldTransport = useMemo(() => createTauriTransport(), []);
  /** 冷读自己的中止信号（与聊天/回流的 abortRef 分开） */
  const coldAbortRef = useRef<{ aborted: boolean }>({ aborted: false });
  /** busy 的 ref 镜像（回流排队判断用，避开闭包过期） */
  const busyRef = useRef(false);
  /** 回流任务队列（单生成并发：忙时排队，空闲即跑）。reflowId 与 oplog 的 pending/完成行配对 */
  const reflowQueue = useRef<{ prompt: string; title: string; reflowId: string; track: "facts" | "style" }[]>([]);
  /** 回流模式（D-043 四态；按书记住，读不到按 all） */
  const [reflowMode, setReflowMode] = useState<ReflowMode>("all");
  /** 回流模式下拉的开合 */
  const [reflowMenu, setReflowMenu] = useState(false);
  const reflowRef = useRef<HTMLDivElement | null>(null);
  useDismiss(reflowMenu, reflowRef, () => setReflowMenu(false));
  /** 资料表格视图（B7）：按书记住的默认（manifest.viewMode）+ 本会话内按标签的覆盖 */
  const [bookViewMode, setBookViewMode] = useState<"table" | "original" | null>(null);
  const [tableOverride, setTableOverride] = useState<Record<string, boolean>>({});

  // ── 备忘录与应用内对话框 ──
  const [memoOpen, setMemoOpen] = useState(false);
  /** 使用教程(B19/D-053):标题栏「帮助」入口 */
  const [helpOpen, setHelpOpen] = useState(false);
  /** 首启欢迎弹窗:装配完成后按 prefs.welcomeDismissed 决定 */
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [inputReq, setInputReq] = useState<InputRequest | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [typedReq, setTypedReq] = useState<TypedConfirmRequest | null>(null);
  /** 回收站模态 + 条目数（书下拉菜单的角标） */
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [recycleItems, setRecycleItems] = useState(0);
  /** 追踪模块管理（B8：启用/停用 + 中途建仓） */
  const [modulesOpen, setModulesOpen] = useState(false);
  /** 网页版参考栏（D-057）：DeepSeek 网页版 / 朱雀AI检测。
      默认隐藏、只存内存、不写 prefs（封闭键集合纪律——重启回默认关）。 */
  const [webCols, setWebCols] = useState({ ds: false, zq: false });

  /** 补跑回流的间接引用（函数声明在组件后段，openProject 在前段 —— 用 ref 打通顺序） */
  const resumePendingRef = useRef<(root: string) => void>(() => {});

  /** 应用内输入框（替代 window.prompt；resolve 时同步关闭对话框）；initial 预填（重命名场景） */
  const askText = useCallback(
    (title: string, placeholder?: string, initial?: string) =>
      new Promise<string | null>((resolve) => {
        setInputReq({
          title,
          placeholder,
          initial,
          resolve: (v) => {
            setInputReq(null);
            resolve(v);
          },
        });
      }),
    [],
  );
  const askConfirm = useCallback(
    (title: string, body?: string, opts?: { danger?: boolean; confirmLabel?: string }) =>
      new Promise<boolean>((resolve) => {
        setConfirmReq({
          title,
          body,
          ...opts,
          resolve: (ok) => {
            setConfirmReq(null);
            resolve(ok);
          },
        });
      }),
    [],
  );

  /**
   * AI 三态模式（只读/写作/开发；2026-10-06 用户裁决）：默认开发、只存内存、
   * 重启回开发（「不记住」）。双闸在 core/ai/mode.ts → controller → exec。
   * 采用门与回流要写 小说资料/，只在资料维护模式可用（只读/写作下弹窗告知）。
   */
  const [aiMode, setAiMode] = useState<AiMode>(DEFAULT_AI_MODE);
  /** aiMode 的 ref 镜像（回流排空等回调读最新值，避开闭包过期） */
  const aiModeRef = useRef(aiMode);
  aiModeRef.current = aiMode;

  /**
   * 「需要资料维护模式」弹窗门（用户裁决：只读/写作模式下采用与回流直接弹窗，
   * 不静默跳过）。返回 true = 已是资料维护模式或用户当场切到资料维护模式。
   */
  const requireDevMode = useCallback(
    async (what: string): Promise<boolean> => {
      if (aiMode === "dev") return true;
      const cur = AI_MODES.find((m) => m.id === aiMode)?.label ?? aiMode;
      const switchNow = await askConfirm(
        `「${what}」需要资料维护模式`,
        `当前是${cur}模式：${what}会让 AI 读写 小说资料/ 下的维护文档，只有资料维护模式允许。\n要现在切到资料维护模式吗？`,
        { confirmLabel: "切到资料维护模式" },
      );
      if (switchNow) setAiMode("dev");
      return switchNow;
    },
    [aiMode, askConfirm],
  );

  // ── 根外路径确认（B-1 UI 接线）──
  /** 会话内已批准的根外目录（exec.ts 按引用追加，同会话后续访问不再重复询问）。
   *  用 ref 而非 state：它是工具执行层的内部台账，不参与渲染；换会话即清空。 */
  const allowedDirsRef = useRef<string[]>([]);
  useEffect(() => {
    allowedDirsRef.current = [];
  }, [session?.id]);

  /** 工具要访问作品根之外的绝对路径时问用户。
   *  链路：exec.ts pathGuard「需确认」→ ToolContext.confirmExternal → 这里。
   *  正文必须带**绝对路径原文** —— 用户得看懂它要去动哪里才能做决定。 */
  const confirmExternal = useCallback(
    (absPath: string) =>
      askConfirm(
        "允许访问作品根之外的路径？",
        `AI 请求访问作品根之外的路径：\n${absPath}\n批准后本次会话内该目录下的后续访问不再询问。`,
        { confirmLabel: "允许" },
      ),
    [askConfirm],
  );

  /** 手打名字确认（彻底删除/清空回收站；不拿到一致的名字就不给确认键） */
  const askTypedConfirm = useCallback(
    (title: string, body: string, expected: string, confirmLabel?: string, noun?: string) =>
      new Promise<boolean>((resolve) => {
        setTypedReq({
          title,
          body,
          expected,
          noun,
          confirmLabel,
          resolve: (ok) => {
            setTypedReq(null);
            resolve(ok);
          },
        });
      }),
    [],
  );

  const dirs = currentBoot()?.dirs ?? null;

  const activeTab = useMemo(() => tabs.find((t) => t.rel === activeRel) ?? null, [tabs, activeRel]);

  /** 当前资料标签的表格数据（B7；正文/候选不适用 → null） */
  const activeDocTable = useMemo(
    () => (activeTab && activeTab.kind === "doc" ? docTableFor(activeTab.name, activeTab.content) : null),
    [activeTab],
  );
  /** 当前资料标签是否有**真表格**（grid/kv）——纯散文文档不给切换钮（D-061） */
  const activeTableAvailable = Boolean(activeDocTable && hasRealTable(activeDocTable));
  /** 当前标签是否按表格显示：会话内按标签的覆盖 > 按书记住的默认 > 按文件类型的默认 */
  const activeTableView = Boolean(
    activeTab &&
      activeTableAvailable &&
      (tableOverride[activeTab.rel] ??
        (bookViewMode ? bookViewMode === "table" : defaultTableView(activeTab.name))),
  );

  // 字号与模型（prefs 直读；N-05 常驻挂载后：savePrefs 替换 boot 单例对象，
  // 返回主界面的重渲染即读到新值——不再依赖「重挂载即生效」）
  const bootPrefs = ready ? currentBoot()?.prefs ?? null : null;
  const editorFontSize = bootPrefs?.editorFontSize ?? 15;
  const chatFontSize = bootPrefs?.chatFontSize ?? 15;
  const modelLabel = bootPrefs?.model?.trim() || "未配置模型";
  const hasKey = Boolean(bootPrefs?.apiKey?.trim());

  /**
   * 会话级思考档位（D-011）：`null` = 跟随配置默认；一旦用户在本会话里选过就是临时值，
   * **只存内存**（不写会话文件、不碰磁盘契约），换会话/重启即回到配置默认。
   */
  const [thinkLevel, setThinkLevel] = useState<ThinkingLevel | null>(null);
  const [thinkOpen, setThinkOpen] = useState(false);
  /* 档位浮层与会话/作品下拉同一条纪律：点击外部或 Esc 必须收起。
     此前它没有挂 useDismiss —— 不点选就永远悬在输入区与快捷指令行
     之上（用户报的"思考模式 UI 堆叠"）：浮层压住别的控件，却怎么点
     别处都不消失。 */
  const thinkRef = useRef<HTMLDivElement | null>(null);
  useDismiss(thinkOpen, thinkRef, () => setThinkOpen(false));
  const thinkSupported = bootPrefs ? thinkingSupportedFor(bootPrefs) : false;
  const thinkEffective = bootPrefs ? effectiveThinking(bootPrefs, thinkLevel) : DEFAULT_THINKING_LEVEL;
  const thinkStop = THINKING_STOPS.find((s) => s.level === thinkEffective) ?? THINKING_STOPS[2];

  /**
   * 「本次会话累计」（D-019）：按会话 id 存内存，切会话即显示那一份，重启即尽。
   * 不落盘 —— 会话文件是冻结契约，统计是旁路数据（真要持久化也应进 usage_stats.json）。
   */
  const [usageBySession, setUsageBySession] = useState<Record<string, UsageTotals>>({});
  const sessionUsage = session ? usageBySession[session.id] ?? ZERO_USAGE : ZERO_USAGE;

  // 生成中收起档位浮层：它悬在输入框上方，跑起来就挡字了
  useEffect(() => {
    if (busy) setThinkOpen(false);
  }, [busy]);

  /** 保存单个标签（写前快照 + 落盘 + oplog；不弹确认——3.0 起自动保存） */
  const saveTabAs = useCallback(
    async (tab: OpenTab, note?: string): Promise<boolean> => {
      if (tab.content === tab.baseContent && !tab.dirty) return true;
      try {
        const fs = getFs();
        const b = currentBoot();
        // 写前快照（硬约束：手动保存与工具回写同纪律）
        if (b) {
          await recordSnapshot(fs, b.dirs.snapshotsDir, {
            sessionId: session?.id ?? "manual-edits",
            callId: `manual_${Date.now()}`,
            operation: "write",
            relativePath: tab.rel.replace(/\\/g, "/"),
            previousContent: tab.baseContent,
            previousExists: true,
            previousType: "file",
          });
        }
        await fs.writeText(tab.path, tab.content);
        setTabs((prev) =>
          prev.map((t) => (t.rel === tab.rel ? settleSavedTab(t, tab.content) : t)),
        );
        if (project) {
          await appendOplog(fs, project.ref.root, "save", tab.rel, session?.id ?? "", note ? { note } : {});
        }
        return true;
      } catch (e) {
        setStatus(`保存失败：${String(e)}`);
        return false;
      }
    },
    [project, session],
  );

  /**
   * 切作品/关窗：自动保存所有脏标签；编辑态补记 edit_end（回流顺延，不在关闭时跑 AI）。
   * 返回值 = 是否全部落盘成功（关窗守卫据此决定放不放行；调用方不关心的可以忽略）。
   * oplog 是旁路日志：它失败不许拦住保存，更不许把关窗处理器整死（appendOplog 抛错 →
   * preventDefault 已执行而 destroy 永远到不了，窗口关不掉）。
   */
  const autoSaveAllTabs = useCallback(async (): Promise<boolean> => {
    const fs = getFs();
    let allOk = true;
    for (const t of tabs) {
      if (t.dirty) {
        const ok = await saveTabAs(t, "自动保存");
        if (!ok) allOk = false;
      }
      if (t.editing && t.editBase !== null && project) {
        try {
          const diff = diffLines(t.editBase, t.content);
          await appendOplog(fs, project.ref.root, "edit_end", t.rel, session?.id ?? "", {
            changedChars: diff.changedChars,
            addedLines: diff.added.length,
            removedLines: diff.removed.length,
            digitsChanged: diff.digitsChanged,
            reflowTriggered: false,
            note: "窗口关闭或切换作品：已自动保存，回流顺延（可稍后再点一次修改/完成或让 AI 总结改稿）",
          });
        } catch {
          // 日志写不进去不拦流程（正文已经保存过了）
        }
      }
    }
    if (hasNewUnsavedEdits(tabs,tabsRef.current)) allOk = false;
    return allOk;
  }, [tabs, project, session, saveTabAs]);

  /** 装配数据：载入作品（不改 prefs；启动恢复与 openProject 共用） */
  const openProjectRef = useCallback(
    async (ref: ProjectRef) => {
      if (busyRef.current) { setStatus("请先停止或等待当前AI任务结束再切换作品。"); return; }
      if (!(await autoSaveAllTabs())) { setStatus("仍有未保存的修改，未切换作品。"); return; }
      const fs = getFs();
      const data = await loadProject(fs, ref.root, ref.name);
      setProject(data);
      setTabs([]);
      setActiveRel(null);
      setTreeFolders(defaultTreeFolders(data.tree));
      // D-043：读该书记住的回流模式（老作品清单里没有这个字段 → 默认 all）
      setReflowMode(normalizeReflowMode(data.manifest.reflowMode) ?? "all");
      // B7：读该书记住的资料默认视图（无则按文件类型的默认）
      setBookViewMode(data.manifest.viewMode === "table" ? "table" : data.manifest.viewMode === "original" ? "original" : null);
      setTableOverride({});
      // I-3：状态条直接显示"写作进度"（读 00-项目状态.md 的头部字段），
      // 不再只报文件计数 —— 应用自己就能回答"现在到哪一步了"。
      let statusNote = "";
      try {
        const st = await readProjectStatus(fs, ref.root);
        if (st && (st.progress || st.chapter)) {
          statusNote = ` · 进度：${st.progress || "未记录"}（当前章节：${st.chapter || "未记录"}）`;
        }
      } catch {
        /* 状态读取失败不影响打开 */
      }
      const baseStatus = `${ref.name}：${data.chapters.length} 章 / ${data.pending.length} 待确认 / ${data.docs.length} 份资料${statusNote}`;
      setStatus(baseStatus);
      // I-12 UI 接线：打开即校验（外部放进作品根的内容第一次有了"看一看"的入口）。
      // 校验只读不判（见 validateProject 注释）；失败不阻断打开，状态条汇总即可。
      try {
        const issues = await validateProject(fs, ref.root);
        if (issues.length > 0) {
          const worst = issues.find((i) => i.level === "error") ?? issues[0];
          setStatus(`${baseStatus} · 结构校验 ${issues.length} 项提示（${worst.message}）`);
        }
      } catch {
        /* 校验本身出错不打扰打开 */
      }
      await appendOplog(fs, ref.root, "switch_project", "", session?.id ?? "");
      // D-043：补跑关窗时丢掉的回流（oplog 的 pending 行驱动）
      resumePendingRef.current(ref.root);
    },
    [autoSaveAllTabs, session],
  );

  /** 装配节拍：0 = 首次启动；+1 = 存储路径变更（N-05：常驻挂载后由
   *  onBootReplaced 通知重装配——作品根/技能根变了必须重扫，否则界面停在旧根上） */
  const [assembleTick, setAssembleTick] = useState(0);

  /** 首次启动：装配桥与目录，扫描作品 + 技能；恢复上次打开的作品与面板可见性 */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const b = await boot();
        applyAccentFromPrefs(b.prefs);
        applyThemeFromPrefs(b.prefs);
        if (!alive) return;
        setShowFiles(b.prefs.panelShowDirectory);
        setShowChat(b.prefs.panelShowSession);
        const fs = getFs();
        const list = await scanBooksRoot(fs, b.dirs.booksRoot);
        if (!alive) return;
        setProjects(list);
        setReady(true);
        setStatus(`作品根：${b.dirs.booksRoot}`);
        // 首启欢迎弹窗(B19/D-053):用户没勾「不再显示」才弹;装配完成才判,
        // 避免拿默认值在配置读出来之前抢弹一次。
        setWelcomeOpen(!b.prefs.welcomeDismissed);
        const last = b.prefs.currentNovelProject?.trim();
        if (last) {
          const ref = list.find((p) => p.root.toLowerCase() === last.toLowerCase());
          if (ref) await openProjectRef(ref);
        }
        // 技能扫描（只读）：skill_list 为空或目录有变化时刷新
        try {
          // A-8：先释放内置技能资产（只补缺失、不覆盖用户副本；见 skills/builtin.ts），
          // 首次启动即可看到 5 个内置技能；释放失败不阻断扫描（有多少用多少）
          try {
            await releaseBuiltinSkills(fs, b.dirs.skillsDir);
          } catch {
            /* 释放失败不阻断启动 */
          }
          const scanned = await scanSkills(fs, b.dirs.skillsDir);
          if (scanned.length > 0) {
            const { skillList, activeSkillIds } = mergeSkillList(b.prefs.skillList, scanned, b.prefs.activeSkillIds);
            if (JSON.stringify(skillList) !== JSON.stringify(b.prefs.skillList)) {
              await savePrefs({ ...b.prefs, skillList, activeSkillIds });
            }
          }
        } catch {
          // 技能扫描失败不阻断启动
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assembleTick]);

  // N-05 配套：设置屏改「存储位置」→ boot 单例已即时重推（savePrefs），
  // 这里重新走一遍装配（旧作品的脏标签先由 openProjectRef 内的 autoSaveAllTabs 落盘）
  useEffect(() => onBootReplaced(() => setAssembleTick((t) => t + 1)), []);

  const refreshProjects = useCallback(async () => {
    if (!dirs) return;
    const fs = getFs();
    setProjects(await scanBooksRoot(fs, dirs.booksRoot));
  }, [dirs]);

  const openProject = useCallback(
    async (ref: ProjectRef) => {
      if (busyRef.current) { setStatus("请先停止或等待当前AI任务结束再切换作品。"); return; }
      setBookMenu(false);
      if (!(await autoSaveAllTabs())) { setStatus("仍有未保存的修改，未切换作品。"); return; }
      const fs = getFs();
      const data = await loadProject(fs, ref.root, ref.name);
      setProject(data);
      setTabs([]);
      setActiveRel(null);
      setTreeFolders(defaultTreeFolders(data.tree));
      // D-043：读该书记住的回流模式（老作品清单里没有这个字段 → 默认 all）
      setReflowMode(normalizeReflowMode(data.manifest.reflowMode) ?? "all");
      // B7：读该书记住的资料默认视图（无则按文件类型的默认）
      setBookViewMode(data.manifest.viewMode === "table" ? "table" : data.manifest.viewMode === "original" ? "original" : null);
      setTableOverride({});
      setStatus(`${ref.name}：${data.chapters.length} 章 / ${data.pending.length} 待确认 / ${data.docs.length} 份资料`);
      await appendOplog(fs, ref.root, "switch_project", "", session?.id ?? "");
      // D-043：补跑关窗时丢掉的回流（oplog 的 pending 行驱动）
      resumePendingRef.current(ref.root);
      const b = currentBoot();
      if (b && b.prefs.currentNovelProject !== ref.root) {
        const next = { ...b.prefs, currentNovelProject: ref.root };
        void savePrefs(next);
      }
    },
    [autoSaveAllTabs, session],
  );

  /** 面板开关（可见性写回 prefs 面板键，重启后保持） */
  const toggleFiles = useCallback(() => {
    const next = !showFiles;
    setShowFiles(next);
    const b = currentBoot();
    if (b && b.prefs.panelShowDirectory !== next) void savePrefs({ ...b.prefs, panelShowDirectory: next });
  }, [showFiles]);

  const toggleChat = useCallback(() => {
    const next = !showChat;
    setShowChat(next);
    const b = currentBoot();
    if (b && b.prefs.panelShowSession !== next) void savePrefs({ ...b.prefs, panelShowSession: next });
  }, [showChat]);

  /** 永久关闭首启弹窗:落 prefs 扩展键 welcome_dismissed(D-053 的 ADR;只写不删) */
  const dismissWelcome = useCallback(() => {
    setWelcomeOpen(false);
    const b = currentBoot();
    if (b && !b.prefs.welcomeDismissed) void savePrefs({ ...b.prefs, welcomeDismissed: true });
  }, []);

  const openFile = useCallback(
    async (ref: FileRef, kind: FileKind) => {
      if (!project) return;
      const fs = getFs();
      const existing = tabs.find((t) => t.rel === ref.rel);
      if (existing) {
        setActiveRel(ref.rel);
        return;
      }
      // 资料单槽一读：打开任何新文件前，旧资料标签自动保存并销毁（正文/候选不占资料槽）。
      // N-06：保存失败就不换槽 —— 旧资料内容只在这个 tab 里，销毁等于丢稿
      const docTab = tabs.find((t) => t.kind === "doc");
      if (docTab) {
        if (docTab.dirty) {
          const ok = await saveTabAs(docTab, "资料单槽切换自动保存");
          if (!ok) return;
        }
        setTabs((prev) => prev.filter((t) => t.kind !== "doc"));
      }
      let content = "";
      try {
        content = await fs.readText(ref.path);
      } catch (e) {
        setStatus(`打开失败：${String(e)}`);
        return;
      }
      setTabs((prev) => [
        ...prev,
        { rel: ref.rel, path: ref.path, name: ref.name, kind, baseContent: content, content, dirty: false, editing: false, editBase: null },
      ]);
      setActiveRel(ref.rel);
      await appendOplog(fs, project.ref.root, "open", ref.rel, session?.id ?? "");
    },
    [project, tabs, saveTabAs, session],
  );

  const editContent = useCallback(
    (text: string) => {
      setTabs((prev) =>
        prev.map((t) => (t.rel === activeRel && tabEditable(t) ? { ...t, content: text, dirty: true } : t)),
      );
    },
    [activeRel],
  );

  const saveActive = useCallback(async () => {
    if (!activeTab || !tabEditable(activeTab)) return;
    setSaving(true);
    const ok = await saveTabAs(activeTab);
    if (ok) setStatus(`已保存 ${activeTab.name} · ${countWords(activeTab.content)} 字`);
    setSaving(false);
  }, [activeTab, saveTabAs]);

  /** Ctrl+S 保存（仅可编辑态；设置屏在侧时让位给设置屏自己的 Ctrl+S —— N-05 常驻挂载的配套闸） */
  useEffect(() => {
    if (suspended) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveActive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveActive, suspended]);

  /** 关窗守卫：自动保存全部脏标签与编辑态（3.0 语义：不丢稿、不询问）。
      有任何一个标签写盘失败就**不销毁窗口** —— 旧实现拿到 false 也照关，
      磁盘写失败时脏标签内容静默丢失，恰好违背"不丢稿"这条语义本身。 */
  useEffect(() => {
    let disposed = false;
    const unlistenP = getCurrentWindow().onCloseRequested(async (event) => {
      if (!tabs.some((t) => t.dirty || t.editing)) return; // 无未保存内容放行
      event.preventDefault();
      const ok = await autoSaveAllTabs();
      if (disposed) return;
      if (ok) {
        await getCurrentWindow().destroy();
      } else {
        setStatus("有内容写入失败，窗口未关闭；请检查磁盘可写后重试（或先手动 Ctrl+S 保存）");
      }
    });
    return () => {
      disposed = true;
      void unlistenP.then((fn) => fn());
    };
  }, [tabs, autoSaveAllTabs]);

  /** 「新建作品」入口：打开开书引导（引导开书 / 空白开书两条路都在向导里） */
  const [newBookOpen, setNewBookOpen] = useState(false);
  const newProject = useCallback(() => setNewBookOpen(true), []);

  /**
   * 向导提交：建作品并打开。
   * answers 非空时经 onboardingOverrides 把答案定向填进 01-开书定位 / 02-核心设定
   * （只替换「待填写」行，见 onboarding.ts 的契约）；modules 是用户勾选的追踪模块
   * （B2，传给 createProject）；返回错误文案给向导原地展示。
   */
  const createBook = useCallback(
    async (name: string, answers: OnboardingAnswers | null, modules: TrackerModule[]): Promise<string | null> => {
      if (!dirs) return "作品目录尚未加载，请稍后再试";
      try {
        const ref = await createProject(
          getFs(),
          dirs.booksRoot,
          name,
          answers ? onboardingOverrides(answers) : undefined,
          modules,
        );
        setNewBookOpen(false);
        await refreshProjects();
        await openProject(ref);
        setStatus(
          answers
            ? `「${ref.name}」已创建：开书材料已按引导预填，可随时与 AI 继续讨论补齐`
            : `「${ref.name}」已创建`,
        );
        return null;
      } catch (e) {
        return `新建失败：${String(e instanceof Error ? e.message : e)}`;
      }
    },
    [dirs, refreshProjects, openProject],
  );

  /** 回收站条目数（书下拉菜单角标）；读不到按 0，不让角标拖垮主界面 */
  const refreshRecycleCount = useCallback(async () => {
    if (!dirs) return;
    try {
      setRecycleItems((await loadManifest(getFs(), dirs.booksRoot)).items.length);
    } catch {
      setRecycleItems(0);
    }
  }, [dirs]);

  useEffect(() => {
    void refreshRecycleCount();
  }, [refreshRecycleCount, projects]);

  /**
   * 移入回收站（两段式删除的第一段：可还原）。
   *
   * 三道门在动作前：
   *   ① 活动门（checkActivity）—— 正在生成 / 当前会话属于它 / 编辑器开着它的文件，一律先拒绝；
   *   ② 名字门（moveToRecycle 内的 childNameProblem + 作品根直接子项校验）；
   *   ③ 用户确认（说清楚"可还原"和"会话不跟着回来"）。
   * 彻底删除的门在回收站里（四道门 + 手打名字），见 RecycleBin。
   */
  const recycleProject = useCallback(
    async (ref: ProjectRef) => {
      if (!dirs) return;
      const fs = getFs();
      const block = checkActivity(
        {
          busy: busyRef.current,
          sessionProjectPath: session?.projectPath ?? null,
          openFilePath: activeTab?.path ?? null,
        },
        ref.root,
      );
      if (block) {
        setStatus(`不能删除「${ref.name}」：${block}`);
        return;
      }
      const ok = await askConfirm(
        "移入回收站？",
        `「${ref.name}」会移到回收站，可以还原。它的会话记录会一并删除 —— 还原作品不会带回这些会话。`,
        { danger: true, confirmLabel: "移入回收站" },
      );
      if (!ok) return;
      try {
        await moveToRecycle(fs, dirs.booksRoot, { name: ref.name, originalPath: ref.root });
        const gone = await deleteSessionsForProject(fs, dirs.sessionsDir, ref.root);
        // 会话没了，AI 侧的压缩检查点缓存也要跟着放掉（KL-AI-11）
        for (const id of gone.ids) dropCompressCache(id);
        // 原版文案就是「已移至回收站，并删除 N 个会话」，N 为 0 时不画蛇添足
        setStatus(gone.count > 0 ? `已移至回收站，并删除 ${gone.count} 个会话` : "已移至回收站");
        // 删掉的正是当前作品：清空工作台，别停在一棵已经不存在的树上
        if (project?.ref.root.toLowerCase() === ref.root.toLowerCase()) {
          setProject(null);
          setTabs([]);
          setActiveRel(null);
          setTreeFolders({});
          setSession(newSession(""));
        }
        await refreshProjects();
        await refreshRecycleCount();
      } catch (e) {
        setStatus(`移至回收站失败：${String(e instanceof Error ? e.message : e)}`);
      }
    },
    [dirs, session, activeTab, project, askConfirm, refreshProjects, refreshRecycleCount],
  );

  /** 继续写作：优先打开**章号最大**的候选稿，其次第一章、第一份资料（无作品则提示） */
  const continueWriting = useCallback(async () => {
    if (!project) {
      setStatus("请先在左侧文件面板选择作品");
      return;
    }
    // D-2：候选按章号最大挑，不再取数组末位 —— listPending 的排序是
    // 文件名比较序（"第10章"排在"第2章"前面），与"写作推进到哪了"不是一回事
    const latestPending = project.pending.reduce<FileRef | null>((best, p) => {
      if (!best) return p;
      const n = parseChapterName(p.name);
      const b = parseChapterName(best.name);
      if (n === null) return best;
      if (b === null) return p;
      return n > b ? p : best;
    }, null);
    const target = latestPending ?? project.chapters[project.chapters.length - 1] ?? project.docs[0];
    if (!target) {
      setStatus(`${project.ref.name} 还没有章节或资料`);
      return;
    }
    await openFile(target, kindForRel(target.rel));
  }, [project, openFile]);

  const win = getCurrentWindow();
  const maxed = useMaximized();

  const refreshSessions = useCallback(async () => {
    const b = currentBoot();
    if (!b) return;
    const idx = await reloadIndex(b.dirs);
    setSessions(listSessions(idx, project?.ref.root ?? null));
  }, [project]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  /** question 工具 → 界面弹窗 */
  const askQuestions = useCallback(
    (items: QuestionItem[]) =>
      new Promise<string[][]>((resolve) => {
        // 包装 resolve：无论正常提交还是「停止生成」强制收尾，都先清挂起引用
        const wrapped = (v: string[][]) => {
          pendingQuestionRef.current = null;
          resolve(v);
        };
        pendingQuestionRef.current = { items, resolve: wrapped };
        setQSel({});
        setPending({ items, resolve: wrapped });
      }),
    [],
  );

  /* 流式增量合批(B19 崩溃根因修复):每个 token 一次 setState = 每 token 重渲染
     整棵工作台(全部历史 + 每条思考块 + 每条工具行),且 `t => t + delta` 每 token
     复制一遍已流出全文(O(n²) 分配)。快捷词跑的是最长的流程,几万字时主线程被压死,
     表现为「偶尔崩溃/无响应」。这里改成按帧合流:一帧内几十个 token 只落一次 state。 */
  const textBatch = useStreamBatcher(useCallback((merged: string) => setStreamText((t) => t + merged), []));
  const thinkBatch = useStreamBatcher(useCallback((merged: string) => setStreamThink((t) => t + merged), []));

  /* 冷读同理(它是第二条流):增量只进悬浮面板,但 setState 挂在本组件上,
     每 token 一次同样会重渲染整棵树。这里合批到每帧一次。 */
  const coldBatch = useStreamBatcher(
    useCallback((merged: string) => setCold((c) => (c ? { ...c, streaming: c.streaming + merged } : c)), []),
  );

  const onAgentEvent = useCallback(
    (e: AgentEvent) => {
      switch (e.type) {
        case "thinking_delta":
          thinkBatch.push(e.text);
          break;
        case "text_delta":
          textBatch.push(e.text);
          break;
        case "tool_started":
          setToolLog((l) => [...l, { name: e.call.name, status: "run" }]);
          break;
        case "tool_completed":
          setToolLog((l) => {
            const next = [...l];
            const i = next.findIndex((x) => x.name === e.call.name && x.status === "run");
            // N-42:失败判定走契约结构(isToolErrorResult),不再子串嗅探
            const bad = isToolErrorResult(e.call.result);
            if (i >= 0) next[i] = { name: e.call.name, status: bad ? "bad" : "ok" };
            return next;
          });
          break;
        case "error":
          // 报错/中止先把本帧缓冲落地:已流出的内容必须可见,不能留在缓冲里等下一帧
          textBatch.flush();
          thinkBatch.flush();
          setChatError(e.message);
          break;
        default:
          break;
      }
    },
    [textBatch, thinkBatch],
  );

  /** 重载作品索引（保留用户的文件夹开合，新目录按默认规则） */
  const refreshProject = useCallback(async () => {
    if (!project) return;
    const fs = getFs();
    const data = await loadProject(fs, project.ref.root, project.ref.name);
    setProject(data);
    setTreeFolders((f) => ({ ...defaultTreeFolders(data.tree), ...f }));
  }, [project]);

  /** 回流入队：先写 oplog 的 pending 行（关窗丢队列的补跑依据），再进内存队列 */
  const enqueueReflow = useCallback(
    async (task: { prompt: string; title: string; reflowId: string; track: "facts" | "style" }) => {
      reflowQueue.current.push({ prompt: task.prompt, title: task.title, reflowId: task.reflowId, track: task.track });
      if (project) {
        await appendOplog(getFs(), project.ref.root, "reflow", "", session?.id ?? "", {
          reflowId: task.reflowId,
          reflowPending: true,
          reflowTrack: task.track,
          prompt: task.prompt,
          title: task.title,
        });
      }
    },
    [project, session],
  );

  /** 回流队列排空：专属会话运行（不切换用户当前视图）；单生成并发 */
  const drainReflow = useCallback(async () => {
    if (busyRef.current || reflowQueue.current.length === 0) return;
    // 模式门：回流要写 小说资料/，非资料维护模式不跑（队列与 oplog pending 都保留，
    // 切回资料维护模式时由 aiMode 的 effect 重新触发排空）
    if (aiModeRef.current !== "dev") return;
    const b = currentBoot();
    if (!b || !project) return;
    busyRef.current = true;
    setBusy(true);
    try {
      while (reflowQueue.current.length > 0) {
        const task = reflowQueue.current.shift()!;
        setStatus(`回流运行中：${task.title}（报告见会话列表）`);
        /* 每个任务独立的中止信号：「停止」的语义是"停当前这一个"。
           旧实现整队共用 abortRef.current —— 点一次停止，aborted 永久为 true，
           后续每个排队任务一上来就被判中止，逐个报「回流失败」整队清空。 */
        const signal = { aborted: false };
        abortRef.current = signal;
        const reflowSession: SessionFile = { ...newSession(project.ref.root), title: task.title };
        try {
          await sendChat({
            dirs: b.dirs,
            prefs: b.prefs,
            session: reflowSession,
            projectRoot: project.ref.root,
            userText: task.prompt,
            transport,
            askQuestions,
            signal,
            // 回流是后台任务：资料回流（审稿/事实回写）强制关闭思考；
            // 风格回流是对照判断任务，开 low 档（D-014 的例外：判断题需要最低限度推理）
            thinking: task.track === "style" ? "low" : "off",
          });
          // 完成标记：与入队时的 pending 行按 reflowId 配对（补跑扫描据此跳过它）
          await appendOplog(getFs(), project.ref.root, "reflow", "", reflowSession.id, { note: task.title, reflowId: task.reflowId });
          setStatus(`回流任务结束：${task.title}（结果见对应回流会话）`);
        } catch (e) {
          // 失败不写完成标记 —— pending 行保留，下次打开作品会补跑
          setStatus(`回流失败：${String(e)}`);
        }
        await refreshSessions();
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      await refreshProject();
    }
  }, [project, transport, askQuestions, refreshSessions, refreshProject]);

  /** 打开作品时补跑未完成的回流（D-043：队列落盘的消费端） */
  const resumePendingRefrows = useCallback(
    async (projectRoot: string) => {
      let entries;
      try {
        entries = await readOplog(getFs(), projectRoot, 500);
      } catch {
        return; // 日志读不出不阻断打开
      }
      const known = new Set(reflowQueue.current.map((t) => t.reflowId));
      const fresh = pendingRefrows(entries).filter((p) => !known.has(p.reflowId));
      if (fresh.length === 0) return;
      for (const p of fresh) {
        reflowQueue.current.push({ prompt: p.prompt, title: p.title, reflowId: p.reflowId, track: p.track });
      }
      setStatus(`检测到 ${fresh.length} 条未完成的回流任务，开始补跑…`);
      void drainReflow();
    },
    [drainReflow],
  );
  // 前段的 openProject 通过 ref 调它（函数声明顺序问题，见 resumePendingRef 声明处）
  useEffect(() => {
    resumePendingRef.current = (root: string) => void resumePendingRefrows(root);
  }, [resumePendingRefrows]);

  // 切回资料维护模式时排空积压的回流（非资料维护模式下回流被模式门拦在队列里）
  useEffect(() => {
    if (aiMode === "dev") void drainReflow();
  }, [aiMode, drainReflow]);

  /** 回流模式切换：本地生效 + 写进作品清单（按书记住；清单写失败则本次会话内有效） */
  const persistReflowMode = useCallback(
    async (mode: ReflowMode) => {
      setReflowMode(mode);
      if (!project) return;
      try {
        const file = projectManifestFile(project.ref.root);
        const m = { ...project.manifest, reflowMode: mode, updatedAt: isoMicros() };
        await getFs().writeText(file, serializeManifest(m));
        setProject({ ...project, manifest: m });
        setStatus(`回流方式：${REFLOW_MODES.find((m) => m.id === mode)?.label ?? mode}（已按本书记住）`);
      } catch {
        setStatus("回流方式已应用（本次会话内有效，写入清单失败）");
      }
    },
    [project],
  );

  /** 资料表格视图切换（B7）：本会话内按标签覆盖 + 默认视图写进作品清单（按书记住） */
  const toggleDocTableView = useCallback(
    async (rel: string, next: boolean) => {
      setTableOverride((m) => ({ ...m, [rel]: next }));
      const vm = next ? "table" : "original";
      setBookViewMode(vm);
      if (!project) return;
      try {
        const file = projectManifestFile(project.ref.root);
        const m = { ...project.manifest, viewMode: vm, updatedAt: isoMicros() };
        await getFs().writeText(file, serializeManifest(m));
        setProject({ ...project, manifest: m });
      } catch {
        /* 视图偏好写不进清单不影响本次使用 */
      }
    },
    [project],
  );

  /* ── 表格手改（B14）：行级手术写回内容并置脏，落盘走既有保存管线 ──
     三个动作都不新造写路径：改了 tab.content 就交给 saveTabAs（写前快照 + oplog）。 */

  /** 单元格编辑提交（落点漂移/无变化时 applyCellEdit 原样返回，不置脏） */
  const applyTableCellEdit = useCallback(
    (addr: CellAddr, newText: string) => {
      const rel = activeRel;
      if (!rel) return;
      setTabs((prev) =>
        prev.map((t) => {
          if (t.rel !== rel) return t;
          const next = applyCellEdit(t.content, addr, newText);
          return next === t.content ? t : { ...t, content: next, dirty: true };
        }),
      );
    },
    [activeRel],
  );

  /** 删条目（grid 行）：确认后删整块行区间 */
  const deleteTableRow = useCallback(
    async (block: CellAddr, label: string) => {
      if (!activeTab) return;
      const ok = await askConfirm(
        "删除这条记录？",
        `将从 ${activeTab.name} 删除「${label}」整条。未保存前关闭标签可放弃这次改动。`,
        { danger: true, confirmLabel: "删除" },
      );
      if (!ok) return;
      const rel = activeTab.rel;
      setTabs((prev) =>
        prev.map((t) => {
          if (t.rel !== rel) return t;
          const next = applyRangeDelete(t.content, block);
          return next === t.content ? t : { ...t, content: next, dirty: true };
        }),
      );
      setStatus(`已删除「${label}」（未落盘，Ctrl+S 或切换标签时保存）`);
    },
    [activeTab, askConfirm],
  );

  /** 加条目（grid 表尾）：按列结构生成待填写条目，编号自动续 */
  const appendTableRow = useCallback(
    (part: Extract<DocTablePart, { kind: "grid" }>) => {
      if (!activeTab) return;
      const block = buildEntryBlock(activeTab.name, part.columns, part.rows.map((r) => r.cells[0]));
      if (!block || part.appendAt === null) return;
      const rel = activeTab.rel;
      setTabs((prev) =>
        prev.map((t) => {
          if (t.rel !== rel) return t;
          const next = applyInsertBlock(t.content, part.appendAt!, block);
          return next === t.content ? t : { ...t, content: next, dirty: true };
        }),
      );
      setStatus(`已在 ${activeTab.name} 追加新条目（待填写，点各格「改」逐格填写）`);
    },
    [activeTab],
  );

  /** 「修改/完成」按钮：正文与候选默认只读，点击后进入/结束编辑态。
   *  返回值 = 结束编辑是否落盘成功（N-06：失败时 editing/dirty 原样保留，
   *  调用方据此不销毁标签；进入编辑恒成功）。 */
  const toggleEditing = useCallback(
    async (tab: OpenTab): Promise<boolean> => {
      if (tab.kind === "doc") return true;
      const fs = getFs();
      if (!tab.editing) {
        setTabs((prev) =>
          prev.map((t) => (t.rel === tab.rel ? { ...t, editing: true, editBase: t.content } : t)),
        );
        if (project) await appendOplog(fs, project.ref.root, "edit_start", tab.rel, session?.id ?? "");
        setStatus(`正在编辑 ${tab.name}（点「完成」保存并触发回流审稿）`);
        return true;
      }
      // 结束编辑：自动保存 → 轻改仅记日志，实质改动触发回流
      const latest = tabs.find((t) => t.rel === tab.rel) ?? tab;
      if (latest.dirty) {
        const ok = await saveTabAs(latest, "结束编辑自动保存");
        if (!ok) return false;
      }
      const diff: DiffResult = diffLines(latest.editBase ?? latest.baseContent, latest.content);
      setTabs((prev) => prev.map((t) => (t.rel === tab.rel ? { ...t, editing: false, editBase: null } : t)));
      if (!project) return true;
      const noChange = diff.changedChars === 0;
      const light = noChange || isLightEdit(diff);
      const kind = latest.kind === "candidate" ? "candidate" : "chapter";
      const label = chapterLabelOf(latest.name);
      // D-043 四态路由：off 不排；facts 轻改动不审；style 轻改动也排（词级改动是最纯的文风证据）
      // 模式门（2026-10-06 裁决）：回流要写 小说资料/，只读/写作模式弹窗告知「需要资料维护模式」；
      // 用户当场不切 → 本次回流不排（保存与 oplog 都已照常完成，不丢稿）
      let tracks = noChange ? [] : reflowTracksFor(reflowMode, light);
      if (tracks.length > 0 && !(await requireDevMode("回流"))) tracks = [];
      await appendOplog(fs, project.ref.root, "edit_end", latest.rel, session?.id ?? "", {
        changedChars: diff.changedChars,
        addedLines: diff.added.length,
        removedLines: diff.removed.length,
        digitsChanged: diff.digitsChanged,
        reflowTriggered: tracks.length > 0,
      });
      if (noChange) {
        setStatus(`${latest.name} 无实质改动，已退出编辑`);
        return true;
      }
      if (tracks.length === 0) {
        setStatus(
          reflowMode === "off"
            ? `${latest.name} 已保存（当前设置为不回流，已记录日志）`
            : `${latest.name} 已保存 · 改动较小未触发回流（已记录日志）`,
        );
        return true;
      }
      for (const track of tracks) {
        await enqueueReflow({
          prompt: (track === "facts" ? buildReflowPrompt : buildStyleReflowPrompt)({
            relPath: latest.rel.replace(/\\/g, "/"),
            kind,
            chapterLabel: label,
            diff,
            // 风格通道喂配对对照（段落级「原句 → 改后句」），不只是行集
            ...(track === "style"
              ? { paired: pairedDiff(latest.editBase ?? latest.baseContent, latest.content) }
              : {}),
          }),
          title: reflowSessionTitle(label, kind, track),
          reflowId: newReflowId(),
          track,
        });
      }
      setStatus(`${latest.name} 已保存，回流排队中（${tracks.map((t) => (t === "facts" ? "资料" : "风格")).join(" + ")}）…`);
      void drainReflow();
      return true;
    },
    [tabs, project, session, saveTabAs, drainReflow, requireDevMode, reflowMode],
  );

  /** 关闭标签：自动保存；编辑态先走「完成」（保存 + 回流），不再询问 */
  const closeTab = useCallback(
    async (rel: string) => {
      const tab = tabs.find((t) => t.rel === rel);
      if (!tab) return;
      // N-06：保存结果要接住 —— 写盘失败就不关标签（内容只存在于这个 tab 里，
      // 无条件移除等于静默丢稿）。toggleEditing 结束编辑同样走 saveTabAs，
      // 失败时它保持 editing/dirty 原样并返回 false。
      if (tab.editing) {
        const ok = await toggleEditing(tab);
        if (!ok) return;
      } else if (tab.dirty) {
        const ok = await saveTabAs(tab, "关闭标签自动保存");
        if (!ok) return;
      }
      // N-41：副作用移出 setState 的 updater —— updater 在 StrictMode/重放下
      // 可能被再次调用，setActiveRel 不属于它
      const next = tabs.filter((t) => t.rel !== rel);
      setTabs(next);
      if (activeRel === rel) setActiveRel(next.length ? next[next.length - 1].rel : null);
    },
    [tabs, activeRel, toggleEditing, saveTabAs],
  );

  /** 发送一条用户消息（输入框与一键指令共用；单生成并发由 busyRef 守卫） */
  const sendUserMessage = useCallback(
    async (raw: string): Promise<boolean> => {
      const b = currentBoot();
      const text = raw.trim();
      // 返回本轮是否完整成功（true = 无错误收尾）；冷读「已提交」行的移除靠它
      if (!b || text === "" || busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setChatError(null);
      setTruncNote(null);
      textBatch.drop(); // 先丢缓冲再清 state:否则上一帧的残量会追加在空串之后
      thinkBatch.drop();
      setStreamText("");
      setStreamThink("");
      setToolLog([]);
      setComposer("");
      const signal = { aborted: false };
      abortRef.current = signal;
      /* 每条发言都立刻乐观回显：不等 runAgent 整轮跑完才出现用户气泡。
         首条发言尤其关键 —— 没有它时聊天视图停在欢迎页，正在生成的回复
         完全不可见，只有点「停止」让会话提前落盘才看得到。
         live 会话只建一次并同时交给 sendChat：乐观展示的会话与落盘的会话
         是同一个 id，跑完后 setSession(res.session) 用真实消息（含同文本的
         用户消息）整体替换，不会重复、也不会"换会话"。 */
      const live: SessionFile = session ?? newSession(project?.ref.root ?? "");
      setSession({
        ...live,
        messages: [...live.messages, { id: uuid(), role: "user", text, createdAt: isoMicros() }],
      });
      // 用户自己发言：视野拉回最新（他正在参与对话，不该停在翻历史的位置）
      pinned.current = true;
      setAtBottom(true);
      try {
        const res = await sendChat({
          dirs: b.dirs,
          prefs: b.prefs,
          session: live,
          projectRoot: project?.ref.root ?? null,
          userText: text,
          transport,
          onEvent: onAgentEvent,
          askQuestions,
          signal,
          // B-1 UI 接线：根外路径确认 + 会话内已批准目录（按引用透传，exec.ts 追加）
          confirmExternal,
          allowedDirs: allowedDirsRef.current,
          // 会话级临时档位（null = 配置默认）；平台不支持时由 providerOf 统一过滤掉
          thinking: thinkLevel,
          // AI 三态模式（只读/写作/开发；内存态，默认开发）
          mode: aiMode,
        });
        setSession(res.session);
        // 会话级累计用量（面板第二块）：把本次运行的合计并进该会话
        const sid = res.session.id;
        setUsageBySession((m) => ({ ...m, [sid]: addTotals(m[sid] ?? ZERO_USAGE, res.usage) }));
        if (res.error) setChatError(res.error);
        // 截断必须明说：否则用户会把"写到一半停住"当成模型写完
        setTruncNote(
          res.truncated
            ? "本轮回复撞到最大输出长度（max_tokens）上限，末尾可能被截断。可在「设置 → AI 提供商」里调大最大输出长度，或缩小本次指导、审读的范围。"
            : null,
        );
        await refreshSessions();
        if (project) {
          const fs = getFs();
          const data = await loadProject(fs, project.ref.root, project.ref.name);
          setProject(data);
          setTreeFolders((f) => ({ ...defaultTreeFolders(data.tree), ...f }));
        }
        return !res.error;
      } catch (err) {
        setChatError(String(err));
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
        // 回合收尾:正文已由 res.session 的 assistant 消息完整接管显示,缓冲里的
        // 残量必须丢弃而不是落地(否则会追加在刚清空的流式区之后)。
        textBatch.drop();
        thinkBatch.drop();
        setStreamText("");
        setStreamThink("");
        setToolLog([]);
        void drainReflow(); // 生成槽空出后排空待跑回流
      }
    },
    [session, project, transport, onAgentEvent, textBatch, thinkBatch, askQuestions, refreshSessions, drainReflow, thinkLevel, confirmExternal],
  );

  const doSend = useCallback(() => sendUserMessage(composer), [sendUserMessage, composer]);

  /** 停止主聊天/回流的生成（冷读有自己的槽与停止键，2026-10-09 D-058） */
  const stopGeneration = useCallback(() => {
    abortRef.current.aborted = true;
    transport.abortActive();
    // question 弹窗挂起时点停止：关弹窗并以空选择 resolve，
    // agent 循环的中止检查随即以「已中止」收尾本轮
    const pq = pendingQuestionRef.current;
    if (pq) {
      pendingQuestionRef.current = null;
      setPending(null);
      pq.resolve(pq.items.map(() => []));
    }
    setStatus("正在停止…");
  }, [transport]);

  /** 只停止冷读自己（D-058）：独立的 abort 信号 + 独立传输实例的中止槽。
   *  冷读跑着时聊天可照常收发；两边各按各的停止键，互不误杀。 */
  const stopColdRead = useCallback(() => {
    coldAbortRef.current.aborted = true;
    coldTransport.abortActive();
    setStatus("正在停止冷读…");
  }, [coldTransport]);

  /** 作者明确采用旧候选：应用复制其当前文本，AI 不参与正文保存。 */
  const adoptCandidate = useCallback(
    async (tab: OpenTab) => {
      if (!project || busyRef.current) return;
      const chapter = parseChapterName(tab.name)?.no;
      if (!chapter) { setStatus("无法识别候选稿章号，请先检查文件名。"); return; }
      busyRef.current = true; setBusy(true);
      try {
        const fs = getFs(), boot = currentBoot();
        if (!boot) throw new Error("应用尚未初始化。");
        const chaptersDir = join(project.ref.root, PROJECT_DIRS.chapters);
        const entries = await fs.exists(chaptersDir) ? await fs.list(chaptersDir) : [];
        const existing = entries.find(e => !e.isDir && !e.isLink && parseChapterName(e.name)?.no === chapter);
        const name = existing?.name ?? "第" + chapter + "章.md";
        const rel = join(PROJECT_DIRS.chapters, name), path = existing?.path ?? join(project.ref.root, rel);
        const targetAtStart = tabsRef.current.find(t => t.rel === rel);
        if (targetAtStart?.dirty) throw new Error("正式正文有未保存修改，请先保存再采用旧稿。");
        const stat = await fs.stat(path);
        if (stat?.isLink || stat?.isDir) throw new Error("目标正文是链接或目录，拒绝采用。");
        const expected = existing ? await fs.readText(path) : null;
        const targetChanged = () => {
          const live = tabsRef.current.find(t => t.rel === rel);
          return !!live && (live.dirty || live.content !== (targetAtStart?.content ?? expected));
        };
        const confirmed = await askConfirm("作者确认采用此稿？", "将你当前打开的「" + tab.name + "」逐字复制为「" + name + "」。" +
          (existing ? "将覆盖已有正式正文，先保留写前快照。" : "创建正式正文文件。") +
          "原候选稿保留。AI 不修改正文，也不替你确认归档。", {confirmLabel:"按当前原文采用"});
        if (!confirmed || !(await saveTabAs(tab, "作者采用前保存旧稿"))) return;
        const previous = existing ? await fs.readText(path) : null;
        if (targetChanged() || previous !== expected) throw new Error("确认期间正式正文已变化，请核对后重新采用。");
        await recordSnapshot(fs, boot.dirs.snapshotsDir, {sessionId:session?.id ?? "manual-edits",callId:"manual-adopt-"+Date.now(),
          operation:"write",relativePath:rel.replace(/\\/g,"/"),previousContent:previous,previousExists:!!existing,previousType:existing?"file":"none"});
        if (targetChanged()) throw new Error("写入前正式正文已变化，已取消采用。");
        await fs.writeText(path, tab.content);
        // 落盘成功就同步基线；保留IO期间新输入，不能等索引刷新后才更新。
        setTabs(prev => prev.map(t => t.rel === rel ? settleAdoptedTab(t, tab.content, previous) : t));
        await appendOplog(fs,project.ref.root,"adopt",tab.rel,session?.id ?? "",{note:"作者点击采用，应用逐字复制；未执行AI正文改写或归档。"});
        try {
          await refreshProject();
          await openFile({name,rel,path,size:tab.content.length,mtimeMs:Date.now()},"chapter");
          setStatus("已按作者确认逐字采用；若目标标签有新输入，会保留为未保存。请核对并执行资料回流与归档。");
        } catch (e) { setStatus("正文已逐字采用，但索引刷新失败，请刷新作品：" + String(e)); }
      } catch(e) {setStatus("采用失败："+String(e));}
      finally {busyRef.current=false;setBusy(false);}
    },
    [project,tabs,session,askConfirm,saveTabAs,refreshProject,openFile],
  );

  /** 打开冷读悬浮面板（D-045）：setup 态；每次打开都重置选项，不归上一次的选择。
   *  D-058：聊天在跑**不拦**开冷读（两条生成槽并存），只有冷读自己还在跑才拦。 */
  const openColdRead = useCallback(
    async (tab: OpenTab) => {
      const b = currentBoot();
      if (!b || !project) return;
      // 冷读在途时不重开面板：在途回合的结果会写进被重置的状态
      if (cold?.phase === "running") {
        setStatus("上一次冷读还在跑，结束后再开新的");
        return;
      }
      const fs = getFs();
      // style 通道需要风格档案：新结构 06-写作风格.md，老作品回落 06-写作规则.md
      const docsDir = join(project.ref.root, PROJECT_DIRS.docs);
      let styleMissing = true;
      for (const name of [STYLE_DOC, RULES_DOC]) {
        try {
          const st = await fs.stat(join(docsDir, name));
          if (st && !st.isDir) { styleMissing = false; break; }
        } catch { /* 下一个 */ }
      }
      setCold({
        tabRel: tab.rel,
        chapterLabel: chapterLabelOf(tab.name) ?? stripMd(tab.name),
        channel: "plot",
        priorCount: 1,
        phase: "setup",
        rows: [],
        leftover: "",
        noIssues: false,
        note: "",
        error: null,
        streaming: "",
        styleMissing,
      });
    },
    [project, cold],
  );

  /**
   * 冷读执行（D-045）：独立实例（零工具、零技能、零项目块），**不落盘**——
   * 不建会话、不写报告，结果只进悬浮面板；oplog 留一行最小痕迹。
   * 流式原文走面板自己的 streaming 通道，不碰主聊天的 streamText（避免"两个界面"）。
   *
   * D-058（独立生成槽）：冷读**不置**全局 busy、不占 abortRef、连中止信号与
   * 传输实例都是自己的 —— 于是冷读跑着时聊天照样能发能收，「停止」各停各的。
   * 这是"冷读零工具零上下文"的 UI 面延伸：隔离不只在数据面，也在生成面。
   */
  const runColdRead = useCallback(async () => {
    const cur = cold;
    const b = currentBoot();
    if (!cur || !b || !project) return;
    const tab = tabs.find((t) => t.rel === cur.tabRel);
    if (!tab) {
      setCold(null);
      setStatus("被审读的章节标签已关闭，冷读取消");
      return;
    }
    const fs = getFs();
    const label = cur.chapterLabel;
    // plot 通道：从正式正文取章号在前的 priorCount 章（缺章跳过，不阻断冷读）
    const no = parseChapterName(stripMd(tab.name))?.no ?? 0;
    const priors: ColdReadPrior[] = [];
    if (cur.channel === "plot" && cur.priorCount > 0 && no > 0) {
      for (let i = Math.max(1, no - cur.priorCount); i < no; i++) {
        const c = project.chapters.find((x) => parseChapterName(stripMd(x.name))?.no === i);
        if (!c) continue;
        try {
          priors.push({ title: chapterLabelOf(c.name) ?? stripMd(c.name), text: await fs.readText(c.path) });
        } catch {
          /* 前文读取失败不阻断 */
        }
      }
    }
    // style 通道：读风格档案（新结构 06-写作风格.md；老作品回落 06-写作规则.md）
    let styleDossier = "";
    if (cur.channel === "style") {
      const docsDir = join(project.ref.root, PROJECT_DIRS.docs);
      for (const name of [STYLE_DOC, RULES_DOC]) {
        try {
          const st = await fs.stat(join(docsDir, name));
          if (st && !st.isDir) { styleDossier = await fs.readText(join(docsDir, name)); break; }
        } catch { /* 下一个 */ }
      }
      if (!styleDossier.trim()) {
        setCold((c) => (c ? { ...c, phase: "setup", error: "风格档案读不到内容，无法做风格对照" } : c));
        return;
      }
    }
    const signal = { aborted: false };
    coldAbortRef.current = signal; // 冷读自己的中止信号（D-058：不借用聊天的 abortRef）
    coldBatch.drop(); // 残量会在清空后被追加回去,必须先丢
    setCold((c) => (c ? { ...c, phase: "running", streaming: "", error: null, rows: [], leftover: "", noIssues: false, note: "" } : c));
    // 冷读专用事件通道：只把正文增量推进面板，不喂主聊天的 streamText/toolLog
    const onColdEvent = (e: AgentEvent) => {
      if (e.type === "text_delta") coldBatch.push(e.text);
    };
    try {
      const res = await sendIsolated({
        dirs: b.dirs,
        prefs: b.prefs,
        session: newSession(project.ref.root), // 一次性会话壳：persistSession:false，不落盘
        persistSession: false,
        systemPrompt: coldReadSystem(cur.channel),
        userText: buildColdReadUserMessage(cur.channel, label, tab.content, priors, styleDossier),
        transport: coldTransport, // D-058：独立传输实例，中止槽与聊天分开
        onEvent: onColdEvent,
        signal,
        thinking: thinkLevel, // D-014：冷读跟随会话级思考档位
      });
      coldBatch.drop(); // 面板改为显示解析后的清单,流式缓冲不再需要
      const aiText =
        [...res.session.messages].reverse().find((m) => m.role === "assistant")?.text ?? "";
      const parsed = parseColdReadIssues(aiText, cur.channel);
      const rows: ColdRow[] = parsed.issues.map((it) => ({ ...it, checked: false, state: "open" }));
      setCold((c) =>
        c
          ? {
              ...c,
              phase: "done",
              rows,
              leftover: parsed.leftover,
              noIssues: parsed.noIssues,
              note: parsed.note,
              error: res.error ??
                (res.truncated
                  ? "审读输出撞到长度上限，清单可能不全（可调大 max_tokens 后重跑）"
                  : aiText.trim() ? null : "冷读结束：未获得审读输出（可能被中止）"),
            }
          : c,
      );
      // oplog 最小痕迹（D-045 裁决保留）：时间/章/通道/前文数/查出几条；不含问题内容
      await appendOplog(fs, project.ref.root, "coldread", cur.tabRel, "", {
        coldChannel: cur.channel,
        coldPriors: priors.length,
        coldIssues: rows.length,
      });
    } catch (e) {
      setCold((c) => (c ? { ...c, phase: "done", error: String(e) } : c));
    } finally {
      // D-058：冷读不碰全局 busy，也没有需要让位的生成槽 —— 只把自己的中止信号复位
      coldAbortRef.current.aborted = false;
    }
  }, [cold, project, tabs, coldTransport, thinkLevel]);

  /** 行操作：勾选/删除（永久）/定位 */
  const coldToggle = useCallback((id: string) => {
    setCold((c) => (c ? { ...c, rows: c.rows.map((r) => (r.id === id && r.state === "open" ? { ...r, checked: !r.checked } : r)) } : c));
  }, []);
  const coldDelete = useCallback((ids: string[]) => {
    const drop = new Set(ids);
    setCold((c) => (c ? { ...c, rows: c.rows.filter((r) => !(r.state === "open" && drop.has(r.id))) } : c));
  }, []);
  const coldLocate = useCallback(
    (quote: string) => {
      if (!cold) return;
      const tab = tabs.find((t) => t.rel === cold.tabRel);
      if (!tab) { setStatus("被审读的章节标签已关闭"); return; }
      if (activeRel !== tab.rel) setActiveRel(tab.rel);
      const idx = tab.content.indexOf(quote);
      if (idx < 0) { setStatus("引文在当前正文里找不到（可能已修改）"); return; }
      // 等 React 把活动标签切过去再动 textarea
      window.setTimeout(() => {
        const el = editorRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(idx, idx + quote.length);
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 24;
        const lineNo = tab.content.slice(0, idx).split("\n").length;
        el.scrollTop = Math.max(0, (lineNo - 4) * lineHeight);
      }, 60);
    },
    [cold, tabs, activeRel],
  );

  /** 发送选中问题给 AI：行转「已提交」置灰，AI 回合成功才移除；失败/中止则恢复 */
  const coldSend = useCallback(
    async (ids: string[]) => {
      const cur = cold;
      if (!cur) return;
      if (busyRef.current) { setStatus("当前有生成任务在跑，请稍后再提交修复"); return; }
      const picked = cur.rows.filter((r) => ids.includes(r.id) && r.state === "open");
      if (picked.length === 0) return;
      const text = buildColdFixMessage(cur.chapterLabel, cur.tabRel.replace(/\\/g, "/"), picked);
      const idSet = new Set(picked.map((r) => r.id));
      setCold((c) => (c ? { ...c, rows: c.rows.map((r) => (idSet.has(r.id) ? { ...r, state: "submitted", checked: false } : r)) } : c));
      const ok = await sendUserMessage(text);
      setCold((c) =>
        c
          ? {
              ...c,
              rows: ok
                ? c.rows.filter((r) => !idSet.has(r.id)) // 成功：永久移除
                : c.rows.map((r) => (idSet.has(r.id) ? { ...r, state: "open" } : r)), // 失败/中止：恢复
            }
          : c,
      );
      setStatus(ok ? `已提交 ${picked.length} 条冷读问题给 AI 修复` : "修复未完成（被中止或出错），问题行已恢复");
    },
    [cold, sendUserMessage],
  );


  const teaching = useTeaching({
    root: project?.ref.root ?? null, active: activeTab ?? null, tabs, busy, editor: editorRef,
    askQuestions,
    acquire: () => { if (busyRef.current) return false; busyRef.current = true; setBusy(true); return true; },
    release: () => { busyRef.current = false; setBusy(false); },
    saveActive,
    openChapter: async (chapter) => {
      if (!project) return;
      const fs = getFs();
      const entries = await fs.list(join(project.ref.root, PROJECT_DIRS.chapters));
      const existing = entries.find(e => !e.isDir && !e.isLink && parseChapterName(e.name)?.no === chapter);
      const name = existing?.name ?? "第" + chapter + "章.md";
      const rel = join(PROJECT_DIRS.chapters, name);
      const path = existing?.path ?? join(project.ref.root, rel);
      // 这是作者点生成导览后创建的空白稿；AI响应不会传给正文保存出口。
      if (!(await fs.exists(path))) await fs.writeText(path, "");
      await refreshProject();
      await openFile({name,rel,path,size:existing?.size ?? 0,mtimeMs:existing?.mtimeMs ?? Date.now()}, "chapter");
      setTabs(prev => prev.map(t => t.rel === rel ? {...t,editing:true,editBase:t.content} : t));
    },
    refresh: refreshProject, notify: setStatus,
  });

  /** 打开会话：若会话绑定了项目则恢复绑定。
   *  N-44：失败不再静默 —— 会话文件缺失/损坏（loadSession 返回 null）给状态条
   *  提示；IO 异常同样接住（调用处是 void，冒泡就是无人处理的 rejection）。 */
  const openSession = useCallback(
    async (id: string) => {
      const b = currentBoot();
      if (!b) return;
      // 与 startNewChat 同一条守卫：生成中切会话，跑完会被 setSession 拽回去
      if (busyRef.current) {
        setStatus("正在生成中，请先停止当前生成再切换会话");
        return;
      }
      try {
        const s = await loadSession(getFs(), b.dirs.sessionsDir, id);
        if (!s) {
          setStatus("会话文件缺失或已损坏，无法打开");
          return;
        }
        setSession(s);
        const root = s.projectPath?.trim();
        if (root && project?.ref.root.toLowerCase() !== root.toLowerCase()) {
          let ref = projects.find((p) => p.root.toLowerCase() === root.toLowerCase());
          if (!ref) {
            // 列表过期时重扫一次
            const list = await scanBooksRoot(getFs(), b.dirs.booksRoot);
            setProjects(list);
            ref = list.find((p) => p.root.toLowerCase() === root.toLowerCase());
          }
          if (ref) await openProjectRef(ref);
          else setStatus(`会话原属作品已不在作品根：${root}`);
        }
      } catch (e) {
        setStatus(`打开会话失败：${String(e instanceof Error ? e.message : e)}`);
      }
    },
    [project, projects, openProjectRef],
  );

  const answerPending = useCallback(() => {
    if (!pending) return;
    // D-2：必答问题不许交白卷 —— 全空答案会让 agent 拿着空选择继续跑
    const unanswered = pending.items.findIndex((_, i) => (qSel[i] ?? []).length === 0);
    if (unanswered >= 0) {
      setStatus(`第 ${unanswered + 1} 个问题还没有选择，选完再提交`);
      return;
    }
    const answers = pending.items.map((_, i) => qSel[i] ?? []);
    pending.resolve(answers);
    setPending(null);
  }, [pending, qSel]);

  const startNewChat = useCallback(() => {
    /* 生成中不开新会话：本轮跑完时 sendUserMessage 会 setSession(res.session)，
       会把用户刚从「新对话」拽回那个生成中的旧会话 —— 先停止再开。 */
    if (busyRef.current) {
      setStatus("正在生成中，请先停止当前生成再开新对话");
      setSessMenu(false);
      return;
    }
    setSession(newSession(project?.ref.root ?? ""));
    setSessMenu(false);
    setStatus("新对话");
  }, [project]);

  // 切换/新建会话：瞬时落到底部（这里不该有跟随动画，否则像"倒带"），
  // 并恢复自动跟随 —— 新会话永远应该贴底。
  useEffect(() => {
    pinned.current = true;
    setAtBottom(true);
    const el = chatScroll.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) el.scrollTop = max;
  }, [session?.id]);

  /** 弹簧写入守卫的记录回调（motion.springScrollToBottom 的 beforeWrite） */
  const markSpringWrite = useCallback((v: number) => {
    lastSpringWrite.current = v;
  }, []);

  // 新消息/流式增量时弹簧跟随到底部。
  // 用弹簧而不是 scrollIntoView：流式内容每帧都在变长，目标位置是连续
  // 移动的，弹簧会一路追赶（读起来是"顺滑跟随"）；瞬时跳会像闪屏。
  useEffect(() => {
    const el = chatScroll.current;
    if (!el || !pinned.current) return;
    springScrollToBottom(el, FOLLOW_SPRING, markSpringWrite);
  }, [session?.messages.length, streamText, streamThink, toolLog.length, markSpringWrite]);

  // 用户一滚动就让位（可打断）：自己滚了就不再自动跟随，除非又回到贴底
  const onChatScroll = useCallback(() => {
    const el = chatScroll.current;
    if (!el) return;
    // 弹簧自己的写（值对得上即跳过）：这帧不是用户在滚，别取消跟随、也别重算
    // 贴底 —— 少了这道守卫，流式输出时弹簧写入与用户上滚交替触发本处理器，
    // pinned 被来回翻，视图定死滚不动。
    if (lastSpringWrite.current !== null && Math.abs(el.scrollTop - lastSpringWrite.current) < 1.5) {
      return;
    }
    lastSpringWrite.current = null; // 用户接管后清掉旧值，避免后续巧合值被误判
    springScrollCancel(el);
    const near = isNearBottom(el);
    pinned.current = near;
    setAtBottom(near);
  }, []);

  /** 「回到底部」悬浮钮：重新接管跟随，并弹簧落底 */
  const jumpToBottom = useCallback(() => {
    const el = chatScroll.current;
    pinned.current = true;
    setAtBottom(true);
    if (el) springScrollToBottom(el, FOLLOW_SPRING, markSpringWrite);
  }, [markSpringWrite]);

  /* ── 编辑器底部快捷键（B18，用户裁决）：复制全文常显；
     剪切/全选/粘贴只在可编辑态出现（资料恒可编辑；正文/候选点「修改」后）── */

  const edCopyAll = useCallback(async () => {
    if (!activeTab) return;
    try {
      await navigator.clipboard.writeText(activeTab.content);
      setStatus(`已复制 ${activeTab.name} 全文（${countWords(activeTab.content)} 字）`);
    } catch {
      setStatus("复制失败：剪贴板不可用");
    }
  }, [activeTab]);

  const edCutAll = useCallback(async () => {
    if (!activeTab || !tabEditable(activeTab)) return;
    try {
      await navigator.clipboard.writeText(activeTab.content);
    } catch {
      setStatus("剪切失败：剪贴板不可用");
      return;
    }
    editContent("");
    setStatus(`已剪切 ${activeTab.name} 全文（未落盘，Ctrl+S 保存）`);
  }, [activeTab, editContent]);

  const edSelectAll = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const edPaste = useCallback(async () => {
    if (!activeTab || !tabEditable(activeTab)) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setStatus("读取剪贴板失败（需要在窗口里操作）");
      return;
    }
    if (text === "") {
      setStatus("剪贴板是空的");
      return;
    }
    const el = editorRef.current;
    // 焦点在编辑器里 → 插到光标处（替换选区）；否则追加到文末
    if (el && document.activeElement === el) {
      const s = el.selectionStart ?? el.value.length;
      const e = el.selectionEnd ?? s;
      editContent(el.value.slice(0, s) + text + el.value.slice(e));
      window.setTimeout(() => {
        el.focus();
        el.setSelectionRange(s + text.length, s + text.length);
      }, 0);
    } else {
      editContent(activeTab.content + text);
    }
    setStatus("已粘贴（未落盘，Ctrl+S 保存）");
  }, [activeTab, editContent]);

  /** 统一引号（D-055，用户裁决 2026-10-09）：只转英文双引号，单引号不动。
   *  纯文本变换 → 走 editContent（未落盘，Ctrl+S/「完成」才写盘，快照照常）。 */
  const edUnifyQuotes = useCallback(() => {
    if (!activeTab || !tabEditable(activeTab)) return;
    const r = unifyDoubleQuotes(activeTab.content);
    if (r.converted === 0) {
      setStatus("没有需要转换的英文双引号");
      return;
    }
    editContent(r.text);
    const odd = r.oddLines.length
      ? `；第 ${r.oddLines.slice(0, 5).join("、")} 行引号不配对，已按交替配对转换，请复核`
      : "";
    setStatus(`已统一 ${r.converted} 处英文双引号为中文引号“”（未落盘，Ctrl+S 保存）${odd}`);
  }, [activeTab, editContent]);

  const sessionGroups = useMemo(() => groupSessions(sessions), [sessions]);

  /* ── 「需要你的选择」模态的无障碍接管 ──
     冷读在 D-045 改为**无遮罩悬浮面板**：不夺焦点、不拦 Esc，用户要边看边改正文，
     焦点接管与模态语义（useDialogFocus / escStack）对它反而是伤害。
     「需要你的选择」是 AI 通过 ask 工具提出的必答问题，**没有取消语义** ——
     刻意不给 Esc 绑定关闭（关掉它会让那次工具调用永远悬着）。 */
  const pendPanelRef = useRef<HTMLDivElement | null>(null);
  const pendFirstRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocus(Boolean(pending), pendPanelRef, pendFirstRef);

  if (error) {
    return (
      <div className="win" id="screenB">
        <div className="boot-error">
          <div className="err-card surface-raised">
            <h3>启动失败</h3>
            {error}
          </div>
        </div>
      </div>
    );
  }

  /* 聊天视图渲染条件：会话已有消息，或本轮生成在途。
     旧判定只看 session.messages.length —— 而用户消息要等 runAgent 整轮
     跑完才经 setSession(res.session) 入库，于是「新会话的第一条发言」
     发出后仍停在欢迎页，正在生成的回复完全不可见，只有点「停止」让
     会话提前落盘才看得到。把 busy 并入条件后，第一条发言发出即切到
     聊天视图：打字指示、流式气泡、工具行全程可见。 */
  const hasMessages = Boolean(session && session.messages.length > 0) || busy;
  const showTyping = busy && !streamText && !streamThink;

  /** 树节点点击 → 按路径判类打开 */
  const openNode = (n: ContentNode) => {
    void openFile(
      { name: n.name, rel: n.rel, path: n.path, size: n.size, mtimeMs: n.mtimeMs },
      kindForRel(n.rel),
    );
  };

  /* ── 小说资料树内文件管理（D-056，2026-10-09 用户裁决）：
     范围只到 小说资料\ 子树（章节内容/待确认是管线受管，不提供树内操作）；
     受管文件名操作前先警告；删除走「确认 → 写前快照 → 动盘」同一纪律。 ── */

  /** 该树节点是否落在 小说资料\ 子树（含其自身） */
  const isDocsTreeRel = (rel: string) =>
    rel === PROJECT_DIRS.docs || rel.startsWith(PROJECT_DIRS.docs + PATH_SEP);

  /** 新增资料文档：在指定目录下建 .md（名字规则与新建作品共用同一份 childNameProblem） */
  const docCreate = useCallback(
    async (parent: ContentNode) => {
      if (!project) return;
      const name = await askText(`在「${parent.name}」下新增资料文档`, "文件名（自动补 .md）");
      if (!name) return;
      const base = name.replace(/\.md$/i, "").trim();
      const problem = childNameProblem(base);
      if (problem) {
        setStatus(`无法创建：${problem}`);
        return;
      }
      const fileName = `${base}.md`;
      const rel = parent.rel === "" ? fileName : join(parent.rel, fileName);
      const abs = join(project.ref.root, rel);
      const fs = getFs();
      try {
        if (await fs.exists(abs)) {
          setStatus(`「${fileName}」已存在，换个名字`);
          return;
        }
        await fs.writeText(abs, "");
        await appendOplog(fs, project.ref.root, "doc_create", rel.replace(/\\/g, "/"), session?.id ?? "");
        await refreshProject();
        setStatus(`已创建 ${rel}`);
        // 建好直接打开（空文档；kind 由路径判定 = doc，恒可编辑）
        void openFile({ name: fileName, rel, path: abs, size: 0, mtimeMs: Date.now() }, kindForRel(rel));
      } catch (e) {
        setStatus(`创建失败：${String(e)}`);
      }
    },
    [project, session, askText, refreshProject, openFile],
  );

  /** 重命名资料文档：已打开的标签同步改指向（未保存的手改稿跟着新路径走，不丢） */
  const docRename = useCallback(
    async (node: ContentNode) => {
      if (!project) return;
      const oldBase = node.name.replace(/\.md$/i, "");
      const name = await askText(`重命名「${node.name}」`, "新文件名（自动补 .md）", oldBase);
      if (!name) return;
      const base = name.replace(/\.md$/i, "").trim();
      if (base === "" || base === oldBase) return;
      const problem = childNameProblem(base);
      if (problem) {
        setStatus(`无法重命名：${problem}`);
        return;
      }
      if (isManagedDocName(node.name)) {
        const ok = await askConfirm(
          "重命名受管文档？",
          `「${node.name}」是受管文档：改名后校验、表格视图与 AI 的读取约定会对它失效。`,
          { confirmLabel: "仍要重命名" },
        );
        if (!ok) return;
      }
      const fileName = `${base}.md`;
      const parentRel = dirname(node.rel);
      const newRel = parentRel === "" ? fileName : join(parentRel, fileName);
      const newAbs = join(project.ref.root, newRel);
      const fs = getFs();
      try {
        if (await fs.exists(newAbs)) {
          setStatus(`「${fileName}」已存在，换个名字`);
          return;
        }
        await fs.rename(node.path, newAbs);
        setTabs((prev) => prev.map((t) => (t.rel === node.rel ? { ...t, rel: newRel, path: newAbs, name: fileName } : t)));
        setActiveRel((cur) => (cur === node.rel ? newRel : cur));
        await appendOplog(fs, project.ref.root, "doc_rename", node.rel.replace(/\\/g, "/"), session?.id ?? "", {
          renameTo: newRel.replace(/\\/g, "/"),
        });
        await refreshProject();
        setStatus(`已重命名为 ${newRel}`);
      } catch (e) {
        setStatus(`重命名失败：${String(e)}`);
      }
    },
    [project, session, askText, askConfirm, refreshProject],
  );

  /** 删除资料文档：确认 → 写前快照（内容可回滚）→ 动盘；打开中的标签直接摘掉，
   *  不走 closeTab —— 它会把脏内容自动保存回磁盘，等于把刚删的文件救活。 */
  const docDelete = useCallback(
    async (node: ContentNode) => {
      if (!project) return;
      const openTab = tabs.find((t) => t.rel === node.rel);
      const managed = isManagedDocName(node.name)
        ? `\n注意：「${node.name}」是受管文档，删除后校验、表格视图与 AI 的读取约定会对它失效。`
        : "";
      const dirty = openTab?.dirty
        ? "\n这个文件正在编辑且有未保存的改动 —— 删除后标签直接关闭，未保存的改动只存在于快照里。"
        : "";
      const ok = await askConfirm(
        `删除「${node.name}」？`,
        `文件将从磁盘删除（删除前落一次写前快照，内容可从快照恢复）。${dirty}${managed}`,
        { danger: true, confirmLabel: "删除" },
      );
      if (!ok) return;
      const fs = getFs();
      try {
        const b = currentBoot();
        const content = await fs.readText(node.path);
        if (b) {
          await recordSnapshot(fs, b.dirs.snapshotsDir, {
            sessionId: session?.id ?? "manual-edits",
            callId: `manual_${Date.now()}`,
            operation: "delete",
            relativePath: node.rel.replace(/\\/g, "/"),
            previousContent: content,
            previousExists: true,
            previousType: "file",
          });
        }
        await fs.remove(node.path, false);
        const remaining = tabs.filter((t) => t.rel !== node.rel);
        setTabs(remaining);
        if (activeRel === node.rel) setActiveRel(remaining[0]?.rel ?? null);
        await appendOplog(fs, project.ref.root, "doc_delete", node.rel.replace(/\\/g, "/"), session?.id ?? "");
        await refreshProject();
        setStatus(`已删除 ${node.rel}（内容已留快照）`);
      } catch (e) {
        setStatus(`删除失败：${String(e)}`);
      }
    },
    [project, session, tabs, activeRel, askConfirm, refreshProject],
  );

  /** 通用内容树渲染：目录可折叠（已处理默认收起），所有内容文件左栏可见。
      D-056：小说资料\ 子树的节点带悬停操作钮（目录 = 新增；文件 = 重命名/删除）。
      操作钮与节点本体平级（.trow 包裹）—— button 里套 button 是非法 HTML。 */
  const renderNodes = (nodes: ContentNode[], depth: number): React.ReactElement[] =>
    nodes.map((n) =>
      n.isDir ? (
        <div key={n.rel} role="group">
          <div className="trow">
          <button
            className="tnode grp"
            role="treeitem"
            aria-expanded={treeFolders[n.rel] !== false}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => setTreeFolders((f) => ({ ...f, [n.rel]: f[n.rel] === false }))}
          >
            <svg
              viewBox="0 0 12 12"
              className={treeFolders[n.rel] !== false ? "caret open" : "caret"}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4.5 3L7.5 6l-3 3" />
            </svg>
            <svg viewBox="0 0 20 20" className="ic folder">
              <path d="M2.8 5.4A1.6 1.6 0 0 1 4.4 3.8h3l1.4 1.8h6.8a1.6 1.6 0 0 1 1.6 1.6v7.4a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6V5.4z" />
            </svg>
            <span className="lbl">{n.name}</span>
            {/* I-7：目录被截断（超出 200 条上限）必须可见 —— 静默截断会让
                用户以为"文件就这么多"，往里放的新文件"消失" */}
            {n.truncated ? (
              <span className="tcut" title="该目录条目过多，仅显示前 200 项">
                …已截断
              </span>
            ) : null}
          </button>
          {isDocsTreeRel(n.rel) ? (
            <span className="tacts">
              <button
                className="tact"
                title={`在「${n.name}」下新增资料文档`}
                aria-label={`在「${n.name}」下新增资料文档`}
                onClick={(e) => {
                  e.stopPropagation();
                  void docCreate(n);
                }}
              >
                <svg viewBox="0 0 20 20" className="ic">
                  <path d="M10 4.5v11M4.5 10h11" />
                </svg>
              </button>
            </span>
          ) : null}
          </div>
          {treeFolders[n.rel] !== false ? renderNodes(n.children, depth + 1) : null}
        </div>
      ) : (
        <div key={n.rel} className="trow">
        <button
          className={activeRel === n.rel ? "tnode on" : "tnode"}
          role="treeitem"
          aria-selected={activeRel === n.rel}
          style={{ paddingLeft: 26 + depth * 12 }}
          onClick={() => openNode(n)}
        >
          <svg viewBox="0 0 20 20" className="ic doc">
            <path d="M5 2.6h6.4l3.6 3.6v11.2H5z" />
            <path d="M11.4 2.6v3.6H15" />
          </svg>
          <span className="lbl">{n.name}</span>
        </button>
        {isDocsTreeRel(n.rel) ? (
          <span className="tacts">
            <button
              className="tact"
              title="重命名"
              aria-label={`重命名 ${n.name}`}
              onClick={(e) => {
                e.stopPropagation();
                void docRename(n);
              }}
            >
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M13.9 13.3l2.6-2.6 1.1 1.1-2.6 2.6-1.5.4.4-1.5z" />
                <path d="M4 16.2h12" />
              </svg>
            </button>
            <button
              className="tact danger"
              title="删除（先留快照）"
              aria-label={`删除 ${n.name}`}
              onClick={(e) => {
                e.stopPropagation();
                void docDelete(n);
              }}
            >
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M4.4 6.6h11.2M8 6.6V5.2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.4" />
                <path d="M6 6.6l.7 8.6a1.2 1.2 0 0 0 1.2 1.1h4.2a1.2 1.2 0 0 0 1.2-1.1l.7-8.6" />
                <path d="M8.6 9.4v4.4M11.4 9.4v4.4" />
              </svg>
            </button>
          </span>
        ) : null}
        </div>
      ),
    );

  return (
    <div className="win" id="screenB">
      {/* ── 标题栏 ── */}
      <div
        className="titlebar"
        onMouseDown={(e) => {
          // 标题栏空白处按住拖动（按钮除外）
          if (e.button !== 0) return;
          const el = e.target as HTMLElement;
          if (el.closest("button")) return;
          void win.startDragging();
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          void win.toggleMaximize();
        }}
      >
        <div className="brand">
          <div className="brand-mark app-mark">
            <img src={logo} alt="" />
          </div>
          <div className="brand-name">TeachWrite</div>
        </div>

        <div className="tb-cluster" role="group" aria-label="面板开关">
          <button
            className={showFiles ? "tb-btn on" : "tb-btn"}
            title="文件面板"
            aria-pressed={showFiles}
            onClick={toggleFiles}
          >
            <svg viewBox="0 0 20 20" className="ic">
              <rect x="2.5" y="4" width="15" height="12" rx="2" />
              <path d="M7.5 4v12" />
            </svg>
          </button>
          <button
            className={showChat ? "tb-btn on" : "tb-btn"}
            title="AI 对话面板"
            aria-pressed={showChat}
            onClick={toggleChat}
          >
            <svg viewBox="0 0 20 20" className="ic">
              <path d="M3.5 5.5A2 2 0 0 1 5.5 3.5h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8l-4.5 3.5z" />
            </svg>
          </button>
          <span className="tb-div" />
          <button className="tb-btn" title="备忘录" onClick={() => setMemoOpen(true)}>
            <svg viewBox="0 0 20 20" className="ic">
              <rect x="3" y="2.8" width="14" height="14.4" rx="2.2" />
              <path d="M6.6 7h6.8M6.6 10.2h6.8M6.6 13.4h4" />
            </svg>
          </button>
            <button className="tb-btn" title="使用教程(按功能分类的软件说明书)" aria-label="使用教程" onClick={() => setHelpOpen(true)}>
              <svg viewBox="0 0 20 20" className="ic">
                <circle cx="10" cy="10" r="7" />
                <path d="M8.2 8.2a1.9 1.9 0 1 1 3.2 1.3c-.6.5-1.4.8-1.4 1.7" />
                <circle cx="10" cy="14.1" r="0.75" fill="currentColor" stroke="none" />
              </svg>
            </button>
        </div>

        <div className="win-tools">
          {/* 网页版参考栏开关（D-057）：白名单两站，默认隐藏；栏与作品/配置完全隔离 */}
          <button
            className={webCols.ds ? "wbtn on" : "wbtn"}
            title="DeepSeek 网页版（参考栏：与本软件完全隔离，仅供参考）"
            aria-pressed={webCols.ds}
            data-web="ds"
            onClick={() => setWebCols((c) => ({ ...c, ds: !c.ds }))}
          >
            <svg viewBox="0 0 20 20" className="ic">
              <circle cx="10" cy="10" r="7.2" />
              <path d="M2.8 10h14.4M10 2.8c-4.6 4.8-4.6 9.6 0 14.4 4.6-4.8 4.6-9.6 0-14.4z" />
            </svg>
          </button>
          <button
            className={webCols.zq ? "wbtn on" : "wbtn"}
            title="朱雀AI检测（参考栏：与本软件完全隔离，仅供参考）"
            aria-pressed={webCols.zq}
            data-web="zq"
            onClick={() => setWebCols((c) => ({ ...c, zq: !c.zq }))}
          >
            <svg viewBox="0 0 20 20" className="ic">
              <circle cx="8.6" cy="8.6" r="5.4" />
              <path d="M12.8 12.8L17 17" />
              <path d="M6.4 8.8l1.6 1.6 3-3.2" />
            </svg>
          </button>
          {/* 用量入口（D-044）：文字按键，不再是鲸鱼图形；悬停预览、点按钉住 */}
          <TitlebarUsage dirs={dirs} prefs={bootPrefs} sessionUsage={sessionUsage} />
          <button className="wbtn" title="设置" onClick={onOpenSettings}>
            <svg viewBox="0 0 20 20" className="ic">
              <circle cx="10" cy="10" r="2.4" />
              <path d="M16.1 11.9a1.25 1.25 0 0 0 .25 1.38l.04.05a1.5 1.5 0 1 1-2.12 2.12l-.05-.04a1.25 1.25 0 0 0-1.38-.25 1.25 1.25 0 0 0-.75 1.14v.15a1.5 1.5 0 1 1-3 0v-.08a1.25 1.25 0 0 0-.82-1.14 1.25 1.25 0 0 0-1.38.25l-.05.04A1.5 1.5 0 1 1 3.9 13.4l.04-.05a1.25 1.25 0 0 0 .25-1.38 1.25 1.25 0 0 0-1.14-.75h-.15a1.5 1.5 0 1 1 0-3h.08a1.25 1.25 0 0 0 1.14-.82 1.25 1.25 0 0 0-.25-1.38L3.9 5.97A1.5 1.5 0 1 1 6.02 3.85l.05.04a1.25 1.25 0 0 0 1.38.25h.06a1.25 1.25 0 0 0 .75-1.14v-.15a1.5 1.5 0 1 1 3 0v.08a1.25 1.25 0 0 0 .75 1.14 1.25 1.25 0 0 0 1.38-.25l.05-.04a1.5 1.5 0 1 1 2.12 2.12l-.04.05a1.25 1.25 0 0 0-.25 1.38v.06a1.25 1.25 0 0 0 1.14.75h.15a1.5 1.5 0 1 1 0 3h-.08a1.25 1.25 0 0 0-1.14.75z" />
            </svg>
          </button>
          {/* 自绘窗控（最小化/最大化/关闭）——**仅 Windows**。
              macOS 上窗口是 decorations:true，系统原生红黄绿三键由 AppKit 绘制，
              再画一套就会出现「两套窗控」，而且原生三键叠在网页左上角会压住品牌。
              见 styles/app.css 的 html[data-os="macos"] .win-ctrls 规则。
              注意：只藏这三个 + 分隔线，设置与网页栏开关必须留着。 */}
          <span className="win-ctrls">
            <span className="tb-div" />
            <button className="wbtn" title="最小化" onClick={() => void win.minimize()}>
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M5 10h10" />
              </svg>
            </button>
            <button
              className="wbtn"
              title={maxed ? "向下还原" : "最大化"}
              aria-label={maxed ? "向下还原" : "最大化"}
              onClick={() => void win.toggleMaximize()}
            >
              {maxed ? (
                // 还原：前块 + 后块的左上缺角（Windows 标准字形）
                <svg viewBox="0 0 20 20" className="ic">
                  <rect x="3.4" y="6.6" width="10" height="10" rx="2" />
                  <path d="M6.6 6.6V5.4a2 2 0 0 1 2-2h5.8a2 2 0 0 1 2 2v5.8a2 2 0 0 1-2 2h-1.2" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" className="ic">
                  <rect x="4" y="4.5" width="11" height="11" rx="2" />
                </svg>
              )}
            </button>
            <button className="wbtn close" title="关闭" onClick={() => void win.close()}>
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
              </svg>
            </button>
          </span>
        </div>
      </div>

      <div className={`b-body${showFiles ? "" : " hide-files"}${showChat ? "" : " hide-chat"}`}>
        {/* ══ 左栏：文件（作品 + 目录树） ══ */}
        <aside
          className="panel panel-files surface-rail"
          aria-label="文件"
          /* 收起时从焦点序列与无障碍树里立即移除。
             CSS 那边的 visibility:hidden 要等 240ms 过渡走完才生效，
             这 240ms 里 Tab 仍会走进一片已经看不见的面板 ——
             inert 是立即的，两者互补，缺一不可。 */
          inert={!showFiles}
          aria-hidden={!showFiles}
        >
          <div className="panel-head">
            <div className="ttl">文件</div>
            <button className="icon-btn accent" title="新建作品" onClick={() => void newProject()}>
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M10 4.5v11M4.5 10h11" />
              </svg>
            </button>
            <button className="icon-btn" title="刷新作品列表" onClick={() => void refreshProjects()}>
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M16.4 10a6.4 6.4 0 1 1-1.9-4.6" />
                <path d="M16.6 3.4v3.4h-3.4" />
              </svg>
            </button>
          </div>

          <div className="filesel-wrap" ref={fileselRef}>
            <button
              className={bookMenu ? "filesel open" : "filesel"}
              onClick={() => setBookMenu((v) => !v)}
              title="选择作品"
              aria-haspopup="listbox"
              aria-expanded={bookMenu}
            >
              <svg viewBox="0 0 20 20" className="ic bkc">
                <path d="M3 4.6A1.6 1.6 0 0 1 4.6 3h5.8l4.6 4.6v8.8A1.6 1.6 0 0 1 13.4 18H4.6A1.6 1.6 0 0 1 3 16.4V4.6z" />
              </svg>
              <span className="bk">{project ? project.ref.name : "未选择作品"}</span>
              <svg
                viewBox="0 0 12 12"
                className="uc"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 4.6L6 7.6l3-3" />
              </svg>
            </button>
            {bookMenu ? (
              <div className="bookmenu surface-raised" role="listbox" aria-label="作品列表">
                {projects.map((p) => (
                  <div className="bookrow" key={p.root}>
                    <button
                      className={`bookrow-pick${project?.ref.root === p.root ? " on" : ""}`}
                      title={p.root}
                      role="option"
                      aria-selected={project?.ref.root === p.root}
                      onClick={() => void openProject(p)}
                    >
                      <svg viewBox="0 0 20 20" className="ic">
                        <path d="M3 4.6A1.6 1.6 0 0 1 4.6 3h5.8l4.6 4.6v8.8A1.6 1.6 0 0 1 13.4 18H4.6A1.6 1.6 0 0 1 3 16.4V4.6z" />
                      </svg>
                      <span className="lbl">{p.name}</span>
                    </button>
                    <button
                      className="bookrow-del"
                      title="移入回收站"
                      aria-label={`把「${p.name}」移入回收站`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void recycleProject(p);
                      }}
                    >
                      <svg viewBox="0 0 20 20" className="ic">
                        {/* 垃圾桶：盖 + 桶身 + 两条竖线 */}
                        <path d="M4.4 6.6h11.2M8 6.6V5.2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.4" />
                        <path d="M6 6.6l.7 8.6a1.2 1.2 0 0 0 1.2 1.1h4.2a1.2 1.2 0 0 0 1.2-1.1l.7-8.6" />
                        <path d="M8.6 9.4v4.4M11.4 9.4v4.4" />
                      </svg>
                    </button>
                  </div>
                ))}
                {ready && projects.length === 0 ? <div className="empty">作品根下还没有作品</div> : null}
                <button
                  className="new"
                  onClick={() => {
                    setBookMenu(false);
                    void newProject();
                  }}
                >
                  <svg viewBox="0 0 20 20" className="ic">
                    <path d="M10 4.5v11M4.5 10h11" />
                  </svg>
                  <span className="lbl">新建作品</span>
                </button>
                {project ? (
                  <button
                    className="new"
                    onClick={() => {
                      setBookMenu(false);
                      setModulesOpen(true);
                    }}
                  >
                    <svg viewBox="0 0 20 20" className="ic">
                      <path d="M3 5.5h6M13 5.5h4M3 14.5h4M11 14.5h6" />
                      <circle cx="11" cy="5.5" r="1.9" />
                      <circle cx="9" cy="14.5" r="1.9" />
                    </svg>
                    <span className="lbl">追踪模块…</span>
                  </button>
                ) : null}
                <button
                  className="recycle"
                  onClick={() => {
                    setBookMenu(false);
                    setRecycleOpen(true);
                  }}
                >
                  <svg viewBox="0 0 20 20" className="ic">
                    <path d="M4.4 6.6h11.2M8 6.6V5.2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.4" />
                    <path d="M6 6.6l.7 8.6a1.2 1.2 0 0 0 1.2 1.1h4.2a1.2 1.2 0 0 0 1.2-1.1l.7-8.6" />
                  </svg>
                  <span className="lbl">回收站</span>
                  {recycleItems > 0 ? <span className="rb-badge">{recycleItems}</span> : null}
                </button>
              </div>
            ) : null}
          </div>

          <div className="tree" role="tree" aria-label="作品目录">
            {project ? (
              renderNodes(project.tree, 0)
            ) : (
              <div className="tree-empty">
                {ready ? "从上方选择一部作品开始写作" : "正在加载…"}
              </div>
            )}
          </div>

          <div className="panel-foot">
            {project
              ? `${project.chapters.length} 章 · ${project.pending.length} 待确认 · ${project.docs.length} 份资料`
              : "未选择作品"}
            {/* 常驻回收站入口：此前回收站只藏在作品下拉菜单最底部，
                用户不展开菜单就看不到（"没有看到回收站在哪里"）。
                现在侧栏底部固定一个入口，与统计行同列，角标沿用 recycleItems。 */}
            <button
              className="foot-recycle"
              title="打开回收站（还原或彻底删除已移入的作品）"
              onClick={() => setRecycleOpen(true)}
            >
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M4.4 6.6h11.2M8 6.6V5.2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.4" />
                <path d="M6 6.6l.7 8.6a1.2 1.2 0 0 0 1.2 1.1h4.2a1.2 1.2 0 0 0 1.2-1.1l.7-8.6" />
                <path d="M8.6 9.4v4.4M11.4 9.4v4.4" />
              </svg>
              回收站
              {recycleItems > 0 ? <span className="rb-badge">{recycleItems}</span> : null}
            </button>
          </div>
        </aside>

        {/* ══ 中栏：编辑器 ══ */}
        <main className="panel panel-editor surface-sheet" aria-label="编辑器">
          {tabs.length > 0 ? (
            <div className="tabstrip" role="tablist">
              {tabs.map((t) => (
                <div
                  key={t.rel}
                  className={t.rel === activeRel ? "tab on" : "tab"}
                  role="tab"
                  aria-selected={t.rel === activeRel}
                  onClick={() => setActiveRel(t.rel)}
                >
                  <svg viewBox="0 0 16 16" className="ic-14 ic">
                    <path d="M3.6 1.6h5.2l3.6 3.6v9.2H3.6z" />
                    <path d="M8.8 1.6v3.6h3.6" />
                  </svg>
                  <span className="nm">{t.name}</span>
                  {t.dirty ? <span className="dirty-dot" title="未保存的修改" /> : null}
                  <button
                    className="x"
                    title="关闭标签"
                    aria-label={`关闭 ${t.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeTab(t.rel);
                    }}
                  >
                    <svg
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    >
                      <path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {!activeTab ? (
            <div className="editor-empty">
              <div className="ee-logo app-mark">
                <img src={logo} alt="" />
              </div>
              <div className="ee-h">TeachWrite</div>
              <div className="ee-p">作者手写 · AI 场景导览</div>
              <div className="ee-actions">
                <button className="btn btn-accent" onClick={() => void newProject()}>
                  <svg viewBox="0 0 20 20" className="ic">
                    <path d="M3 4.6A1.6 1.6 0 0 1 4.6 3h4.2c.9 0 1.6.7 1.6 1.6v11.2a1.2 1.2 0 0 0-1.2-1.2H3V4.6z" />
                    <path d="M17 4.6A1.6 1.6 0 0 0 15.4 3h-4.2c-.9 0-1.6.7-1.6 1.6v11.2a1.2 1.2 0 0 1 1.2-1.2H17V4.6z" />
                  </svg>
                  新书启航
                </button>
                <button className="btn" onClick={() => void continueWriting()}>
                  <svg viewBox="0 0 20 20" className="ic">
                    <path d="M4 5.4h7M4 9.4h7M4 13.4h4.5" />
                    <path d="M13.9 13.3l2.6-2.6 1.1 1.1-2.6 2.6-1.5.4.4-1.5z" />
                  </svg>
                  继续写作
                </button>
                <button className="btn" onClick={() => void refreshProjects()}>
                  <svg viewBox="0 0 20 20" className="ic">
                    <path d="M16.4 10a6.4 6.4 0 1 1-1.9-4.6" />
                    <path d="M16.6 3.4v3.4h-3.4" />
                  </svg>
                  刷新作品
                </button>
              </div>
              <div className="ee-hint">
                <svg viewBox="0 0 20 20" className="ic">
                  <path d="M2.8 5.4A1.6 1.6 0 0 1 4.4 3.8h3l1.4 1.8h6.8a1.6 1.6 0 0 1 1.6 1.6v7.4a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6V5.4z" />
                </svg>
                在左侧文件面板选择作品与章节，或直接在右侧和 AI 聊聊你的故事
              </div>
            </div>
          ) : (
            <div
              className="editor-body"
              style={{ "--editor-fs": `${editorFontSize}px` } as React.CSSProperties}
            >
              <div className="editor-title">
                <h1>{activeTab.name.replace(/\.md$/i, "")}</h1>
                <span className="wc-badge">{countWords(activeTab.content)} 字</span>
                {activeTab.kind === "doc" ? (
                  /* 徽标只说**模式**，不说状态：原来这里是"资料 · 自动保存"，
                     而状态条在同一屏右侧又写一遍同一句话。现在徽标管"这是什么
                     文档"（资料 / 只读 / 编辑中），状态条管"现在存到哪一步了"
                     （未保存 / 保存中 / 已保存）—— 两者不再重复。
                     "自动保存"的行为说明留在 title 里。 */
                  <>
                    <span className="mode-badge" title="资料文档：直接编辑，切换或关闭时自动保存">
                      资料
                    </span>
                    {activeTableAvailable ? (
                      <button
                        className="chip"
                        title={activeTableView ? "切回原文编辑" : "以表格查看（只读，文件本体仍是 md）"}
                        onClick={() => void toggleDocTableView(activeTab.rel, !activeTableView)}
                      >
                        <svg viewBox="0 0 20 20" className="ic">
                          <rect x="3" y="4" width="14" height="12" rx="2" />
                          <path d="M3 8h14M9.7 8v8" />
                        </svg>
                        <span className="lbl">{activeTableView ? "原文" : "表格"}</span>
                      </button>
                    ) : null}
                  </>
                ) : (
                  <div className="editor-tools">
                    {/* 回流四态（D-043）：结束编辑时按它路由资料/风格两路回流，按本书记住 */}
                    <div className="think-wrap" ref={reflowRef}>
                      <button
                        className="chip"
                        title="回流方式：结束编辑后按本书记住的这个模式触发回流"
                        aria-haspopup="true"
                        aria-expanded={reflowMenu}
                        onClick={() => setReflowMenu((v) => !v)}
                      >
                        <svg viewBox="0 0 20 20" className="ic">
                          <path d="M4 10a6 6 0 0 1 10.5-4M16 10a6 6 0 0 1-10.5 4" />
                          <path d="M14.5 3v3h-3M5.5 17v-3h3" />
                        </svg>
                        <span className="lbl">{REFLOW_MODES.find((m) => m.id === reflowMode)?.label ?? "全部回流"}</span>
                      </button>
                      {/* down：工具栏在窗口顶部，向上开会被窗口上沿截掉（见 app.css .think-pop.down） */}
                      {reflowMenu ? (
                        <div className="think-pop down surface-raised" role="group" aria-label="回流方式">
                          {REFLOW_MODES.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              className={`think-stop ${m.id === reflowMode ? "on" : ""}`}
                              aria-pressed={m.id === reflowMode}
                              onClick={() => {
                                setReflowMenu(false);
                                void persistReflowMode(m.id);
                              }}
                            >
                              <span className="ts-label">{m.label}</span>
                              <span className="ts-hint">{m.hint}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    {!activeTab.editing ? (
                      <span className="mode-badge" title="正文与候选默认只读，点「修改」后可编辑；结束时自动保存并触发回流">
                        只读
                      </span>
                    ) : (
                      <span className="mode-badge editing" title="编辑中：点「完成」自动保存并触发回流审稿">
                        编辑中
                      </span>
                    )}
                    <button
                      className="btn"
                      onClick={() => void toggleEditing(activeTab)}
                      title={activeTab.editing ? "结束编辑：自动保存 → 回流（审稿 + 学习记录）" : "进入编辑（正文/候选默认只读）"}
                    >
                      {activeTab.editing ? "完成（保存并回流）" : "修改"}
                    </button>

                    {activeTab.kind === "candidate" && !activeTab.rel.includes(PROJECT_DIRS.processed) ? (
                      <button
                        className="btn btn-accent"
                        onClick={() => void adoptCandidate(activeTab)}
                        title="由作者确认，将当前稿逐字复制为正式正文；原稿保留，归档另行确认"
                      >
                        采用为正文
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
              {teaching.overlay}
              {activeTableView && activeDocTable ? (
                /* B7 表格视图 + B14 手改：编辑经行级手术写回内容（落盘走既有保存管线） */
                <DocTableView table={activeDocTable} onEdit={applyTableCellEdit} onDeleteRow={(b, l) => void deleteTableRow(b, l)} onAppendRow={appendTableRow} />
              ) : (
                <textarea
                  ref={editorRef}
                  className={tabEditable(activeTab) ? "editor-area" : "editor-area ro"}
                  value={activeTab.content}
                  onChange={(e) => editContent(e.target.value)}
                  readOnly={!tabEditable(activeTab)}
                  spellCheck={false}
                />
              )}
              {/* 编辑器底部快捷键（B18）：复制全文常显；剪切/全选/粘贴只在可编辑态出现 */}
              <div className="editor-quickbar">
                <button type="button" className="chip" title="复制当前文档全文到剪贴板" onClick={() => void edCopyAll()}>
                  复制全文
                </button>
                {tabEditable(activeTab) ? (
                  <>
                    <button type="button" className="chip" title="复制全文并清空（未落盘，Ctrl+S 保存）" onClick={() => void edCutAll()}>
                      剪切全文
                    </button>
                    <button type="button" className="chip" title="选中全文" onClick={edSelectAll}>
                      选中全文
                    </button>
                    <button type="button" className="chip" title="粘贴到光标处（编辑器未聚焦时追加到文末）" onClick={() => void edPaste()}>
                      粘贴
                    </button>
                    <button type="button" className="chip" title="把成对的英文双引号转成中文引号“”（单引号不动）" onClick={edUnifyQuotes}>
                      统一引号
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          )}
        </main>

        {/* ══ 右栏：AI 对话 ══ */}
        <aside
          className={busy ? "panel panel-chat surface-rail streaming" : "panel panel-chat surface-rail"}
          aria-label="AI 对话"
          /* 对话字号必须挂在**面板**这一层：它的消费者有两个 ——
             .chat-scroll 里的消息气泡，和 .composer-input 输入框 ——
             而这两者是兄弟关系。旧实现把它写在 .chat-scroll 上，
             于是输入框永远读不到用户的字号设置，只能吃兜底值。 */
          style={{ "--chat-fs": `${chatFontSize}px` } as React.CSSProperties}
          inert={!showChat}
          aria-hidden={!showChat}
        >
          <div className="chat-head" ref={sessRef}>
            <button
              className={sessMenu ? "sess-sel open" : "sess-sel"}
              onClick={() => setSessMenu((v) => !v)}
              title="切换会话"
              aria-haspopup="listbox"
              aria-expanded={sessMenu}
            >
              <span className="sess-ava">
                <svg viewBox="0 0 20 20" className="ic">
                  <path d="M10 2.6l1.8 5.6 5.6 1.8-5.6 1.8L10 17.4l-1.8-5.6L2.6 10l5.6-1.8L10 2.6z" />
                </svg>
              </span>
              <span className="sess-title">
                {session?.title?.trim() ? session.title : "新对话"}
              </span>
              <svg
                viewBox="0 0 12 12"
                className="chat-caret"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 4.6L6 7.6l3-3" />
              </svg>
            </button>
            <button className="icon-btn accent" title="新建对话" onClick={startNewChat}>
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M10 4.5v11M4.5 10h11" />
              </svg>
            </button>

            {/* 会话下拉（取代旧的对话列表栏） */}
            {sessMenu ? (
              <div className="sess-menu surface-raised" role="listbox" aria-label="会话列表">
                <button
                  className="sess-new"
                  onClick={startNewChat}
                >
                  <svg viewBox="0 0 20 20" className="ic">
                    <path d="M10 4.5v11M4.5 10h11" />
                  </svg>
                  新建对话
                </button>
                {sessionGroups.map((g) => (
                  <div key={g.label}>
                    <div className="sess-glabel">{g.label}</div>
                    {g.items.map((s) => (
                      <button
                        key={s.id}
                        className={session?.id === s.id ? "sess-item on" : "sess-item"}
                        role="option"
                        aria-selected={session?.id === s.id}
                        title={s.title}
                        onClick={() => {
                          setSessMenu(false);
                          void openSession(s.id);
                        }}
                      >
                        <em>{s.title}</em>
                        <span>{relTime(s.mtimeMs ?? 0)}</span>
                        {session?.id === s.id ? (
                          <svg viewBox="0 0 20 20" className="ic tick">
                            <path d="M4.5 10.5l3.5 3.5 7.5-8" />
                          </svg>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ))}
                {sessions.length === 0 ? <div className="sess-empty">还没有历史会话</div> : null}
              </div>
            ) : null}
          </div>

          {/* 消息区与「回到底部」悬浮钮的定位容器（按钮钉在容器内，不随内容滚动） */}
          <div className="chat-main">
          {hasMessages ? (
            <div
              className="chat-scroll"
              ref={chatScroll}
              onScroll={onChatScroll}
            >
              {/* session 可能为 null：只手改稿、从没开过对话的用户触发回流时，
                  drainReflow 只置 busy 不设会话 —— 此时 hasMessages 因 busy 成立，
                  旧代码 `session!.messages` 直接 TypeError 卸载整棵树（白屏）。
                  空会话就渲染空气泡区，打字指示照常工作。 */}
              {(session?.messages ?? []).map((m) => (
                  <ChatMessageRow key={m.id} m={m} />
                ))}
              {toolLog.map((t, i) => (
                <div key={`live-${i}`} className="tool-line">
                  <svg viewBox="0 0 20 20" className="ic ic-14">
                    <path d="M7.5 3.5h-3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-3" />
                    <path d="M11.5 8.5l6-6M17.5 5.5v-3h-3" />
                  </svg>
                  {t.name}{" "}
                  {t.status === "run" ? (
                    <svg viewBox="0 0 20 20" className="ic ic-14 spin">
                      <path d="M10 3a7 7 0 1 0 7 7" />
                    </svg>
                  ) : t.status === "ok" ? (
                    <span className="ok">✓</span>
                  ) : (
                    <span className="bad">✕</span>
                  )}
                </div>
              ))}
              {streamThink ? <div className="think live">{streamThink}</div> : null}
              {streamText ? (
                <div className="msg ai">
                  <div className="who">TeachWrite · 生成中</div>
                  <div className="bubble">{streamText}</div>
                </div>
              ) : null}
              {showTyping ? (
                <div className="msg ai">
                  <div className="who">TeachWrite</div>
                  <div className="bubble typing">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              ) : null}
              {chatError ? <div className="err-line">{chatError}</div> : null}
              {truncNote ? <div className="notice-line">{truncNote}</div> : null}
            </div>
          ) : (
            <div className="chat-welcome">
              <div className="cw-logo app-mark">
                <img src={logo} alt="" />
              </div>
              <div className="cw-h">TeachWrite 助手</div>
              <div className="cw-p">AI 提供导览和审读，正文由你亲手写</div>
              <div className="cw-tips">
                {STARTER_TIPS.map((tip) => (
                  <button
                    key={tip.label}
                    className="cw-tip"
                    onClick={() => {
                      setComposer(tip.text);
                      composerRef.current?.focus();
                    }}
                  >
                    <svg viewBox="0 0 20 20" className="ic">
                      <path d="M10 2.6l1.8 5.6 5.6 1.8-5.6 1.8L10 17.4l-1.8-5.6L2.6 10l5.6-1.8L10 2.6z" />
                    </svg>
                    {tip.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* 上翻阅读历史时的回底入口：自动跟随已让位（pinned=false），
              点它重新接管跟随；流式生成中提示「有新消息」。 */}
          {hasMessages && !atBottom ? (
            <button className="chat-jump surface-raised" onClick={jumpToBottom} title="回到最新消息">
              <svg viewBox="0 0 20 20" className="ic">
                <path d="M10 4.5v11M4.5 10l5.5 5.5L15.5 10" />
              </svg>
              {busy ? "有新消息" : "回到底部"}
            </button>
          ) : null}
          </div>

          {/* 教学动作走专用工作流；可编辑快捷词只填入普通讨论输入框。 */}
          {teaching.actions}
          {teaching.review}
          <QuickPromptBar
            dirs={dirs}
            onPick={(text) => {
              setComposer(text);
              composerRef.current?.focus();
            }}
          />

          <div className="composer surface-well">
            {/* AI 三态模式（输入框内部、思考档上方；用户裁决的落点）。
                默认开发、只存内存、重启回默认；只读/写作下采用门与回流跳弹窗。 */}
            <div className="mode-row" role="radiogroup" aria-label="AI 模式">
              {AI_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={aiMode === m.id}
                  className={aiMode === m.id ? "mode-btn on" : "mode-btn"}
                  title={m.hint}
                  onClick={() => setAiMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <textarea
              ref={composerRef}
              className="composer-input"
              value={composer}
              placeholder="写下你的故事，或让 AI 帮你写…"
              aria-label="消息输入框"
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={(e) => {
                // 中文 IME 组合中的 Enter 是选词确认，不能当作发送
                if (e.nativeEvent.isComposing || e.key === "Process") return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void doSend();
                }
              }}
            />
            <div className="comp-row">
              <div className="think-wrap" ref={thinkRef}>
                <button
                  className={thinkEffective === "off" ? "chip think" : "chip think accent"}
                  title={
                    thinkSupported
                      ? `思考模式：${thinkStop.label}（点选档位，本会话内临时生效，不改配置文件）`
                      : "当前平台不支持思考参数（仅 DeepSeek 官方端点可用）"
                  }
                  aria-haspopup="true"
                  aria-expanded={thinkOpen}
                  disabled={busy || !thinkSupported}
                  onClick={() => setThinkOpen((v) => !v)}
                >
                  <svg viewBox="0 0 20 20" className="ic">
                    <path d="M6.6 15.6h6.8M7.2 17.8h5.6" />
                    <path d="M10 2.6c3 0 5.2 2 5.2 4.7 0 2-1.1 3-2.2 4.1-.7.7-1 1.3-1 2.2H8c0-.9-.3-1.5-1-2.2-1.1-1.1-2.2-2.1-2.2-4.1C4.8 4.6 7 2.6 10 2.6z" />
                  </svg>
                  {/* 档位名包一层 span：胶囊限宽时文字单行省略，不顶破布局 */}
                  <span className="lbl">思考·{thinkStop.label}</span>
                </button>
                {thinkOpen ? (
                  <div className="think-pop surface-raised" role="group" aria-label="思考档位">
                    {THINKING_STOPS.map((s) => (
                      <button
                        key={s.level}
                        type="button"
                        className={`think-stop ${s.level === thinkEffective ? "on" : ""}`}
                        aria-pressed={s.level === thinkEffective}
                        onClick={() => {
                          setThinkLevel(s.level);
                          setThinkOpen(false);
                        }}
                      >
                        <span className="ts-label">{s.label}</span>
                        <span className="ts-hint">{s.hint}</span>
                      </button>
                    ))}
                    {thinkLevel !== null ? (
                      <button
                        type="button"
                        className="think-reset"
                        onClick={() => {
                          setThinkLevel(null);
                          setThinkOpen(false);
                        }}
                      >
                        跟随配置默认
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <button className="chip model" title="在设置中配置模型" onClick={onOpenSettings}>
                <svg viewBox="0 0 16 16" className="ic">
                  <path
                    d="M8 1.6c2.6 3.3 3.9 5.6 3.9 7.1A3.9 3.9 0 0 1 8 12.6a3.9 3.9 0 0 1-3.9-3.9c0-1.5 1.3-3.8 3.9-7.1z"
                    fill="currentColor"
                    stroke="none"
                  />
                  <path d="M4.6 14.6h6.8" />
                </svg>
                <span>{modelLabel}</span>
              </button>
              {busy ? (
                <button
                  className="chip stop"
                  title="停止生成（立即中断当前流）"
                  onClick={stopGeneration}
                >
                  <svg viewBox="0 0 20 20" className="ic">
                    <rect x="5.5" y="5.5" width="9" height="9" rx="1.6" fill="currentColor" stroke="none" />
                  </svg>
                  停止
                </button>
              ) : null}
              {!hasKey ? <span className="chip warn">未配置 API Key</span> : null}
              <button
                className="send"
                title="发送（Enter）"
                aria-label="发送"
                onClick={() => void doSend()}
                disabled={busy || composer.trim() === ""}
              >
                <svg viewBox="0 0 24 24" className="ic">
                  <path d="M12 19V5" />
                  <path d="M5.5 11.5L12 5l6.5 6.5" />
                </svg>
              </button>
            </div>
          </div>
        </aside>

        {/* ══ 第四/五栏：网页版参考栏（D-057，默认隐藏） ══
            DOM 顺序固定 DS 在朱雀前：DS 关着时朱雀自然就是第四栏。
            子 webview 的几何跟随由 WebColumn 自己同步。 */}
        {webCols.ds ? (
          <WebColumn siteKey="deepseek" title="DeepSeek 网页版" suspended={suspended} onClose={() => setWebCols((c) => ({ ...c, ds: false }))} />
        ) : null}
        {webCols.zq ? (
          <WebColumn siteKey="zhuque" title="朱雀AI检测" suspended={suspended} onClose={() => setWebCols((c) => ({ ...c, zq: false }))} />
        ) : null}
      </div>

      {/* ── 全局状态条 ── */}
      <div className="statusbar">
        <span className="st-left" role="status">{status}</span>
        <span className="st-right">
          {activeTab ? (
            <>
              {/* 保存态用线表达：实线=已落盘，虚线=有未落盘改动。
                  key 随保存态变化 —— React 会重建这个 span，于是那条线
                  会自左向右重新"划"出来一次（落盘那一刻的过签动作）。
                  它右侧永远跟着文字，状态从不只靠颜色或线形单独承担。 */}
              <span
                key={activeTab.dirty || saving ? "unsaved" : "saved"}
                className={activeTab.dirty || saving ? "st-save unsaved" : "st-save"}
              />
              {activeTab.kind === "doc"
                ? saving
                  ? "保存中…"
                  : activeTab.dirty
                    ? "未保存 · Ctrl+S 保存"
                    : "已保存"
                : activeTab.editing
                  ? "编辑中 · 点「完成」保存并回流"
                  : "只读 · 点「修改」后可编辑"}
            </>
          ) : null}
        </span>
      </div>

      <MemoModal open={memoOpen} onClose={() => setMemoOpen(false)} project={project} onStatus={setStatus} askText={askText} />

      <RecycleBin
        open={recycleOpen}
        onClose={() => setRecycleOpen(false)}
        booksRoot={dirs?.booksRoot ?? null}
        onStatus={setStatus}
        onChanged={() => void refreshProjects()}
        askTypedConfirm={askTypedConfirm}
        askConfirm={askConfirm}
      />

      {/* 冷读悬浮面板（D-045）：无遮罩、不抢焦点；材料只在内存，关窗即弃。
          D-058：冷读有独立的生成槽（busy/abort/传输实例全套独立），不占聊天界面。 */}
      {cold ? (
        <ColdReadPanel
          state={cold}
          onChannel={(ch) => setCold((c) => (c ? { ...c, channel: ch } : c))}
          onPrior={(n) => setCold((c) => (c ? { ...c, priorCount: n } : c))}
          onStart={() => void runColdRead()}
          onStop={stopColdRead}
          onClose={() => {
            // 审读进行中关闭 = 中止并丢弃（只停冷读自己，D-058）
            if (cold.phase === "running") stopColdRead();
            setCold(null);
          }}
          onToggle={coldToggle}
          onDelete={coldDelete}
          onSend={(ids) => void coldSend(ids)}
          onLocate={coldLocate}
        />
      ) : null}

      {pending ? (
        <div className="qmodal scrim">
          <div
            className="qbox surface-raised sheet wide"
            role="dialog"
            aria-modal="true"
            aria-label="需要你的选择"
            tabIndex={-1}
            ref={pendPanelRef}
          >
            {pending.items.map((q, qi) => (
              <div key={qi} style={{ marginBottom: 16 }}>
                <h3>
                  {q.question}
                  {q.multi_select ? "（可多选）" : ""}
                </h3>
                {/* B12 批次8：exec.ts 已逐项归一，这里再兜一层 —— 渲染期抛错会整树白屏 */}
                {(q.options ?? []).map((o) => {
                  const on = (qSel[qi] ?? []).includes(o.label);
                  return (
                    <button
                      key={o.label}
                      className={on ? "qopt on" : "qopt"}
                      ref={qi === 0 && o === (q.options ?? [])[0] ? pendFirstRef : undefined}
                      onClick={() =>
                        setQSel((s) => {
                          const cur = s[qi] ?? [];
                          const next = q.multi_select
                            ? cur.includes(o.label)
                              ? cur.filter((x) => x !== o.label)
                              : [...cur, o.label]
                            : [o.label];
                          return { ...s, [qi]: next };
                        })
                      }
                    >
                      {o.label}
                      {o.description ? <span className="d">{o.description}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))}
            <button
              className="qsubmit btn btn-accent"
              onClick={answerPending}
              disabled={pending.items.some((_, i) => (qSel[i] ?? []).length === 0)}
              title={pending.items.some((_, i) => (qSel[i] ?? []).length === 0) ? "每个问题都选择后才可提交" : undefined}
            >
              提交
            </button>
          </div>
        </div>
      ) : null}

      {/* 开书引导（新建作品）：引导开书会把答案预填进开书定位与核心设定 */}
      <NewBookWizard open={newBookOpen} onCancel={() => setNewBookOpen(false)} onCreate={createBook} />

      {/* 追踪模块管理（B8：启用/停用 + 中途建仓） */}
      {/* 使用教程(B19/D-053):标题栏「帮助」打开;同一份内容也内嵌在设置屏「帮助」分页 */}
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} onStatus={setStatus} />

      {/* 首启欢迎弹窗(B19/D-053):logo + 作者声明 + 抖音入口 + QQ 群,可永久关闭 */}
      <WelcomeModal
        open={welcomeOpen}
        onClose={() => setWelcomeOpen(false)}
        onNeverShow={dismissWelcome}
        onHelp={() => {
          setWelcomeOpen(false);
          setHelpOpen(true);
        }}
        onStatus={setStatus}
      />

      <ModulesDialog
        open={modulesOpen}
        onClose={() => setModulesOpen(false)}
        project={project}
        onStatus={setStatus}
        onSendPrompt={(text) => void sendUserMessage(text)}
        askConfirm={askConfirm}
      />

      {/* ── 三个通用对话框永远排在最后 ──
          `.qmodal` 都是 z-index:90，**同层的先后由 DOM 顺序决定**。
          它们会被"模态里的按钮"唤起（回收站的「彻底删除」→ 手打确认、
          备忘录的改名 → 输入框），所以必须盖在其它模态之上；
          实测过的坑：把 TypedConfirmDialog 放在 RecycleBin 之前，
          手打确认框会整块躲在回收站底下（只露出一条边），
          点得到（DOM 在）但看不见 —— 最坏的那种 bug。 */}
      <InputDialog req={inputReq} />
      <ConfirmDialog req={confirmReq} />
      <TypedConfirmDialog req={typedReq} />
    </div>
  );
}
