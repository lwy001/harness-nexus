# Harness Nexus

[English](README.md) | 简体中文

> 面向编码代理的自托管控制平面——MCP 服务器、技能、钩子、子代理、规则与配置集，
> 集中管理、部署到你自己的机器，并通过 ACP 远程对话。

**⚠️ 早期阶段。** Harness Nexus 尚处于活跃开发期：功能、API 与线上协议可能随时变更，
路线图中仍有未完成的部分（见[项目状态](#项目状态)），文档偶尔滞后于代码。目前它已经
可以支撑下文描述的工作流——但请预期各种毛边，暂不要把不可替代的数据放入其中。

## 它能做什么

控制平面 / 数据平面分离：服务端 + Web UI 管理一切，而每台机器上的轻量客户端
（`hnx`）负责本地执行。

- **MCP，一次接入** — 注册上游 MCP 服务器（凭据静态加密存储）；工具按配置集聚合到
  每个配置集一个端点之后。你机器上的代理以本地 stdio MCP shim（`hnx mcp serve`）
  的方式消费它们。
- **资源与配置集** — 带版本的技能 / 钩子 / 子代理 / 规则 / MCP 定义，按目标打包为
  配置集，一次作业即可部署到某台机器。支持的宿主：**Claude Code、Codex、DeepSeek
  Harness (dsh)**——更多目标在路线图上。
- **机器与部署** — 用 `hnx enroll` 注册机器，其守护进程通过 WSS 保持连接；扫描机器
  上已安装的内容、与配置集做对比、一键导回平台、以可重放的作业部署配置集。
- **与已部署的代理对话** — 在浏览器中通过 ACP 与代理实例对话（流式回复、工具调用、
  权限请求），执行发生在你自己的机器上，按机器逐一开启，默认关闭。
- **从第一天起就支持多用户** — JWT + 个人访问令牌、全局 vs. 个人资源、管理员/普通
  用户两种角色。

## 项目状态

| 领域                             | 状态                         |
| -------------------------------- | ---------------------------- |
| 认证、用户、角色、PAT            | ✅ 已完成                    |
| MCP 连接、凭据、代理转发         | ✅ 已完成                    |
| 资源与配置集编辑器（Web）        | ✅ 已完成                    |
| 技能中心（浏览/保存/多源搜索）   | ✅ 已完成                    |
| Claude Code 市场发射器           | ✅ 已完成                    |
| `hnx` 安装/卸载（本地）          | ✅ 已完成（codex、deepseek） |
| 机器、守护进程、MCP shim         | ✅ 已完成                    |
| 清单 / 对比 / 导入               | ✅ 已完成                    |
| 远程部署作业                     | ✅ 已完成                    |
| ACP 聊天                         | ✅ 已完成                    |
| Web UI 界面语言（英/中）         | ✅ 已完成                    |
| 编排（多代理）                   | 🧪 未设计                    |
| 其余导入适配器（ECC/Superpower） | 🧪 计划中                    |

详细计划见 [`docs/roadmap.md`](docs/roadmap.md)；每个阶段都有配套的 PRD + 设计文档，
索引在 [`docs/README.md`](docs/README.md)。

## 技术栈

Node.js ≥20 · TypeScript (strict) · Fastify · React + Vite · pnpm workspaces ·
SQLite（默认，可插拔存储） · 官方 MCP SDK · Socket.IO · zod。

## 仓库结构

```
packages/
  core/          领域实体 + 仓储端口（纯 TS，无 I/O）
  shared/        zod 模式 + 工具函数——线上形状的唯一事实源
  server/        Fastify API + MCP 注册表/代理 + realtime + 存储驱动
  mcp-runtime/   UpstreamPool——服务端代理与 stdio shim 共用
  sdk-ts/        HTTP 客户端 SDK
  cli/           `hnx`——注册/守护进程/安装/MCP 服务
apps/
  web/           React 管理界面（Signal 设计系统，界面语言：英文/简体中文）
docs/            PRD、设计、调研、路线图、ADR
```

## 快速开始（开发）

```bash
pnpm install            # 安装 workspace 依赖

# 必需：用于签发访问令牌的 JWT 密钥（≥16 字符）
export JWT_SECRET="$(openssl rand -base64 48)"

# 可选：无数据库文件的临时运行
export STORAGE_DRIVER=memory

task dev                # 以 watch 模式启动全部（需要 task: https://taskfile.dev）
# 或者不用 task：
pnpm dev:server         # API 监听 :8080
pnpm dev:web            # Web UI 监听 :5173
```

第一个注册的用户成为管理员。在 Web UI（`/admin/users`、`/admin/settings`）中管理
用户与注册开关。界面默认跟随浏览器语言，可通过页头按钮切换英文/简体中文。

## Docker

`docker compose up --build` 以两个容器启动整个栈：

- **`server`** — Fastify API + MCP 代理 + realtime 通道（多阶段构建镜像，来自根目录
  `Dockerfile`）。SQLite 持久化到 `/data` 卷。不对外发布——仅 `web` 可达。
- **`web`** — nginx 提供构建后的 SPA（`apps/web/Dockerfile`），并把 `/api`、`/mcp`、
  `/socket.io`（WebSocket）反向代理到 `server`。唯一对外暴露的端口。

```bash
# 1. 配置（复制并填写必需的 JWT_SECRET）
cp .env.example .env
# 编辑 .env: JWT_SECRET="$(openssl rand -base64 48)"

# 2. 构建并启动
docker compose up --build -d

# 3. 打开界面（默认仅绑定 localhost——见 docker-compose.yml 中的 ports:）
open http://127.0.0.1:15922
```

默认 Web 端口只绑定 `127.0.0.1`。若要对外暴露，请修改 `docker-compose.yml` 中的
`ports:` 并在前置 TLS（Caddy/nginx 之类的反向代理）——API 通过请求头传递令牌，因此在
开放到 localhost 之外之前请务必使用 HTTPS。

两个镜像完全从国内镜像源构建（apt 用 TUNA，npm 用 npmmirror），构建无需代理；若想改用
官方源，删除各 Dockerfile 构建阶段中的镜像源 `RUN`/`ENV` 行即可。`JWT_SECRET`
（≥16 字符）在运行时必需，且不会烧入任何镜像。

## 接入一台机器

在你想管理的机器上（可以是同一台主机）：

```bash
# 一次性安装客户端（需要 Node.js ≥ 20）
npm install -g @harness-nexus/cli

# 在 Web UI：机器 → 注册——会显示一次性令牌 + 机器 id
hnx daemon --server https://your-instance --token <machine-token> --machine-id <machine-id>
```

守护进程上报在线状态，向你的代理工具提供本地 stdio MCP shim，执行部署作业，并承载
ACP 聊天子进程。远程聊天默认按机器关闭——在机器页面开启（它会在该机器上运行工具，
仅所有者可用）。

## 安全须知

本产品存储并服务机密（上游凭据）。值得了解的设计选择：凭据密钥以 AES-256-GCM 静态
加密且永不完整返回；令牌（PAT、机器注册）只显示一次；机器令牌只进入 realtime 通道，
不进入 REST API；远程聊天按机器选择加入、仅所有者可用、有会话审计记录；机器清单上传
前会先脱敏 env/header 值。请把实例（及其 `JWT_SECRET`）当作其连接的一切的 root 对待。

## 文档

[`docs/README.md`](docs/README.md) 索引了全部文档：架构
（[`docs/architecture.md`](docs/architecture.md)）、各阶段 PRD/设计、调研笔记与 ADR。

## 许可证

[MIT](LICENSE)
