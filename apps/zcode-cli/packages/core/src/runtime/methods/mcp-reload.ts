import {
  CoreErrorType,
  SessionEventType,
  createModelUsageSummaryFromEvents,
  registerMcpTools,
  runWithContextAsync,
  traceContextToLogContext,
} from "../deps.js";
import type {
  McpConnectionSnapshot,
  McpServerConfig,
  SessionEvent,
  TraceContext,
  TurnId,
} from "../deps.js";
import {
  appendTurnOutcomeEvent,
  createTurnFailureError,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type { TurnResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildPluginIdByServerName,
  computeOfficialCuaServerNames,
  MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
  mcpToolsSignature,
} from "./mcp.js";
import { recordTurnUsageFact } from "./usage-observability.js";

/**
 * /reload 维护命令：重读磁盘 MCP 配置并对当前会话热重载。
 * MCP 本是 runtime 启动期一次性配置（mcpInitialized/mcpToolsRegistered 单向守卫），
 * 宿主设置页在会话存活期间改写配置后，旧会话只能丢弃重建。本命令绕过该限制：
 * 通过 mcpConfigRefresher 拿最新配置 → 连接池 replace 语义重连 → diff 注销旧工具
 * → 重新注册新工具。命令经 runtime 命令队列 admission，天然等待当前 turn 结束后执行。
 */
export async function executeReloadMcpCommand(
  this: AgentRuntimeInternal,
  input: string,
  turnId: TurnId,
  turnTraceContext: TraceContext,
  abortSignal?: AbortSignal,
  inputId?: string,
): Promise<TurnResult> {
  const events: SessionEvent[] = [];
  const startedAt = Date.now();
  const activeTurn = this.beginActiveTurn(turnId, turnTraceContext, "reload", false);

  return runWithContextAsync(turnTraceContext, async () => {
    this.logger?.info("MCP reload started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "mcp.reload.started",
      inputLength: input.length,
      module: "core.runtime",
      status: "started",
    });

    await this.ensureSessionPersisted(input, turnTraceContext);

    const turnStartedEvent = this.createEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: this.turnNumber,
        input,
        inputId,
        // /reload 是维护命令，不是用户真实 query；不渲染成用户气泡。
        inputVisibility: "model-only",
      },
      turnTraceContext,
    );
    await this.appendEvent(turnStartedEvent, turnTraceContext);
    events.push(turnStartedEvent);

    try {
      throwIfTurnAborted(abortSignal);
      const response = await reloadMcpServers(this, turnTraceContext);
      throwIfTurnAborted(abortSignal);

      const turnUsage = createModelUsageSummaryFromEvents(events);
      const completeEvent = this.createEvent(
        SessionEventType.TurnComplete,
        {
          response,
          tokenCount: 0,
          usage: turnUsage,
          toolCallCount: 0,
          duration: Date.now() - startedAt,
          resultType: "success",
          cacheStats: this.messageHistory.getCacheStats(),
          inputId,
        },
        turnTraceContext,
      );
      await this.appendEvent(completeEvent, turnTraceContext);
      events.push(completeEvent);
      await recordTurnUsageFact(this, {
        completedAt: Date.now(),
        events,
        startedAt,
        status: "completed",
        traceContext: turnTraceContext,
        turnId,
      });

      this.turnNumber++;
      const projection = await this.rebuildProjection();
      this.logger?.info("MCP reload completed", {
        ...traceContextToLogContext(turnTraceContext),
        durationMs: Date.now() - startedAt,
        event: "mcp.reload.completed",
        module: "core.runtime",
        status: "completed",
      });

      return {
        response,
        turnId,
        traceId: turnTraceContext.traceId,
        usage: turnUsage,
        events,
        projection,
      };
    } catch (error) {
      const coreError = createTurnFailureError(error, abortSignal, "MCP reload failed");
      await appendTurnOutcomeEvent(this, {
        coreError,
        events,
        durationMs: Date.now() - startedAt,
        turnPhase: "reload",
        inputId,
        traceContext: turnTraceContext,
        fallbackMessage: "MCP reload failed",
        logEvent: "mcp.reload.failed",
        logLabel: "McpReload",
      });
      await recordTurnUsageFact(this, {
        completedAt: Date.now(),
        error: coreError,
        events,
        startedAt,
        status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
        traceContext: turnTraceContext,
        turnId,
      });

      throw coreError;
    }
  }).finally(() => {
    this.finishActiveTurn(activeTurn);
  });
}

