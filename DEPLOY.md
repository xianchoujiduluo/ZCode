# ZCode Web + Agent 部署方案（Linux）

适用对象：在 Linux 服务器上部署 ZCode，通过浏览器访问；Agent 运行时与 Web 服务同机同包。

本文所有结论均在 Ubuntu 24.04 上实测过（见文末"验证记录"），不是推测。

---

## 一、架构与前提

### 1.1 部署形态

```
浏览器 ──HTTP/WS──> zcode-server (@zcode/services + Hono)
                        │ stdio (ZCode Protocol)
                        └──> Agent 子进程 (agent/zcode.cjs app-server --stdio)
                                  │
                                  └──> 工作区文件 / Git / 终端 / MCP
```

关键事实（源码依据）：

- Web 发行包**已经内嵌 Agent**，不需要单独部署 agent：包内结构为 `web/` + `server/` + `agent/zcode.cjs` + `agent/provider/`。
- 启动器 `bin/zcode.mjs --web` 会 spawn `node server/entry-http.js`，并注入
  `ZCODE_AGENT_SERVER_COMMAND` / `ZCODE_AGENT_SERVER_ARGS_JSON` / `ZCODE_SERVER_*`（`scripts/zcode-distribution/runner.mjs`）。
- **Agent 是懒启动的**：只有浏览器建立 WS 并真正创建会话时才 spawn（`zcodeAgentProcessManager.ts:397`「第一次 getClient 就抛…」）。空闲时只有 Web 服务进程。
- 该发行包**不自带 Node**：安装脚本硬校验 `need_cmd node curl tar`，启动器用 `exec node` 拉起。所以目标机必须预装 Node。

### 1.2 目标机要求

| 项       | 要求                                               | 说明                                                      |
| -------- | -------------------------------------------------- | --------------------------------------------------------- |
| OS       | glibc 系 Linux（Ubuntu 22.04+/Debian 12+/RHEL 9+） | 不要用 Alpine/musl，包内 `node-pty` 预编译件按 glibc 提供 |
| Node     | **≥ 24**（推荐 24.14.0，与 `mise.toml` 一致）      | 根 `package.json` 的 `engines.node >= 24`                 |
| 其他命令 | `curl`、`tar`                                      | 安装脚本硬校验                                            |
| 架构     | x86_64 或 aarch64                                  | 发行包按架构构建，交叉包未验证                            |

> 注意：不要装 Node 22。发行包里那个 `22.16.0`（`SERVER_RUNTIME_NODE_VERSION`）是远端 SSH/WSL 资源包和 `zcode-server-cli` 自升级链用的，与 Web 发行包无关。

### 1.3 内嵌能力边界

- **不带 ripgrep / bfs / ugrep**。实测解包后目录为 `agent/ bin/ node_modules/ server/ web/`，**无 `tools/`**。桌面版才有 `bundled-tools/<platform>/ripgrep`。所以 Web 模式的搜索走内置的 embedded-search（WASM）分支；若要让 agent 用系统 `rg`，需自行在目标机装 ripgrep 并确保在服务进程 PATH 中。
- 不带 Electron，因此没有内嵌浏览器、Chrome 数据导入、更新器等桌面能力（`createWebPlatform()` 里全部降级为 no-op / 拒绝）。
- 远端 SSH/WSL/Docker 工作区能力需要 `prepare:remote-assets` 产出的原生组件；若构建时设了 `ZCODE_SKIP_REMOTE_ASSETS=1`（桌面 CI 默认），该能力不可用。

---

## 二、安装

### 2.1 发布包结构（构建产物契约）

```
dist/zcode/
├── install.sh                       # 安装脚本
├── latest.json                      # {version, tarball, sha256, baseUrl}
└── releases/<version>/
    ├── zcode-<version>.tar.gz       # 运行包（实测 78MB）
    └── sha256.txt
```

> 易错点：`sha256.txt` 在 `releases/<version>/` 下，**不在** `dist/zcode/` 根。

`install.sh` 的取件逻辑是 `${BASE_URL}/latest.json` 与 `${BASE_URL}/releases/$VERSION/$TARBALL`，所以**上传时必须保持整棵目录结构**。

### 2.2 安装步骤

```sh
# 1) 上传整棵 dist/zcode 到你的下载站点，保持结构
#    例如落到 https://your.host/zcode/{install.sh,latest.json,releases/...}

# 2) 目标机安装（默认装到 ~/.zcode/runtime，命令放 ~/.local/bin/zcode）
curl -fsSL https://your.host/zcode/install.sh | sh

# 3) 确认
zcode --version
```

可覆盖的安装位置：

