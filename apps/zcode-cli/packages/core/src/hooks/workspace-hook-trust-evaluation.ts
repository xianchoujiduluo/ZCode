import type {
  CanonicalWorkspaceHookEntry,
  WorkspaceHookBundleSnapshot,
  WorkspaceHookEffectiveState,
  WorkspaceHookPolicy,
  WorkspaceHookTrustRecord,
  WorkspaceHookTrustState,
} from "@zcode/contracts";
import {
  WORKSPACE_HOOK_STATE_ADMISSION_MAP,
  workspaceHookEffectiveStateSchema,
} from "@zcode/contracts";
import type { WorkspaceHookTrustStoreStatus } from "./workspace-hook-trust-types.js";

export function evaluateWorkspaceHookEntry(input: {
  entry: CanonicalWorkspaceHookEntry;
  snapshot: WorkspaceHookBundleSnapshot;
  policy: WorkspaceHookPolicy;
  persistentRecords: ReadonlyMap<string, WorkspaceHookTrustRecord>;
  revokedKeys: ReadonlySet<string>;
  storeStatus: WorkspaceHookTrustStoreStatus;
}): WorkspaceHookEffectiveState {
  const { entry, snapshot, policy } = input;
  const key = trustKey(snapshot.workspaceIdentity, entry.hookDeclarationDigest);
  const persistent = input.persistentRecords.get(key);
  let trustState: WorkspaceHookTrustState;

  // 本地定制：去掉 Hook 的「授权/审核」环节——新建或修改后的 Hook 直接生效，
  // 不再进入 pending_trust 并要求用户去命令行（zcode hooks trust grant）或设置页审批。
  //
  // 因此这里把原本会落到 pending_trust / stale_digest（声明变了要重新信任）的情况
  // 一律视作已信任：
  //   - 作用域为「用户」→ 配置写在 ~/.zcode/cli/config.json，对所有项目生效；
  //   - 作用域为「工作区」→ 写在项目的 .zcode/config.json，仅对该项目生效。
  // 两者的生效范围仍由配置文件的加载范围决定（见 config-factory 的优先级），不受此处影响。
  //
  // 保留的硬约束（不因本改动放开）：
  //   - policy.mode === "deny"          → 依然 blocked_policy；
  //   - trust store 损坏                → 依然 blocked_untrusted；
  //   - 显式撤销（revokedKeys 命中）    → 依然 revoked。
  if (policy.mode === "deny") {
    trustState = "blocked_policy";
  } else if (input.storeStatus === "corrupt") {
    trustState = "blocked_untrusted";
  } else if (policy.mode === "allow_trusted_only") {
    trustState = persistent ? "trusted_persistent" : "blocked_policy";
  } else if (input.revokedKeys.has(key)) {
    trustState = "revoked";
  } else {
    // 含 persistent 命中、历史 stale_digest 以及从未信任过的 pending_trust，统一按已信任处理。
    trustState = "trusted_persistent";
  }

  const mapped = WORKSPACE_HOOK_STATE_ADMISSION_MAP[trustState];
  return workspaceHookEffectiveStateSchema.parse({
    reviewItemId: entry.reviewItemId,
    sourceRootEnabled: entry.sourceRootEnabled,
    declarationEnabled: entry.declarationEnabled,
    runtimeHooksEnabled: entry.runtimeHooksEnabled,
    configuredEnabled: entry.configuredEnabled,
    editable: entry.editable,
    trustState,
    admissionClass: mapped.admissionClass,
    effectiveRunnable:
      mapped.admissionClass === "admitted" && entry.configuredEnabled && policy.mode !== "deny",
    workspaceIdentity: snapshot.workspaceIdentity,
    bundleDigest: snapshot.bundleDigest,
    hookDeclarationDigest: entry.hookDeclarationDigest,
    sourcePaths: [
      snapshot.sourceFiles[entry.sourceFileIndex]?.canonicalPath ?? entry.sourceRelativePath,
    ],
    reasonCode: mapped.reasonCode,
  });
}

export function trustKey(workspaceIdentity: string, hookDeclarationDigest: string): string {
  return `${workspaceIdentity}\u0000${hookDeclarationDigest}`;
}
