// 移动端工作台：独立于桌面 Root 的轻量入口。
// 三个视图（项目 → 会话列表 → 对话）由内部 state 切换，不依赖路由。
// 数据链路：/api/server-info（项目）→ WS services.zcodeTaskService（会话/快照）。
import { useCallback, useEffect, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { connectViaWebSocket } from "@zcode/client";
import { MobileConversation } from "./MobileConversation.js";

/* ───────────────────────── i18n（极简双语，不依赖 IntlProvider） ── */

const isZh = typeof navigator !== "undefined" && navigator.language.startsWith("zh");
const T = {
  title: isZh ? "ZCode 移动版" : "ZCode Mobile",
  selectProject: isZh ? "选择项目" : "Select Project",
  selectSession: isZh ? "选择会话" : "Select Session",
  loading: isZh ? "加载中…" : "Loading…",
  empty: isZh ? "暂无会话" : "No sessions",
  error: isZh ? "加载失败" : "Failed to load",
  retry: isZh ? "重试" : "Retry",
  connectFail: isZh ? "连接服务失败" : "Failed to connect",
  refresh: isZh ? "刷新" : "Refresh",
  running: isZh ? "进行中" : "Running",
};

/* ───────────────────────── 类型 ── */

interface ProjectEntry {
  path: string;
  label: string;
}

type Services = Awaited<ReturnType<typeof connectViaWebSocket>>;

type View =
  | { kind: "projectList" }
  | { kind: "sessionList"; project: ProjectEntry }
  | { kind: "conversation"; project: ProjectEntry; taskId: string };

/* ───────────────────────── 工具 ── */

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  return `${M}-${D} ${hh}:${mm}`;
}

/** URL 里带的 ?token= 需要在首个 API 请求中回传，让服务端种 cookie（HttpOnly）。 */
function tokenQuerySuffix(): string {
  if (typeof window === "undefined") return "";
  const t = new URLSearchParams(window.location.search).get("token");
  return t ? `?token=${encodeURIComponent(t)}` : "";
}

/* ───────────────────────── 主组件 ── */

/**
 * 移动端专用根样式。写在组件里而不是 index.html/styles.css：
 * `overflow-x: hidden` 与 `overscroll-behavior` 只对移动端布局有意义，
 * 加到全局会影响桌面 UI（例如依赖 body 滚动的弹层与 sticky 定位）。
 */
const MOBILE_ROOT_STYLE = `
html, body, #root {
  overflow-x: hidden;
  overscroll-behavior-x: none;
}
`;