| 变量                  | 默认                         | 作用                                                |
| --------------------- | ---------------------------- | --------------------------------------------------- |
| `ZCODE_DIST_HOME`     | `~/.zcode/runtime`           | 运行包安装目录（`releases/<ver>` + `current` 软链） |
| `ZCODE_DIST_BIN_DIR`  | `~/.local/bin`               | `zcode` 命令所在目录                                |
| `ZCODE_DIST_BASE_URL` | 构建时写入 `install.sh` 的值 | 覆盖下载根地址                                      |

安装目录是 **release 版本化**的：`releases/<version>/` 并存，`current` 指向当前版本（`install.sh` 原子替换 `current`），所以升级/回滚只需切换软链。

---

## 三、运行

### 3.1 前台验证（先跑通再上 systemd）

```sh
zcode --web \
  --host 127.0.0.1 \
  --port 3030 \
  --workspace /srv/zcode/projects \
  --no-open
```

参数（`runner.mjs` 的 `parseArgs`）：

| 参数                         | 默认                    | 说明                                    |
| ---------------------------- | ----------------------- | --------------------------------------- |
| `--host`                     | `127.0.0.1`             | 监听地址                                |
| `--port`                     | 自动选空闲端口          | 建议显式固定                            |
| `--workspace`                | 当前目录                | Agent 的工作区；决定文件/Git 操作的落点 |
| `--no-open` / `--open`       | localhost 时 true       | 服务器上必须 `--no-open`                |
| `--token <v>` / `--no-token` | 非 localhost 时自动生成 | 访问令牌                                |

### 3.2 令牌机制（实测行为）

`--host 0.0.0.0` 会自动生成令牌并打印带 `?token=` 的地址。校验规则（`packages/server/src/http.ts`）：

| 路径                | 是否需要令牌 |
| ------------------- | ------------ |
| `/ws`、`/ws/*`      | **需要**     |
| `/api/*`            | **需要**     |
| 静态资源与 SPA 页面 | **不需要**   |

首次带 `?token=` 访问会写入 Cookie，后续请求凭 Cookie 通过：

```
Set-Cookie: zcode_lite_token=<token>; Path=/; HttpOnly; SameSite=Lax
```

> **安全含义（重要）**：内置令牌保护的是 API 与 RPC 通道，**Web 界面外壳本身是公开的**（任何人可加载页面）。因此对外暴露时**必须由反向代理再叠一层认证**，不能只靠内置令牌。内置令牌应视为第二道防线。

### 3.3 建议的目录规划

```
/srv/zcode/
├── projects/            # --workspace：Agent 干活的地方（代码仓库放这里）
└── (数据默认在 ~/.zcode)

~/.zcode/                # 数据根（ZCODE_DATA_BASE_DIR 可改）
├── runtime/             # 发行包安装位置（ZCODE_DIST_HOME）
└── .zcode/              # 应用数据
    └── v2/{certs,runtime}
```

数据目录解析优先级（`packages/services/src/paths.ts`）：

```
setDataBaseDir()  >  ZCODE_DATA_BASE_DIR  >  $HOME
```

> **ZCODE_DATA_BASE_DIR 是「基础目录」，不是「.zcode 目录」**。应用数据恒为 `{ZCODE_DATA_BASE_DIR}/.zcode/v2`。
> 因此设 `ZCODE_DATA_BASE_DIR=/home/zcode`（不要写成 `/home/zcode/.zcode`，那会得到双层 `.zcode`）。
> 实测：`ZCODE_DATA_BASE_DIR=$HOME/.zcode-webtest2` 产出 `~/.zcode-webtest2/.zcode/v2/{certs,runtime}`。

> 当用 systemd 跑时，**务必显式设置 `ZCODE_DATA_BASE_DIR`**：systemd 的 `$HOME` 取决于 `User=`，不显式指定会导致数据落到意料之外的位置。

---

## 四、systemd 常驻

### 4.1 前置：专用用户

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin zcode
sudo mkdir -p /srv/zcode/projects
sudo chown -R zcode:zcode /srv/zcode
# 需要 Git 操作时，还要给该用户配 SSH key / git 身份
```

### 4.2 unit 文件

`/etc/systemd/system/zcode-web.service`：

```ini
[Unit]
Description=ZCode Web (Web UI + Agent runtime)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=zcode
Group=zcode
WorkingDirectory=/srv/zcode/projects

