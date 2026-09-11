# Research: Phase 9 W9 — Sender 功能区（附件 / 权限模式 / 模型选择 / 思考级别）

> Status: **research complete 2026-09-11**, implementation NOT started. Feeds the
> W8 design doc's "Deferred" table (`docs/design/phase-9-w8-sender.md`) — the
> four composer controls that each need a wire arm first. This doc is the
> empirical ground truth + the proposed wire plan; the design doc for the
> implementation wave should be written against it.

Sources verified (all local / pinned):

| Source | Version | Where |
|---|---|---|
| `@agentclientprotocol/claude-agent-acp` (CC wrapper) | **0.76.0** | rig machine npx cache (our shipped default) |
| `@zed-industries/codex-acp` | **0.16.0** | npm tarball + GitHub `main` source |
| dsh ACP adapter | **0.1.2-rc.1** | `~/acp-ref/dsh/packages/acp/acp/src/` (official monorepo checkout = rig version) |
| `@agentclientprotocol/sdk` schema | wrapper 0.76's bundled SDK | npx cache `dist/schema/types.gen.d.ts` |
| portal reference (UI logic) | snapshot 2026-09-10 | `~/acp-ref/portal/src/components/{ChatInput,SessionConfigBar}.tsx` + `hooks/useAcpConnection.ts` |

## TL;DR

- **模式 / 模型 / 思考级别不需要发明任何协议** — ACP 标准已有整套
  "session modes & configuration"：`session/new|load|resume` 响应携带
  `modes` + `configOptions`，切换走 `session/set_mode` /
  `session/set_config_option`，变更推 `current_mode_update` /
  `config_option_update`。**三个在用适配器（claude wrapper 0.76、codex-acp
  0.16、dsh 0.1.2-rc.1）全部实现**（dsh 无 set_mode —— 无权限模式概念）。
  我们缺的只是把这条链路接到自己的 wire 上。
- **附件分两类**：图片是 ACP 一等公民（`{type:'image', data, mimeType}`
  base64 内联块，三适配器都收），文件引用走 `resource_link`（**我们的
  `promptBlockSchema` 已经有这个 variant 且 daemon 原样转发 —— 纯 UI 缺
  口**）。音频/嵌入式 blob 资源三适配器都忽略，不做。
- 建议实现顺序：**A. session-config 选择器（mode/model/effort）→ B. 图片
  附件 → C. 文件引用（@ mention + workspace picker）**，各自独立可发。

---

## 1. ACP 标准面：session modes & configuration

SDK `types.gen.d.ts`（协议文档 agentclientprotocol.com/protocol/session-modes）：

```ts
// 建立响应（session/new | load | resume 都带，均可空）
modes?: { currentModeId: string; availableModes: { id, name, description?, _meta? }[] }
configOptions?: SessionConfigOption[]

SessionConfigOption = {
  id: string                      // 'mode' | 'model' | 'effort' | 'reasoning_effort' | …
  name: string                    // 展示名
  description?: string
  category?: 'mode' | 'model' | 'model_config' | 'thought_level' | (string)
  type: 'select' | 'boolean'
  currentValue?: string           // select 的当前值（OPAQUE）
  options?: { value, name, description?, group?, _meta? }[]   // group = 分组（dsh 按 provider）
  _meta?: …
}

// 切换（客户端 → agent 的普通 JSON-RPC 请求）
'session/set_mode'          { sessionId, modeId }
'session/set_config_option' { sessionId, configId, value }    // select: string；boolean: boolean

// 推送（session/update 的一种）
{ sessionUpdate: 'current_mode_update', currentModeId }
{ sessionUpdate: 'config_option_update', configOptions: SessionConfigOption[] }
```

要点：

- **option 的 `value` 是 OPAQUE 字符串**。dsh 的 model value 是
  `JSON.stringify([provider, model])` —— 客户端只做相等比较展示，**绝不能
  解析或自拼**。
- 权限卡**不能**切模式：`PermissionOptionKind` 只有
  `allow_once|allow_always|reject_once|reject_always`，响应只回 `optionId`
  （wrapper 内部的 `updatedPermissions` 是 Claude SDK 内部事，不上 ACP 线）。
  我们 `acpPermissionOptionSchema` 的四种 kind 是对的，不用动。