async function reloadMcpServers(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<string> {
  const mcpPort = runtime.mcpPort;
  if (!mcpPort) {
    return "MCP is not available in this session; nothing to reload.";
  }
  if (runtime.config.mcp?.enabled === false) {
    return "MCP is disabled for this session; nothing to reload.";
  }

  // 1. 通过宿主注入的 refresher 重读磁盘配置；未注入（如子代理 runtime）时退回当前快照重连。
  let nextMcp = runtime.config.mcp;
  try {
    const refreshed = await runtime.mcpConfigRefresher?.();
    if (refreshed) nextMcp = refreshed;
  } catch (error) {
    runtime.logger?.warn("MCP config refresh failed; falling back to session snapshot", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.reload.refresh_failed",
      module: "core.runtime",
    });
  }
  const servers: Record<string, McpServerConfig> = nextMcp?.servers ?? {};

  // 2. replace 语义重连：不在新配置里的 server 被断开，enabled:false 由连接层跳过。
  let snapshot: McpConnectionSnapshot;
  try {
    snapshot = await mcpPort.connectConfiguredServers(servers, {
      oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
      revalidate: true,
      trace: traceContext,
      workingDirectory: runtime.workingDirectory,
      workspaceIdentity: runtime.config.workspaceIdentity?.toString(),
    });
  } catch (error) {
    // 单个 server 连接失败不能让整个 reload 报错；收敛到当前运行态快照继续注册可用工具。
    runtime.logger?.warn("MCP reload connect failed; recovering from partial snapshot", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.reload.connect_failed",
      module: "core.runtime",
    });
    const statuses = await mcpPort.status().catch(() => ({}));
    const tools = await mcpPort.listTools().catch(() => []);
    snapshot = { statuses, tools };
  }

  // 3. diff 注销被移除 server 的旧工具，再按新快照重新注册（同名覆盖）。
  // 与 initializeMcp/refreshMcpToolsIfChanged 相同的注册面：插件 UI 归属也随 reload 重建。
  const registered = registerMcpTools(runtime.registry, mcpPort, snapshot.tools, {
    allowedTools: runtime.config.toolAllowlist,
    disallowedTools: runtime.config.toolDisallowlist,
    officialCuaServerNames: computeOfficialCuaServerNames(
      servers,
      new Set(nextMcp?.trustedOfficialCuaServerNames ?? []),
    ),
    pluginIdByServerName: buildPluginIdByServerName(runtime.config.pluginReferenceCatalog),
  });
  // 上游以 string[] + 签名 + revision 记录注册事实；reload 后同步三者，
  // 避免回合边界 refreshMcpToolsIfChanged 用旧签名误判再刷一次。
  const previousNames = new Set(runtime.registeredMcpToolNames ?? []);
  const nextNames = new Set(registered);
  let removedCount = 0;
  for (const name of previousNames) {
    if (!nextNames.has(name)) {
      runtime.registry.unregister(name);
      removedCount++;
    }
  }
  runtime.registeredMcpToolNames = registered;
  runtime.mcpToolsSignature = mcpToolsSignature(snapshot.tools);
  runtime.mcpToolListRevision = mcpPort.toolListRevision?.();
  if (previousNames.size > 0 || nextNames.size > 0) {
    runtime.invalidateToolCache();
  }

  // 4. 同步 runtime 内存快照：后续状态查询与冷恢复看到的是重载后的配置，
  //    与 mcpInitialized=true 的事实保持一致（不回退到旧 server 集合）。
  runtime.config.mcp = {
    ...runtime.config.mcp,
    ...nextMcp,
    servers,
  };
  runtime.mcpStartupPromise = Promise.resolve(snapshot);

  return formatMcpReloadSummary(snapshot, nextNames.size, removedCount);
}

function formatMcpReloadSummary(
  snapshot: McpConnectionSnapshot,
  registeredToolCount: number,
  removedToolCount: number,
): string {
  const statuses = Object.entries(snapshot.statuses);
  if (statuses.length === 0) {
    return `No MCP servers configured. Tools registered: ${registeredToolCount} (-${removedToolCount}).`;
  }
  const lines = statuses.map(([name, status]) => {
    const detail =
      status.status === "failed" && status.error ? ` (${status.error})` : "";
    return `- ${name}: ${status.status}${detail}, ${status.toolCount} tools`;
  });
  const counts = statuses.reduce<Record<string, number>>((acc, [, status]) => {
    acc[status.status] = (acc[status.status] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  return [
    `MCP servers reloaded: ${summary}.`,
    ...lines,
    `Tools registered: ${registeredToolCount} (-${removedToolCount} removed).`,
  ].join("\n");
}