# 关键：显式钉住数据基础目录，避免 systemd 的 $HOME 差异导致数据落错位置
# 注意：应用数据会落在 {该值}/.zcode/v2，不要自己再加 .zcode
Environment=ZCODE_DATA_BASE_DIR=/home/zcode
# 对外暴露时建议显式指定 token（不指定则由启动器随机生成，重启会变）
Environment=ZCODE_SERVER_AUTH_TOKEN=REPLACE_WITH_LONG_RANDOM_TOKEN
# 让 Agent 的子进程（rg / git / 语言工具链）能找到
Environment=PATH=/home/zcode/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production

ExecStart=/home/zcode/.local/bin/zcode --web --host 127.0.0.1 --port 3030 --workspace /srv/zcode/projects --no-open

Restart=on-failure
RestartSec=3
# 启动器自己处理 SIGTERM（会转发给 server 子进程后退出）
KillSignal=SIGTERM
TimeoutStopSec=20

# 资源保护（按机器规模调整）
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

要点说明：

- **`--host 127.0.0.1`**：只监听本机，外部流量一律经反向代理进入。这样能利用内置令牌做二次校验，同时避免直接暴露。
- **`Environment=ZCODE_SERVER_AUTH_TOKEN=...`**：不设的话每次重启令牌都变（`createToken()` 随机生成），用户需重新取链接；设了则稳定。注意启动器在 `--no-token` 时会**显式清空**该变量（`runner.mjs` 注释：「必须清空继承值，否则 --no-token 仍会开启后端鉴权」）。
- **`Restart=on-failure`**：supervisor 正常退出码为 0 时不重启；异常退出才拉起。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now zcode-web
sudo systemctl status zcode-web
journalctl -u zcode-web -f
```

---

## 五、反向代理（对外暴露必做）

内置令牌只护 `/ws` 与 `/api/`，静态页公开。所以反代要负责：**TLS + 认证 + WS 升级**。

### 5.1 Caddy（推荐，配置最短）

```caddyfile
zcode.example.com {
    # 基本认证兜住整个站点（含静态页）
    basicauth {
        alice $2a$14$REPLACE_WITH_BCRYPT_HASH
    }

    reverse_proxy 127.0.0.1:3030 {
        # WS 升级由 Caddy 自动处理（/ws 是 RPC 通道，必须保持长连接）
        # Agent 会话可能长时间无输出，禁用响应缓冲避免卡住
        flush_interval -1
    }
}
```

生成 bcrypt：`caddy hash-password --plaintext 'your-password'`

### 5.2 Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name zcode.example.com;

    ssl_certificate     /etc/letsencrypt/live/zcode.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/zcode.example.com/privkey.pem;

    # 站点级认证（含静态页）
    auth_basic           "ZCode";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;

        # WS 升级 —— /ws 是 WebSocket RPC 通道，缺这两行浏览器会连不上
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Agent 流式输出可能长时间静默，读超时必须放大或关闭，否则会被反代掐断
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
        proxy_buffering     off;
    }
}
```

> **部署红线**：`proxy_read_timeout` 不放大 / `proxy_buffering` 不关闭，长任务会表现为「界面卡住不动」。这是 Web 模式最常见的故障。

### 5.3 只在内网使用

可以省掉反代，直接：

```sh
zcode --web --host 0.0.0.0 --port 3030 --workspace /srv/zcode/projects --no-open
```

前提是**用防火墙限制来源**（令牌会自动开启，但仍然建议限制网段）：

```sh
sudo ufw allow from 10.0.0.0/8 to any port 3030 proto tcp
```

---

## 六、验证清单

按顺序跑，任一步失败就先解决再继续。

```sh
# 1) 服务在跑，且进程树正确（应有两层：启动器 → server）
systemctl status zcode-web
ps -eo pid,ppid,cmd | grep -E "zcode.mjs|entry-http" | grep -v grep
# 预期：node bin/zcode.mjs --web ...  →  node .../server/entry-http.js

# 2) 静态页（应 200 text/html）
curl -sS -o /dev/null -w "%{http_code} %{content_type} %{size_download}\n" http://127.0.0.1:3030/

# 3) 服务信息
curl -sS http://127.0.0.1:3030/api/server-info
# 预期含 serverId / version / workspaces[].path / capabilities

# 4) 令牌边界：无 token 访问 API 应 401
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3030/api/server-info

# 5) WS 通道（浏览器能连上的前提）
node -e '
const ws=new WebSocket("ws://127.0.0.1:3030/ws");
const t=setTimeout(()=>{console.log("FAIL: 超时");process.exit(1)},8000);
ws.onopen=()=>console.log("OK: WS OPEN");
ws.onmessage=e=>console.log("OK: 收到帧");
ws.onerror=e=>{console.log("FAIL:",e.message);process.exit(1)};
setTimeout(()=>{ws.close();process.exit(0)},4000);
'
# 注意：带 token 时用 ws://host/ws?token=... 或先让浏览器带 Cookie

# 6) 数据目录已创建（注意是 {ZCODE_DATA_BASE_DIR}/.zcode/v2）
ls -la "${ZCODE_DATA_BASE_DIR:-$HOME}/.zcode/v2/"

# 7) 端到端：浏览器打开 → 建任务 → 观察 agent 子进程被拉起
ps -eo pid,cmd | grep "app-server" | grep -v grep
```