- `initialize` 响应的 `agentCapabilities.promptCapabilities.{image,audio,
  embeddedContext}` 是**客户端判断附件按钮可不可用的依据**。

## 2. 适配器支持矩阵

| 能力 | claude wrapper 0.76.0 | codex-acp 0.16.0 | dsh-acp 0.1.2-rc.1 |
|---|---|---|---|
| `modes` + `set_mode` | ✅ `default`(Manual)/`acceptEdits`/`plan`/`auto`（+`bypassPermissions` 仅当非 root 或 `IS_SANDBOX`；`dontAsk` 可解析但不进列表） | ✅ `read-only`/`auto`/`full-access`（approval+sandbox preset；untrusted 项目显示 read-only 以便信任升级） | ❌ **无**（权限模式不上 ACP） |
| mode 也作为 configOption | ✅ id=`mode` | ✅ id=`mode`（名 "Approval Preset"） | ❌ |
| model 选择 | ✅ id=`model`，来自 SDK model infos（含 context hint 归一化） | ✅ id=`model`，来自 models_manager presets（`show_in_picker` 过滤） | ✅ id=`model`，**provider 分组**（`group` 字段），value=JSON `[provider,model]` |
| 思考级别 | ✅ id=`effort`，category `thought_level`，选项 = 当前模型 `supportedEffortLevels` + `default` 行；**持久化到 settings**（per-model `modelSettings`） | ✅ id=`reasoning_effort`，仅当 preset 支持 >1 档 | ✅ id=`reasoning_effort`，**按当前模型动态**（`llm.resolveModelInfo().reasoning.efforts`），`''` = Provider default |
| 切换后推送 | ✅ `config_option_update` / `current_mode_update` | ✅ | ✅（另有 topology 变化自发推送） |
| 换 model 的联动 | 重建 effort 选项；`auto` 模式在模型不支持时回落 `acceptEdits` 并提示 | — | **按 turn 钉死**：prompt 入场时 snapshot `selection`，切换只影响下一 turn |
| 图片 prompt | ✅ base64 + **http(s) URL** 两种 | ✅ base64（转 data URL） | ✅ 仅 base64，png/jpeg/webp/gif，**canonical base64 严格校验**且要求当前路由支持图片（否则 invalid_params） |
| `promptCapabilities` | `{image:true, embeddedContext:true}` 静态 | `{image:true, embeddedContext:true}` 静态 | `{image: 动态}`（按 provider+model 探测）+ `audio:false` |
| resource_link（文件引用） | → `[@name](uri)` 文本链接（agent 自己用 Read 工具取） | → `[@name](uri)` 文本 | → `[resource_link name=… uri=…]` 文本标记（**最弱**：不会自动读） |
| resource(text) 嵌入 | ✅ `<context ref=…>` 注入 | ✅ 同 | ❌ 不收 |
| 音频 / resource(blob) | 忽略 | 忽略 | 拒绝/忽略 |

模式语义备忘（UI 文案用）：

- claude：`default`="Manual"（总要询问）、`acceptEdits`（自动接受文件编辑）、
  `plan`（先出计划）、`auto`（Claude 自己决定权限）、`bypassPermissions`
  （全放行，root 下默认不出现 —— **数据驱动渲染即可，我们不用自己挡**）。
- codex：`read-only` / `auto`（workspace 沙箱）/ `full-access`
  （`:danger-no-sandbox`）。
- 危险方向（auto/full-access/bypass）建议 confirm-first（W8 设计里已有此
  结论：削弱门禁近似破坏性操作）。

## 3. portal 参考的实现模式（claude 有、附件没有 —— 与用户判断一致）

`SessionConfigBar.tsx` + `useAcpConnection.ts`：

- 数据从 session/new/load/resume/fork **响应**读 `modes` + `configOptions`；
  三个 select 按 `category` 定位（`model` / `thought_level` / `mode`），
  mode 项缺失时回退用 `modes.availableModes` 构造。
- 切换 = 发 `session/set_config_option` / `session/set_mode`，**乐观更新本地
  state**，agent 的响应/推送再确认或纠正（`config_option_update` 全量替换
  options、`current_mode_update` 只改 currentModeId）。
- effort 有个 trick：**会话建立时检测并一次性切到 max**（Anthropic 不持久化
  max，响应总是 "default"）。⚠️ **不抄** —— 这是该产品的偏好，不是通用行
  为；我们展示真实值即可。
