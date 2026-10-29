/**
 * 资料表格视图（D-043 / B7 只读；2026-10-06 B14 起可手改）：把 docTableFor 的
 * 解析结果渲染成表格，并允许像表格一样编辑 —— 编辑经 CellAddr 行级手术写回
 * 文档文本（applyCellEdit），除目标区间外其余字节逐字节不变；落盘仍走
 * MainWorkbench 的现有保存管线（写前快照 → 写盘 → oplog），本组件不碰磁盘。
 *
 * 展开判定：实测溢出（scrollHeight > clientHeight，挂载与尺寸变化时测量）——
 * 截断按可视行数发生，与字符数无关；真被截的单元格才有展开/收起。
 *
 * 编辑交互：
 *  - 单元格尾部「改」钮进入编辑；单行值给 input（Enter/失焦提交、Esc 取消），
 *    多行区间给 textarea（「确认」提交、Esc 取消）；
 *  - 封闭取值字段（状态/当前阶段/正文处理进度等）给点选 select；
 *  - grid 行末「删」删整条目（调用方确认）；表尾「＋ 新条目」按列结构生成
 *    待填写条目（追踪表与规则台账；编号自动续）。
 * 用户手改是最高权威：不跑 docschema 落点校验（那道门只拦 AI 的 file_write）。
 */
import { useEffect, useRef, useState } from "react";
import {
  columnWeightsFor,
  statusSymbol,
  type CellAddr,
  type DocTable,
  type DocTablePart,
  type GridRow,
} from "../core/store/doctable";

/** 编辑提交回调：addr 指向的内容替换为 newText */
export type TableEditHandler = (addr: CellAddr, newText: string) => void;
/** 删除条目回调：block = 整条目块的行区间，label 用于确认文案 */
export type TableDeleteHandler = (block: CellAddr, label: string) => void;
/** 追加条目回调：part = 目标 grid（含列结构与既有条目，供生成新条目） */
export type TableAppendHandler = (part: Extract<DocTablePart, { kind: "grid" }>) => void;

/** 封闭取值字段的点选清单（key = 字段名/列名；按文件分）。符号化看法在 doctable.STATUS_SYMBOL */
export const STATUS_BY_FILE: Record<string, string[]> = {
  "追踪-伏笔.md": ["开放", "已回收", "废弃"],
  "追踪-时间线.md": ["开放", "完成", "废弃"],
  "追踪-资源与权限.md": ["有效", "耗尽", "失去", "废弃"],
  "追踪-废弃设定.md": ["是", "否"],
  // 2026-10-11 对齐盘上真实词表：原文只有「候选/已晋升/已否决」，与台账实际在用的
  // 「待观察」「已晋升（附条件）」不符，导致这两个值点不出来（只能原样保留）
  "规则台账.md": ["候选", "待观察", "已晋升", "已晋升（附条件）", "已否决"],
};

/** 该文件该状态值的符号；没有符号约定就返回原值 */
function symbolize(fileName: string, value: string): string {
  return statusSymbol(fileName, value) ?? value;
}

/** 点选项：value 是写回文件的中文原值，label 是带符号的显示文案 */
interface EnumOption {
  value: string;
  label: string;
}

/** 该文件该字段是否为封闭取值；返回可选值清单（null = 自由文本） */
function enumOptionsFor(fileName: string, key: string): EnumOption[] | null {
  const raw = rawEnumValues(fileName, key);
  return raw ? raw.map((v) => ({ value: v, label: symbolize(fileName, v) })) : null;
}

function rawEnumValues(fileName: string, key: string): string[] | null {
  if (fileName === "00-项目状态.md") {
    if (key === "当前阶段") return ["开书准备", "开书自检", "连续写作", "收尾"];
    if (key === "正文处理进度") return ["未开始", "起草中", "待逐段修改", "修改复读中", "待用户确认"];
  }
  if (key === "状态") {
    if (STATUS_BY_FILE[fileName]) return STATUS_BY_FILE[fileName];
    if (/^第.+章细纲(（已完成）)?\.md$/.test(fileName)) return ["进行中", "未启动", "已完成"];
  }
  if (fileName === "追踪-废弃设定.md" && key === "禁止恢复") return ["是", "否"];
  return null;
}

