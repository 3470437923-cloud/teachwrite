/**
 * 传输层：把 Rust 侧 `ai_stream` 转发的 SSE 行接成 StreamTransport。
 * Rust 只转发原始行；HTTP 错误用 `__HTTP_ERROR__<status>|<body>` 前缀传回，
 * 由 agent 侧统一做逐字错误分类（errors.ts）。
 *
 * 与 Rust 侧（src-tauri/ai.rs）的对应关系：
 *  - ai_stream：按 '\n' 切行转发 kind:"line"；连接失败/流中断发 kind:"stream_error"；
 *    非 2xx 发 kind:"http_error"（data 为 "<status>|<body>"）；每条请求最终必发 kind:"done"；
 *  - ai_abort：触发中断句柄 → Rust 截断上游连接 → 仍会发 done（本层的 finished
 *    Promise 因此必然 resolve，中止不会挂死）。
 *
 * 生命周期：每次 stream() 注册一个 ai_chunk 监听（先 listen 后 invoke，避免丢首事件），
 * finally 里必定 unlisten（正常/异常/中止都不泄漏）；监听按 requestId 过滤，
 * 压缩摘要流与主流先后复用同一传输层也不串话。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { HttpRequest } from "./protocol";
import type { StreamTransport } from "./agent";

/** HTTP 错误哨兵前缀（与 agent.ts 的解析逐字对应；SSE 数据行不会以它开头，无碰撞） */
export const HTTP_ERROR_PREFIX = "__HTTP_ERROR__";

/** ai_chunk 事件负载（与 Rust 侧 AiChunk 的 camelCase 序列化一致） */
interface AiChunk {
  requestId: string;
  kind: "line" | "http_error" | "stream_error" | "done";
  data: string;
}

/** 请求 id：优先 crypto.randomUUID（Rust 侧只当不透明键用） */
function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `req_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

/**
 * 生产传输层 + 本实例的中止句柄。
 *
 * 中止槽是**每实例一个**（D-058）：旧实现是模块级单槽 `activeAbort`，前提是
 * 「全应用单生成并发」——冷读改走独立生成槽后这个前提被打破，聊天与冷读
 * 两条流并存时单槽会让「停止」张冠李戴（后注册的流顶掉先注册的句柄）。
 * 现在聊天/回流共用一个实例、冷读自己一个实例，各自的停止只停各自的流。
 * 同一实例内部仍是单槽：主流与压缩摘要流是先后关系，不会同时占用。
 */
export interface TauriTransport extends StreamTransport {
  /** 中断本实例的当前流：Rust 侧截断上游连接，已收到的部分正文保留；无活跃流时是 no-op */
  abortActive(): void;
}

export function createTauriTransport(): TauriTransport {
  let activeAbort: (() => void) | null = null;
  return {
    abortActive() {
      activeAbort?.();
    },
    async stream(req: HttpRequest, handlers): Promise<void> {
      const requestId = uuid();
      let cancelled = false;
      let started = false;
      const abort = () => {
        if (cancelled) return;
        cancelled = true;
        if (started) {
          void invoke("ai_abort", { requestId }).catch((e: unknown) => handlers.onError(String(e)));
        }
      };
      activeAbort = abort;
      let unlisten: (() => void) | undefined;
      let finish: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });

      try {
        // 先挂监听再 invoke：Rust 首行事件可能紧随 invoke 到达，顺序反了会丢行
        unlisten = await listen<AiChunk>("ai_chunk", (event) => {
          const p = event.payload;
          if (p.requestId !== requestId) return;
          switch (p.kind) {
            case "line":
              handlers.onLine(p.data);
              break;
            case "http_error":
              // 折成哨兵行走 onLine：agent 侧统一解析 status|body 并逐字分类
              handlers.onLine(HTTP_ERROR_PREFIX + p.data);
              break;
            case "stream_error":
              handlers.onError(p.data);
              break;
            case "done":
              finish();
              break;
          }
        });

        // 注册监听期间的停止尚无 Rust 句柄，直接取消这次发送。
        if (cancelled) return;
        started = true;
        await invoke("ai_stream", {
          request: { requestId, url: req.url, headers: req.headers, body: req.body },
        });
        await finished;
      } finally {
        // 无论正常结束、HTTP 错误还是 invoke 异常，监听必须摘除（防泄漏）
        if (activeAbort === abort) activeAbort = null;
        unlisten?.();
      }
    },
  };
}