- @ 文件引用是 `FileMentionPopover`（固定定位浮层 + 光标触发），发送的是
  resource_link；**没有图片/上传附件 UI**（所以参考项目无附件逻辑）。

## 4. 我们侧的现状与缺口

已具备（比预想多）：

- `promptBlockSchema`（shared/realtime.ts）已含 `text` + `resource_link` 两
  variant；daemon `runPrompt` 把 blocks **原样**发给 `session/prompt` ——
  文件引用今天端到端就是通的，只缺 UI。
- socket.io `maxHttpBufferSize` 已是 8MB（`SOCKET_MAX_HTTP_BUFFER`）——
  base64 图片放得下（单图 ≤4MB 原图 ≈5.4MB base64）。
- 权限卡 optionId 逐字透传 + 四种 kind —— 与现行协议一致，无需动。

缺口（按层）：

| 层 | 现状 | 需要 |
|---|---|---|
| shared | `promptBlockSchema` 无 `image` variant；`chatStreamEventSchema` 无 config 类事件；ready schema 无 caps | +image 块（带尺寸上限）；+`session_config` 事件（modes+configOptions 全量快照，last-wins）；+`chat:config.set` 请求（mode/option 二合一或两个）；ready +`promptCapabilities` |
| daemon | session/new/load/resume 响应只读 `sessionId`；`mapAcpUpdate` 对 `current_mode_update`/`config_option_update` 落到 `raw`；initialize 不捕获 promptCapabilities | 捕获 modes/configOptions → ready 事件带上 + 发一条 `session_config` 流事件（进 history ring，resync 免费回放）；两个 update 映射为 `session_config`（合并后全量推）；`chat:config.set` → `conn.request('session/set_mode'/'session/set_config_option')`；initialize 捕获 `agentCapabilities.promptCapabilities` |
| server | 无对应 /app handler；`onStream` 校验白名单需要新事件 kind | `/app` `chat:config.set`（校验 + 转发 /ctl，owner 门禁同其它 chat handler）；新事件 kind 放行 |
| web | fold 的 user 行是**纯文本**（`{row:'user', text}`，resource_link 折成 `[name]`）；composer 无附件/选择器控件 | fold user 行改 blocks 模型（文本 + 图片缩略图 chip + 文件 chip）；composer `+` 菜单（图片上传/文件引用）+ mode/model/effort 三个 select（数据驱动，idle 时才可切） |

## 5. 方案（建议的 W9 切分）

### A. session-config 选择器（mode / model / effort）

wire（一次加齐）：

1. shared：`sessionModeStateSchema` / `sessionConfigOptionSchema`（镜像 ACP
   形状，尺寸上限：≤32 options、字符串 ≤256 等）；`chatStreamEventSchema` 加
   `{kind:'session_config', modes?, configOptions?}`；浏览器→server
   `chat:config.set {sessionId, modeId?} | {sessionId, configId, value}`；
   `chatSessionReadyEventSchema` 加 `promptCapabilities`（后续 B 用）。
2. daemon：establish 响应读取 modes/configOptions（new/load/resume 三臂）→
   ready + `session_config` 事件（**push 进 history ring**，resync/刷新即恢
   复选择器状态）；`current_mode_update`/`config_option_update` → 合并出全量
   `session_config`；`chat:config.set` handler → 转发 ACP 请求（错误走 ack）。
3. server：`/app` handler 校验转发（owner-only，同 message.send 的门禁形
   状）；`onStream` 放行新 kind。
4. web：fold state + `config`（last-wins）；composer 工具栏左侧三个小 select
   （或 chip+popover）：
   - **数据驱动渲染**：`category==='mode'`（或 modes 回退）→ 权限 chip；
     `category==='model'` → 模型；`category==='thought_level'` → 思考级别。
     没有 就不渲染（dsh 无 mode chip；effort 依模型动态出现）。
   - 选项名/描述直接用 agent 给的（英文原样，符合 i18n 规则里
     wire-value-英文 的例外 —— mode/model id 是协议值；也可加 id→本地化
     label 映射表作增强）。
   - value 当 OPAQUE key 用；dsh 的分组用 `<Select group>` 或分组 label。
   - **turnActive 时禁用**（dsh 按 turn 钉 selection；也避开 busy 竞态），
     乐观更新 + `session_config` 推送纠正（portal 同款）。
   - 危险模式（id ∈ {bypassPermissions, full-access, auto}）confirm-first。
   - 与 W3 RuntimeConfig 的关系：**正交可组合** —— W3 是机器级默认（落
     settings/config.toml/settings.yaml），会话内切换只影响本 channel 的后
     续 turn；新会话仍从机器默认出发。resume 的会话 currentValue 反映其钉
     死的模型（W7 的 stale-model 标注逻辑不受影响）。