export function MobileApp() {
  const [view, setView] = useState<View>({ kind: "projectList" });
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [services, setServices] = useState<Services | null>(null);
  const [servicesError, setServicesError] = useState<string | null>(null);

  // 注入移动端根样式（卸载时移除）
  useEffect(() => {
    const element = document.createElement("style");
    element.setAttribute("data-zcode-mobile-root", "true");
    element.textContent = MOBILE_ROOT_STYLE;
    document.head.append(element);
    return () => {
      element.remove();
    };
  }, []);

  // 获取项目列表
  useEffect(() => {
    let disposed = false;
    fetch(`/api/server-info${tokenQuerySuffix()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<{ workspaces?: Array<{ path: string; label?: string }> }>;
      })
      .then((info) => {
        if (disposed) return;
        const list = (info.workspaces ?? []).map((w) => ({
          path: w.path,
          label: w.label || w.path.split("/").pop() || w.path,
        }));
        setProjects(list);
        // 单项目时直接进入会话列表，省一步点击。
        if (list.length === 1) {
          setView({ kind: "sessionList", project: list[0]! });
        }
      })
      .catch((e: unknown) => {
        if (!disposed) setProjectsError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      disposed = true;
    };
  }, []);

  // 建立共享 WS 连接（进入 sessionList 或 conversation 时）
  useEffect(() => {
    if (view.kind === "projectList" || services) return;
    let disposed = false;
    const wsOrigin = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
    connectViaWebSocket(`${wsOrigin}/ws`)
      .then((s) => {
        if (!disposed) setServices(s);
      })
      .catch((e: unknown) => {
        if (!disposed) setServicesError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      disposed = true;
    };
  }, [view.kind, services]);

  return (
    // overflow-x-hidden：键盘弹出时 visual viewport 收缩，任何 flex 子项的内在宽度
    // 都可能把根容器撑出横向滚动条。这里做最后一道防护，配合各子项的 min-w-0 使用。
    <div className="flex h-dvh w-full flex-col overflow-x-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 pt-[max(env(safe-area-inset-top),0.75rem)]">
        {view.kind !== "projectList" ? (
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-foreground-subtle active:bg-surface-hover"
            onClick={() => {
              if (view.kind === "conversation") {
                setView({ kind: "sessionList", project: view.project });
              } else {
                setView({ kind: "projectList" });
              }
            }}
          >
            ←
          </button>
        ) : null}
        <h1 className="shrink-0 text-ui-base font-semibold">{T.title}</h1>
        <span className="ml-auto min-w-0 truncate text-ui-sm text-foreground-subtle">
          {view.kind === "projectList" ? "" : view.project.label}
        </span>
      </header>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {view.kind === "projectList" ? (
          <ProjectListView
            projects={projects}
            error={projectsError}
            onSelect={(p) => setView({ kind: "sessionList", project: p })}
          />
        ) : null}
        {view.kind === "sessionList" ? (
          <SessionListView
            key={view.project.path}
            project={view.project}
            services={services}
            servicesError={servicesError}
            onOpenTask={(taskId) =>
              setView({ kind: "conversation", project: view.project, taskId })
            }
          />
        ) : null}
        {view.kind === "conversation" && services ? (
          <MobileConversation
            key={view.taskId}
            services={services}
            projectPath={view.project.path}
            taskId={view.taskId}
          />
        ) : null}
        {view.kind === "conversation" && !services ? (
          <div className="pt-16 text-center text-ui-sm text-foreground-subtle">{T.loading}</div>
        ) : null}
      </main>
    </div>
  );
}

/* ───────────────────────── 项目列表 ── */

function ProjectListView({
  projects,
  error,
  onSelect,
}: {
  projects: ProjectEntry[];
  error: string | null;
  onSelect: (p: ProjectEntry) => void;
}) {
  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 pt-20 text-ui-sm text-foreground-subtle">
        <p>{T.error}</p>
        <p className="max-w-full text-ui-xs text-foreground-subtlest [overflow-wrap:anywhere]">
          {error}
        </p>
      </div>
    );
  }
  if (projects.length === 0) {
    return <div className="pt-20 text-center text-ui-sm text-foreground-subtle">{T.loading}</div>;
  }
  return (
    <ul className="flex flex-col gap-2 p-4">
      {projects.map((p) => (
        <li key={p.path}>
          <button
            type="button"
            className="flex w-full flex-col gap-1 rounded-xl bg-card p-4 text-left active:bg-surface-hover"
            onClick={() => onSelect(p)}
          >
            <span className="text-ui-base font-medium">{p.label}</span>
            <span className="truncate text-ui-xs text-foreground-subtle">{p.path}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ───────────────────────── 会话列表 ── */

function SessionListView({
  project,
  services,
  servicesError,
  onOpenTask,
}: {
  project: ProjectEntry;
  services: Services | null;
  servicesError: string | null;
  onOpenTask: (taskId: string) => void;
}) {
  const [tasks, setTasks] = useState<ZCodeTaskMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!services) return;
    let disposed = false;
    setTasks(null);
    setError(null);
    services.zcodeTaskService
      .listTasks({ workspacePath: project.path })
      .then((list) => {
        if (disposed) return;
        const sorted = [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        setTasks(sorted);
      })
      .catch((e: unknown) => {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      disposed = true;
    };
  }, [services, project.path, reloadTick]);

  const statusLabel = useCallback((status: string | undefined) => {
    if (status === "running" || status === "busy") return T.running;
    return undefined;
  }, []);

  if (servicesError) {
    return (
      <div className="flex flex-col items-center gap-2 pt-16 text-ui-sm text-foreground-subtle">
        <p>{T.connectFail}</p>
        <p className="max-w-full text-ui-xs text-foreground-subtlest [overflow-wrap:anywhere]">
          {servicesError}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto">
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-ui-sm text-foreground-subtle">{T.selectSession}</span>
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-ui-sm text-foreground-subtle active:bg-surface-hover"
          onClick={() => setReloadTick((n) => n + 1)}
        >
          {T.refresh}
        </button>
      </div>
      {error ? (
        <div className="flex flex-col items-center gap-2 pt-8 text-ui-sm text-foreground-subtle">
          <p>{T.error}</p>
          <button
            type="button"
            className="rounded-lg bg-card px-4 py-2 text-ui-sm active:bg-surface-hover"
            onClick={() => setReloadTick((n) => n + 1)}
          >
            {T.retry}
          </button>
        </div>
      ) : null}
      {!error && tasks === null ? (
        <div className="pt-8 text-center text-ui-sm text-foreground-subtle">{T.loading}</div>
      ) : null}
      {tasks && tasks.length === 0 ? (
        <div className="pt-8 text-center text-ui-sm text-foreground-subtle">{T.empty}</div>
      ) : null}
      {tasks && tasks.length > 0 ? (
        <ul className="flex flex-col gap-2 px-4 pb-4">
          {tasks.map((t) => (
            <li key={t.taskId}>
              <button
                type="button"
                className="flex w-full flex-col gap-1 rounded-xl bg-card p-4 text-left active:bg-surface-hover"
                onClick={() => onOpenTask(t.taskId)}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
                    {t.title || t.taskId}
                  </span>
                  {statusLabel(t.status) ? (
                    <span className="shrink-0 rounded-full bg-interaction-confirmation-surface px-2 py-0.5 text-ui-xs text-interaction-confirmation-foreground">
                      {statusLabel(t.status)}
                    </span>
                  ) : null}
                </div>
                <span className="text-ui-xs text-foreground-subtle">
                  {formatTime(t.updatedAt ?? t.createdAt ?? 0)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
