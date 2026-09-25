## 核心原则

- 新增或修改行为前，先更新对应 spec；目录不存在时按需创建。先明确产品规则、状态所有者、接口和验收场景，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。该脚本默认执行 `git fetch`，离线时加 `--no-fetch`；落后远端会直接以非零码退出。Node 版本以 `mise.toml` 为准（Node 24.14.0 / pnpm 10.33.2）。

以下命令从仓库根目录执行：

| 用途             | 命令                                    |
| ---------------- | --------------------------------------- |
| 初始化           | `pnpm bootstrap`                        |
| 类型检查         | `pnpm typecheck`                        |
| Lint             | `pnpm lint` / `pnpm lint:fix`           |
| 格式化           | `pnpm fmt` / `pnpm fmt:check`           |
| 桌面开发         | `pnpm dev:desktop`                      |
| Web 开发         | `pnpm dev:web`                          |
| 桌面打包         | `pnpm bundle:desktop`                   |
| 提交前检查       | `pnpm verify:pre-push`                  |
| 架构检查         | `pnpm architecture:check --changed`     |
| 架构报告 / 基线  | `pnpm architecture:report`              |
| 模块阅读包       | `pnpm architecture:context <module-id>` |
| 依赖图           | `pnpm dep:graph`                        |
| 未使用依赖与导出 | `pnpm knip`                             |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`   |

- `pnpm dev:desktop` 等价 `dev:desktop:prod`（生产服务配置）；连测试环境用 `pnpm dev:desktop:test`。
- `pnpm verify:pre-push` = `pnpm lint` + `pnpm architecture:check --changed`。
- `pnpm bundle:desktop` 需带平台参数，如 `pnpm bundle:desktop -- --os linux --arch x64`。

### 工具链覆盖范围（易踩坑）

- 根 `pnpm typecheck` 用 `tsc -b` 且**显式列举**了 project references：`packages/model-option-map`、`packages/formal-proof`、`packages/zcode-cua` 与 `apps/zcode-cli` 都不在其中；改这些目录后根检查通过不代表已通过类型检查。
- 根 `pnpm lint`（oxlint）的 `ignorePatterns` 排除了 `apps/zcode-cli`、`packages/formal-proof`、`packages/ui/src/components/ui`、`packages/ui/src/components/ai-elements`、`.agents/skills`。
- `apps/zcode-cli` 是嵌套 workspace，自带 turbo 工具链：`pnpm --dir apps/zcode-cli typecheck`、`lint`、`format`、`check`（含 `registry:check`）。根目录 `pnpm install` 已覆盖它（约 33 个项目），不要在内层重复安装。
- 仓库当前**没有配置任何测试运行器**：全仓仅 `packages/services/test/`、`packages/ui/test/` 下 4 个测试文件，各包 `package.json` 无 `test` 脚本，也没有 vitest / playwright 配置。新增测试前先确认运行方式，不要假定存在统一的单测或 E2E 命令。
- 未安装 Git hooks（无 `.husky/`，`core.hooksPath` 未设置），`pnpm verify:pre-push` 需手动执行。
- `pnpm bundle:desktop` 内部串联 `prepare:runtime-assets → build → electron-builder → 产物校验`，不要绕过它直接调 electron-builder。

### 目录职责

- `packages/desktop`：Electron main、host、renderer。
- `packages/web`、`packages/server`：Web 客户端与服务端。
- `packages/zcode-server-cli`：独立 Server 启动与进程管理。
- `packages/ui`：共享 React 组件、hooks 与 Zustand store。
- `packages/services`：业务服务；`packages/rpc`：RPC 框架。
- `packages/shared`：共享协议与类型；`packages/client`：Agent 客户端 SDK。
- `packages/provider`、`packages/provider-node`：Provider 公共能力与 Node 侧实现。
- `packages/model-option-map`：模型选项映射的 tokenizer、compiler 与 evaluator。
- `packages/zcode-cua`：Computer Use 占位包，当前发行版不含该能力，运行时入口统一报告 unavailable 并 fail closed。
- `packages/formal-proof`：产品行为状态空间枚举器，本地 Vite 页面。
- `apps/zcode-cli`：Agent CLI 与运行时；`apps/zcode-cli/packages/*` 为其内部包（`cli` 入口、`core`、`tui`、`adapters`、`contracts` 等），CLI 专项规则见 `apps/zcode-cli/AGENTS.md`。
- `CONTEXT.md`：插件商店领域词汇；修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范；修改 UI 前阅读。
- `DEPLOY.md`：Web + Agent 发行包的 Linux 部署与运维（安装、systemd、反向代理、验证清单）。
- `config/README.md`：内置默认配置（`config/default.json` 随客户端发布，必须保留）与帮助入口的来源规则。
- `README.md`：开发与打包命令的完整说明；`harness/remote/` 为远程（SSH/WSL/Docker）构建脚手架。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 边界规则来自 `architecture-policy.yaml`：单文件 ≤ 400 行（`max-lines` 也是 oxlint error 级规则）、contract 文件 ≤ 300 行、单模块公开方法 ≤ 12、禁止循环依赖与深层导入。注意 `global.managedOnly: true`：当前只有 `storage` 模块（`packages/services/src/storage`，含 `contract.ts` 公开入口）标记 `managed: true`，其边界规则会被强制检查；其余模块是 legacy 基线（`.architecture-baseline.json` 为空），不报错但不应照抄其中的越界模式。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 有行为改动时先补充对应测试；交互改动需要 E2E 场景。检查测试与实现是否一致，并实际执行可用的验证。未执行或环境受限时如实说明（当前仓库没有统一测试运行器，见上文「工具链覆盖范围」）。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。

## UI 与平台边界

- 遵守 `DESIGN.md`，复用已有组件，兼顾桌面与手机 Web 的布局、交互、主题和国际化。
- 组件通过 `packages/ui/src/hooks/` 访问服务；平台操作通过 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调用 `window.zcode`。
- 通过依赖注入处理 Desktop、Web、本地和远程环境的差异，并兼顾 Windows、macOS 和 Linux。
- Zustand 状态位于 `packages/ui/src/store/`。广播同步的主题、语言等字段需要防止回环；UI 局部状态不应被误当作服务端事实。
- hooks 中含 JSX 的文件使用 `.tsx`。

## 进程、协议与远程控制

- Desktop app 通过 stdio 与 Agent 通信。协议改动同步更新 `packages/shared/src/zcode-protocol/index.ts`，提供严格类型与运行时校验。
- Main 负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态。
- 每个窗口使用一个 window-scoped Local Host；本地 workspace 共享该 Host。远程 workspace 由窗口内的连接注册表管理，不另建 Desktop Remote Host。
- 手机远控连接桌面已有 Host attachment，复用会话运行时；不为手机另起 Agent、Local Host 或远程会话。
- Desktop 的 `desktop-continuous` 实时链路与手机的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，不保存任务队列、快照等业务状态。
- 已接受的 busy/running 输入由 CLI/runtime `CommandInbox` 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
- 保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

- UI 使用 `packages/ui/src/logger.ts`，不直接使用 `console.log` 或 `window.zcode?.log`。
- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`（`packages/services/src/logger/serviceLogger.ts`）。
- `debug` 用于协议原始数据、流式 chunk 和逐条工具更新等高频诊断，生产环境不落盘。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。