/** 编辑中的草稿状态：定位到某格 + 当前文本 */
interface EditingState {
  key: string;
  addr: CellAddr;
  draft: string;
}

/** 单元格：截断展开 + 可选编辑。editingKey 由父级持有（同一时刻只编辑一格） */
function Cell({
  text,
  addr,
  enumOptions,
  cellKey,
  editing,
  onEdit,
  onBeginEdit,
  onCommit,
  onCancelEdit,
}: {
  text: string;
  addr: CellAddr | null;
  enumOptions: EnumOption[] | null;
  cellKey: string;
  editing: EditingState | null;
  onEdit: TableEditHandler | undefined;
  onBeginEdit: (key: string, addr: CellAddr, draft: string) => void;
  onCommit: () => void;
  onCancelEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    // 列宽随窗口/面板变化：尺寸一变就重新量（截断状态跟着变）
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, text]);

  // ── 编辑态 ──
  if (editing && editing.key === cellKey) {
    if (enumOptions) {
      // value 直接用草稿原值：不在清单里的旧值/自定义值也照常选中（下面用隐藏 option 兜底）
      return (
        <select
          className="dt-editor"
          autoFocus
          value={editing.draft}
          onChange={(e) => {
            onEdit?.(editing.addr, e.target.value);
            onCancelEdit();
          }}
          onBlur={onCancelEdit}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancelEdit();
          }}
        >
          {/* 当前值不在清单里（旧值/自定义值）也要能显示与保留 */}
          {!enumOptions.some((o) => o.value === editing.draft) ? (
            <option value={editing.draft}>{editing.draft}</option>
          ) : null}
          {enumOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    const multiline = editing.addr.valueCol === null || editing.draft.includes("\n");
    if (multiline) {
      return (
        <span className="dt-editing">
          <textarea
            className="dt-editor dt-editor-area"
            autoFocus
            value={editing.draft}
            rows={Math.min(12, Math.max(3, editing.draft.split("\n").length + 1))}
            onChange={(e) => onBeginEdit(cellKey, editing.addr, e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") onCancelEdit();
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onCommit();
            }}
          />
          <span className="dt-edit-acts">
            <button type="button" className="dt-act" onClick={onCommit}>确认</button>
            <button type="button" className="dt-act" onClick={onCancelEdit}>取消</button>
          </span>
        </span>
      );
    }
    return (
      <input
        className="dt-editor"
        autoFocus
        value={editing.draft}
        onChange={(e) => onBeginEdit(cellKey, editing.addr, e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") onCommit();
          if (e.key === "Escape") onCancelEdit();
        }}
      />
    );
  }

  // ── 展示态 ──
  if (text === "") {
    return (
      <span className="dt-cellwrap">
        <span className="dt-empty">—</span>
        {addr && onEdit ? (
          <button
            type="button"
            className="dt-act"
            title="编辑这一格"
            onClick={() => onBeginEdit(cellKey, addr, "")}
          >
            改
          </button>
        ) : null}
      </span>
    );
  }
  const interactive = open || clamped;
  return (
    <span className="dt-cellwrap">
      <span
        ref={ref}
        className={open ? "dt-cell" : "dt-cell clamp"}
        title={interactive ? (open ? "点击收起" : "点击展开全文") : undefined}
        onClick={interactive ? () => setOpen((v) => !v) : undefined}
        role={interactive ? "button" : undefined}
      >
        {text}
      </span>
      {addr && onEdit ? (
        <button
          type="button"
          className="dt-act"
          title="编辑这一格"
          onClick={() => onBeginEdit(cellKey, addr, text)}
        >
          改
        </button>
      ) : null}
    </span>
  );
}

/**
 * 状态类值的徽章（只读展示；中性灰底，不消耗强调色）。
 * 有符号约定时只显示符号（列很窄，容不下四个字），中文原值留在 title 里。
 */