> 第 7 步是唯一能证明「Agent 真的能干活」的验证：前 6 步通过时 Agent 还没启动（懒加载），必须真正建一个会话才会 spawn `app-server`。

---

## 七、升级与回滚

```sh
# 升级：重跑安装脚本即可（原子替换 current 软链）
curl -fsSL https://your.host/zcode/install.sh | sh
sudo systemctl restart zcode-web

# 回滚：把 current 指回旧版本后重启
ls ~/.zcode/runtime/releases/          # 查看已安装版本
ln -sfn ~/.zcode/runtime/releases/<旧版本> ~/.zcode/runtime/current
sudo systemctl restart zcode-web
```

数据在 `{ZCODE_DATA_BASE_DIR}/.zcode/v2/`（默认 `~/.zcode/v2/`），与运行包分离，升级不影响会话数据（发行说明也明确「新安装不会删除旧目录，也不会迁移或删除已有会话数据」）。

---

## 八、常见故障

| 现象                                       | 原因                                                    | 处理                                                                          |
| ------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 浏览器能打开页面，但一发消息就转圈         | WS 未建立（反代缺 `Upgrade`/`Connection`）或读超时被掐  | 检查反代 WS 配置与 `proxy_read_timeout`                                       |
| 长任务中途界面停住                         | `proxy_buffering on` 缓冲了流式响应                     | `proxy_buffering off` + `flush_interval -1`（Caddy）                          |
| `zcode install requires node`              | 目标机没装 Node 或不在 PATH                             | 装 Node ≥ 24                                                                  |
| 启动报 `SQLite is an experimental feature` | Node 24 内置 `node:sqlite` 的正常警告                   | 可忽略，不是错误                                                              |
| 重启后访问链接失效（401）                  | 未固定令牌，每次随机生成                                | 设 `ZCODE_SERVER_AUTH_TOKEN`                                                  |
| Agent 起不来 / 报 command not configured   | `ZCODE_AGENT_SERVER_COMMAND` / `ARGS_JSON` 被覆盖或清空 | 不要手动设这两个变量，交给 `bin/zcode.mjs --web` 注入                         |
| 数据落在奇怪的位置                         | systemd 的 `$HOME` 与预期不符                           | 显式设 `ZCODE_DATA_BASE_DIR`（注意它是基础目录，应用数据在 `{值}/.zcode/v2`） |
| 搜索功能弱 / 找不到 rg                     | Web 包不带 ripgrep                                      | 目标机 `apt install ripgrep` 并确认在服务 PATH 中                             |

---

## 九、验证记录（本文结论的来源）

在 Ubuntu 24.04 / Node 24.14.0 / pnpm 10.33.2 上实测：

| 项                               | 结果                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | EXIT=0，33 个 workspace projects，2m38s                                 |
| `pnpm build:zcode`               | EXIT=0，产出 78MB tarball，sha256 校验通过                              |
| 发行包目录结构                   | `agent/ bin/ node_modules/ server/ web/`（无 `tools/`）                 |
| `zcode --web` 启动               | `ZCode Web is running`，`[zcode-server:http] http://127.0.0.1:3030`     |
| 静态页 `GET /`                   | 200，`text/html`，15158 字节                                            |
| `/api/server-info`               | 200，返回 serverId / version / workspaces / capabilities                |
| 进程树                           | 启动器 → `server/entry-http.js`，**Agent 懒启动未 spawn**               |
| WS `/ws`                         | OPEN 成功并收到二进制帧                                                 |
| `--host 0.0.0.0`                 | 自动生成 token，打印 Local + 多个 Network 带 token 地址                 |
| 无 token 访问 `/api/*`           | **401**                                                                 |
| 带 `?token=`                     | **200** + `Set-Cookie: zcode_lite_token=...; HttpOnly; SameSite=Lax`    |
| 无 token 访问静态 `/`            | **200**（确认静态页不受保护）                                           |
| 带 Cookie 后续访问               | **200**                                                                 |
| 数据目录                         | `~/.zcode-webtest2/.zcode/v2/{certs,runtime}` 自动创建                  |
| Electron Linux 包（对照）        | AppImage 182M / deb 134M / rpm 112M / pkg.tar.zst 118M，`bundle EXIT=0` |