工作量估计：shared+daemon+server ~1 天（含测试），web ~1 天。

### B. 图片附件

1. shared：`promptBlockSchema` + `{type:'image', data: base64(≤6MB),
   mimeType: enum(png/jpeg/webp/gif)}`；`chatMessageSendRequestSchema` 的
   总载荷上限校验（≤6MB/turn，≤4 图）。
2. daemon：runPrompt 已原样转发 —— 仅需 schema 放行；dsh 拒绝时
   invalid_params 文案透传给 ack。
3. web：
   - composer `+` 菜单 → 图片上传（file input accept 四种 mime）+ **粘贴**
     + 拖拽（截图流的主路径是粘贴）。
   - **客户端先行压缩/限边**（canvas 长边 ≤1568px、质量 0.85 重编码）——
     把 wire 控制在数百 KB，而不是指望 8MB 缓冲；服务端仍设硬上限兜底。
   - draft 状态加附件 chips（缩略图 + 移除）；fold user 行改 blocks 模型渲染
     缩略图（点击放大用现有 lightbox 模式或新 Dialog）。
   - 可用性门禁：ready 的 `promptCapabilities.image === true` 才启用 `+` 图
     片项（dsh 动态、可能为 false —— UI 如实禁用并提示）。
4. 历史回放：user blocks 已进 history ring —— 图片以 base64 回放会吃内存
   （ring ≤2000 项）；dsh 的 transcript 历史不含用户图片（dsh 落盘自己的
   attachment 词汇），claude 的 load 重放 `user_message_chunk` 也只回文本块
   —— **可接受**：历史里图片位置显示占位 chip 即可，不追求回放原图。

### C. 文件引用（@ mention）

- wire 已通（resource_link 原样到 agent）。纯 UI：`@` 触发 popover，数据源
  复用 W6 的 `workspace:list`（daemon 已有、按 cwd 一层懒加载 —— dir-picker
  同款）；选中插入 `{type:'resource_link', name: basename, uri: file://<abs>}`。
- 渲染：用户行/流里的 resource_link 显示 `[@name]` mono chip（fold 现有
  `[${b.name}]` 文本折法升级为 chip）。
- 预期管理：claude/codex 会把链接交给 agent 自己读（效果最好）；dsh 只是文
  本标记 —— 文档里写明。

### 不做 / 以后再说

- 音频附件、resource(blob) 上传（三适配器全忽略）。
- 嵌入式 text resource 上传（只有 claude/codex 收，dsh 拒绝 —— 等有需求再
  论，走 C 的 @ 引用已够）。
- codex `dontAsk`、claude wrapper 的 `providers/list|set|disable`（client
  托管 LLM 路由 —— 未来可替代 W3 的 settings 写入，另立课题）。
- portal 的 effort 自动 max trick（产品偏好，不通用）。

## 6. 风险与开放问题

- **dsh model 值的 OPAQUE 性**：任何想"显示 provider/model 分列"的冲动都
  要克制 —— 用 option 的 `group`/`name` 展示，value 只做 key。
- **ring 内存**：config 事件全量快照（model 列表 ~几十项）每次变化整包推
  —— 频率低（用户切换/模型拓扑变化），可接受；若 dsh 频繁推再加去抖。
- **权限模式与 C6**：mode 是会话内削弱门禁的开关；机器级"允许的最低模式"
  策略留给 C6 权限策略工作（参考 bridge 的 policy-engine 形状）。
- **图片大小上限**与 `SOCKET_MAX_HTTP_BUFFER`（8MB）联动：文档里写清
  "单 turn 总量 ≤6MB"的由来（base64 膨胀 1.35x + 余量）。
- claude wrapper 的 model display 归一化（context hint `[1m]` 后缀等）——
  我们只展示 `name`，不碰 value，天然规避。