function StatusCell({ text, fileName }: { text: string; fileName: string }) {
  if (text === "") return <span className="dt-empty">—</span>;
  const sym = statusSymbol(fileName, text);
  if (sym) {
    return (
      <span className="dt-status dt-sym" title={text}>
        {sym}
      </span>
    );
  }
  return <span className="dt-status">{text}</span>;
}

/** 该格是否值得给「改」钮（有落点且父级允许编辑） */
function editable(addr: CellAddr | null, onEdit: TableEditHandler | undefined): boolean {
  return Boolean(addr && onEdit);
}

interface ViewProps {
  table: DocTable;
  onEdit?: TableEditHandler;
  onDeleteRow?: TableDeleteHandler;
  onAppendRow?: TableAppendHandler;
}

/** grid 的一行 */
function GridRowView({
  part,
  row,
  rowIdx,
  partIdx,
  editing,
  fileName,
  handlers,
}: {
  part: Extract<DocTablePart, { kind: "grid" }>;
  row: GridRow;
  rowIdx: number;
  partIdx: number;
  editing: EditingState | null;
  fileName: string;
  handlers: {
    onEdit?: TableEditHandler;
    onDeleteRow?: TableDeleteHandler;
    onBeginEdit: (key: string, addr: CellAddr, draft: string) => void;
    onCommit: () => void;
    onCancelEdit: () => void;
  };
}) {
  const label = row.cells[0] || `第 ${rowIdx + 1} 条`;
  const lastIdx = row.cells.length - 1;
  /** 行末删钮：不再单占一列（用户 2026-10-11「空列删掉」），改为悬停时浮在行右端 */
  const del =
    row.block && handlers.onDeleteRow ? (
      <button
        type="button"
        className="dt-rowdel"
        title={`删除「${label}」整条`}
        onClick={() => handlers.onDeleteRow!(row.block!, label)}
      >
        删
      </button>
    ) : null;
  return (
    <tr>
      {row.cells.map((cell, j) => (
        <td key={j}>
          {/^(状态|命中章节数)$/.test(part.columns[j]) && !(editing && editing.key === `${partIdx}:${rowIdx}:${j}`) ? (
            <span className="dt-cellwrap">
              <StatusCell text={cell} fileName={fileName} />
              {editable(row.addrs[j], handlers.onEdit) ? (
                <button
                  type="button"
                  className="dt-act"
                  title="编辑这一格"
                  onClick={() => handlers.onBeginEdit(`${partIdx}:${rowIdx}:${j}`, row.addrs[j]!, cell)}
                >
                  改
                </button>
              ) : null}
            </span>
          ) : (
            <Cell
              text={cell}
              addr={row.addrs[j]}
              enumOptions={enumOptionsFor(fileName, part.columns[j])}
              cellKey={`${partIdx}:${rowIdx}:${j}`}
              editing={editing}
              onEdit={handlers.onEdit}
              onBeginEdit={handlers.onBeginEdit}
              onCommit={handlers.onCommit}
              onCancelEdit={handlers.onCancelEdit}
            />
          )}
          {j === lastIdx ? del : null}
        </td>
      ))}
    </tr>
  );
}

