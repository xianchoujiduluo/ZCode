// 移动端对话视图：实时刷新（ETag 轮询 + 事件触发）+ 发送输入。
// 独立于 SessionPane 的轻量实现，专供 MobileApp 使用。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeTaskSnapshot, ZCodePersistedMessage } from "@zcode/shared";
import type { connectViaWebSocket } from "@zcode/client";

type Services = Awaited<ReturnType<typeof connectViaWebSocket>>;

const POLL_INTERVAL_MS = 2000;
const MESSAGE_LIMIT = 50;

/* ───────────────────────── i18n ── */

const isZh = typeof navigator !== "undefined" && navigator.language.startsWith("zh");
const T = {
  loading: isZh ? "加载中…" : "Loading…",
  error: isZh ? "加载失败" : "Failed to load",
  retry: isZh ? "重试" : "Retry",
  noContent: isZh ? "（无文本输出）" : "(no text output)",
  refresh: isZh ? "刷新" : "Refresh",
  placeholder: isZh ? "输入消息…" : "Type a message…",
  send: isZh ? "发送" : "Send",
  sending: isZh ? "发送中…" : "Sending…",
  toolCalls: isZh ? "{count} 次工具调用" : "{count} tool calls",
  thinking: isZh ? "思考中…" : "Thinking…",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function makeTraceId(): string {
  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ───────────────────────── 对话主组件 ── */

export function MobileConversation({
  services,
  projectPath,
  taskId,
}: {
  services: Services;
  projectPath: string;
  taskId: string;
}) {
  const [snapshot, setSnapshot] = useState<ZCodeTaskSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const etagRef = useRef<string | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pollTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);

  /** ETag 轮询：有变化才更新 state，服务端无变化时 notModified=true 零开销。 */
  const refresh = useCallback(async () => {
    if (disposedRef.current) return;
    try {
      const result = await services.zcodeTaskService.getTaskSnapshotWithEtag({
        taskId,
        workspacePath: projectPath,
        clientMode: "web-remote-replayable",
        messageLimit: MESSAGE_LIMIT,
        ifNoneMatch: etagRef.current,
      });
      if (disposedRef.current) return;
      if (result.notModified) return;
      if (result.etag !== undefined) {
        etagRef.current = result.etag;
      }
      if (result.snapshot) {
        setSnapshot(result.snapshot);
        setError(null);
      }
    } catch (e) {
      if (!disposedRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [services, taskId, projectPath]);

  // 初始加载 + 轮询
  useEffect(() => {
    disposedRef.current = false;
    etagRef.current = undefined;
    void refresh();
    pollTimerRef.current = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);

    // 订阅 workspace 事件：task list 变化时立即刷新（比轮询更及时）
    let disposable: { dispose(): void } | null = null;
    try {
      const event = services.zcodeTaskService.onDynamicWorkspaceEvent({ workspacePath: projectPath });
      disposable = event(() => void refresh());
    } catch {
      // 事件订阅失败时轮询仍然兜底
    }

    return () => {
      disposedRef.current = true;
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      disposable?.dispose();
    };
  }, [refresh, projectPath, services]);

  // 新消息时滚到底部
  const messageCount = snapshot?.messages?.length ?? 0;
  useEffect(() => {
    if (messageCount > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messageCount]);

  const handleSend = useCallback(async () => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    setInput("");
    try {
      await services.zcodeTaskService.sendPrompt({
        taskId,
        traceId: makeTraceId() as never,
        content,
        clientMode: "web-remote-replayable",
        clientLabel: "mobile",
      });
      // 发送后立即刷新（不等下一轮轮询）
      etagRef.current = undefined;
      await refresh();
    } catch (e) {
      // 发送失败时把内容还回输入框
      setInput(content);
      if (!disposedRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (!disposedRef.current) setSending(false);
    }
  }, [input, sending, services, taskId, refresh]);

  const isRunning =
    snapshot?.meta?.status === "running" || snapshot?.runtime?.activeTurnKind !== undefined;

  if (error && !snapshot) {
    return (
      <div className="flex flex-col items-center gap-2 pt-16 text-ui-sm text-foreground-subtle">
        <p>{T.error}</p>
        <p className="max-w-full text-ui-xs text-foreground-subtlest [overflow-wrap:anywhere]">
          {error}
        </p>
        <button
          type="button"
          className="rounded-lg bg-card px-4 py-2 text-ui-sm active:bg-surface-hover"
          onClick={() => void refresh()}
        >
          {T.retry}
        </button>
      </div>
    );
  }
  if (!snapshot) {
    return <div className="pt-16 text-center text-ui-sm text-foreground-subtle">{T.loading}</div>;
  }

  const messages = snapshot.messages ?? [];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* 消息列表 */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex flex-col gap-3 p-4 pb-4">
          {isRunning ? (
            <div className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
              <span className="size-2 animate-pulse rounded-full bg-brand" />
              {T.thinking}
            </div>
          ) : null}
          {messages.length === 0 ? (
            <div className="pt-8 text-center text-ui-sm text-foreground-subtle">{T.noContent}</div>
          ) : null}
          {messages.map((msg, i) => (
            <MessageBubble key={msg.id ?? i} message={msg} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* 输入区 */}
      <div className="shrink-0 border-t border-border bg-background p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        <div className="flex min-w-0 items-end gap-2">
          <textarea
            // min-w-0 必须保留：textarea 的默认 cols 宽度是内在宽度，
            // flex 项的 min-width:auto 会让它拒绝收缩，把发送按钮挤出屏幕、
            // 并在键盘弹出时撑出横向滚动条。
            className="min-h-[40px] max-h-[120px] min-w-0 flex-1 resize-none rounded-xl bg-surface px-3 py-2 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest"
            rows={1}
            value={input}
            placeholder={T.placeholder}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
          <button
            type="button"
            className={`flex size-10 shrink-0 items-center justify-center rounded-xl text-ui-base font-medium transition-colors ${
              input.trim() && !sending
                ? "bg-brand text-white active:opacity-80"
                : "bg-surface text-foreground-subtlest"
            }`}
            disabled={!input.trim() || sending}
            onClick={() => void handleSend()}
          >
            {sending ? "…" : "↑"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── 消息气泡 ── */

function MessageBubble({ message }: { message: ZCodePersistedMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      <div
        // [overflow-wrap:anywhere] 而非 break-words：后者对超长无空格串（URL、
        // 绝对路径、base64）不会断开，会直接撑破气泡宽度并带出横向滚动条。
        className={`max-w-[85%] min-w-0 whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-ui-base leading-relaxed [overflow-wrap:anywhere] ${
          isUser ? "bg-brand/15 text-foreground" : "bg-card text-foreground"
        }`}
      >
        {message.content || T.noContent}
      </div>
      {message.tools && message.tools.length > 0 ? (
        <span className="px-1 text-ui-xs text-foreground-subtlest">
          {T.toolCalls.replace("{count}", String(message.tools.length))}
        </span>
      ) : null}
      <span className="px-1 text-ui-xs text-foreground-subtlest">
        {formatTime(message.timestamp)}
      </span>
    </div>
  );
}