function PartView({
  part,
  partIdx,
  editing,
  fileName,
  handlers,
}: {
  part: DocTablePart;
  partIdx: number;
  editing: EditingState | null;
  fileName: string;
  handlers: {
    onEdit?: TableEditHandler;
    onDeleteRow?: TableDeleteHandler;
    onAppendRow?: TableAppendHandler;
    onBeginEdit: (key: string, addr: CellAddr, draft: string) => void;
    onCommit: () => void;
    onCancelEdit: () => void;
  };
}) {
  if (part.kind === "prose") {
    return (
      <div className="dt-part">
        {part.title ? <div className="dt-part-title">{part.title}</div> : null}
        {/* dt-prose：散文卡用阅读字号与 1.7 行距（与正文卡区分），包着 Cell 的编辑态 */}
        <div className="dt-prose">
          <Cell
            text={part.text}
            addr={part.addr}
            enumOptions={null}
            cellKey={`${partIdx}:p`}
            editing={editing}
            onEdit={handlers.onEdit}
            onBeginEdit={handlers.onBeginEdit}
            onCommit={handlers.onCommit}
            onCancelEdit={handlers.onCancelEdit}
          />
        </div>
      </div>
    );
  }
  if (part.kind === "kv") {
    return (
      <div className="dt-part">
        {part.title ? <div className="dt-part-title">{part.title}</div> : null}
        <table className="dt-table dt-kv">
          <tbody>
            {part.rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{r.label}</th>
                <td>
                  <Cell
                    text={r.value}
                    addr={r.addr}
                    enumOptions={enumOptionsFor(fileName, r.label)}
                    cellKey={`${partIdx}:${i}`}
                    editing={editing}
                    onEdit={handlers.onEdit}
                    onBeginEdit={handlers.onBeginEdit}
                    onCommit={handlers.onCommit}
                    onCancelEdit={handlers.onCancelEdit}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const weights = columnWeightsFor(fileName, part.columns);
  return (
    <div className="dt-part">
      {part.title ? <div className="dt-part-title">{part.title}</div> : null}
      <div className="dt-scroll">
        <table className={weights ? "dt-table dt-grid dt-fixed" : "dt-table dt-grid"}>
          {/* 用户逐表指定的列宽（100 分制）；未声明的表不给 colgroup，保持内容自适应 */}
          {weights ? (
            <colgroup>
              {weights.map((w, i) => (
                <col key={i} style={{ width: `${w}%` }} />
              ))}
            </colgroup>
          ) : null}
          <thead>
            <tr>
              {part.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {part.rows.map((row, i) => (
              <GridRowView
                key={i}
                part={part}
                row={row}
                rowIdx={i}
                partIdx={partIdx}
                editing={editing}
                fileName={fileName}
                handlers={handlers}
              />
            ))}
          </tbody>
        </table>
      </div>
      {part.appendAt !== null && handlers.onAppendRow && gridSupportsAppend(part, fileName) ? (
        <div className="dt-append">
          <button type="button" className="dt-act" onClick={() => handlers.onAppendRow!(part)}>
            ＋ 新条目
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 支持加行的 grid：列结构 = 「条目 + 若干 `- 键：值` 字段」（追踪表、规则台账、06 规则表）。
 * 06 有两张 grid，**按列结构区分**：只有「规则编号 + 三字段」的规则表能加行，
 * 禁用列表（禁止项 + 来源）是行条目，加行会生成出错的块 → 不给钮。
 */
export function gridSupportsAppend(part: Extract<DocTablePart, { kind: "grid" }>, fileName: string): boolean {
  if (fileName === "06-写作风格.md") return part.columns[0] === "规则编号";
  return fileName.startsWith("追踪-") || fileName === "规则台账.md";
}

/** 资料表格视图；unparsedBlocks > 0 时顶部给一条回落提示 */
export default function DocTableView({ table, onEdit, onDeleteRow, onAppendRow }: ViewProps) {
  const [editing, setEditing] = useState<EditingState | null>(null);

  const onBeginEdit = (key: string, addr: CellAddr, draft: string) => setEditing({ key, addr, draft });
  const onCancelEdit = () => setEditing(null);
  const onCommit = () => {
    if (!editing) return;
    onEdit?.(editing.addr, editing.draft);
    setEditing(null);
  };

  if (table.parts.length === 0) {
    return <div className="dt-empty-doc">没有可表格化的内容（切回原文查看）。</div>;
  }
  const handlers = { onEdit, onDeleteRow, onAppendRow, onBeginEdit, onCommit, onCancelEdit };
  return (
    <div className="dt-root">
      {table.unparsedBlocks > 0 ? (
        <div className="dt-note" role="status">
          有 {table.unparsedBlocks} 块未按格式解析，已按原文显示（只报告，不改写）。
        </div>
      ) : null}
      {table.parts.map((p, i) => (
        <PartView
          key={i}
          part={p}
          partIdx={i}
          editing={editing}
          fileName={table.fileName}
          handlers={handlers}
        />
      ))}
    </div>
  );
}
