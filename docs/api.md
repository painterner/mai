# Mai Agent Gateway API

Mai API 暴露的不是普通模型聊天，而是 CLI/GUI 使用的同一套 agent runtime：模型、系统
提示、skills、文件工具、Shell 工具和 `mai-sandbox`。新客户端应使用持久化
Session/Run API；旧 `/v1/chat` 继续兼容。

## 启动

```bash
npm run build
npm link

MAI_API_ALLOW_WRITE=true \
MAI_API_ALLOW_SHELL=true \
MAI_API_KEY=long-random-token \
mai-api
```

默认监听 `http://127.0.0.1:3141`，workspace 是启动 `mai-api` 时的当前目录。除
`/health` 外，设置 `MAI_API_KEY` 后所有 `/v1/*` 请求都需要：

```http
Authorization: Bearer long-random-token
```

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MAI_API_HOST` | `127.0.0.1` | 监听地址；非 loopback 时必须设置 API Key |
| `MAI_API_PORT` | `3141` | 监听端口，`0` 表示随机端口 |
| `MAI_API_KEY` | 空 | `/v1/*` Bearer Token |
| `MAI_API_STATE` | `<workspace>/.mai/api.sqlite` | Session、Run、事件和终端 scrollback SQLite 文件 |
| `MAI_API_ALLOW_WRITE` | `false` | 开放 agent 和文件 API 写入 |
| `MAI_API_ALLOW_SHELL` | `false` | 开放 `run_command` 和交互终端 |
| `MAI_API_APPROVE_RISKY` | `false` | `true` 自动批准 review；`false` 等待审批接口 |
| `MAI_ALLOW_SHELL` | `true` | CLI/API 共用的 Shell 总开关 |

SQLite 保存会话历史、运行状态和全部事件。文件内容直接保存在 workspace；Docker 模式
通过 `/workspace` bind mount 写回宿主目录。

## 推荐调用流程

```text
POST /v1/sessions
        ↓ session_id
POST /v1/sessions/{session_id}/runs
        ↓ run_id（立即返回 202）
GET  /v1/runs/{run_id}/events
        ↓ SSE：模型文本、工具、审批、完成事件
POST /v1/runs/{run_id}/approval   （需要时）
POST /v1/runs/{run_id}/steer      （需要时）
POST /v1/runs/{run_id}/stop       （需要时）
```

### 1. 创建会话

```bash
curl -X POST http://127.0.0.1:3141/v1/sessions \
  -H "Authorization: Bearer $MAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"title":"检查工程","provider":"openai","model":"gpt-5.6-sol"}'
```

返回：

```json
{
  "id": "sess_...",
  "title": "检查工程",
  "provider": "openai",
  "model": "gpt-5.6-sol",
  "history": [],
  "createdAt": "2026-08-27T...Z",
  "updatedAt": "2026-08-27T...Z"
}
```

### 2. 创建后台 Run

```bash
curl -X POST http://127.0.0.1:3141/v1/sessions/$SESSION_ID/runs \
  -H "Authorization: Bearer $MAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"input":"检查项目、修改问题并运行测试"}'
```

服务器立即返回 `202`。同一个 Session 同时只允许一个活动 Run；不同 Session 可以并发。

### 3. 订阅事件

```bash
curl -N http://127.0.0.1:3141/v1/runs/$RUN_ID/events \
  -H "Authorization: Bearer $MAI_API_KEY"
```

事件使用标准 SSE：

```text
id: 1
event: run.started
data: {"sessionId":"sess_...","provider":"openai","model":"gpt-5.6-sol","seq":1}

id: 2
event: agent.toolStart
data: {"id":"tc1","name":"read_file","args":{"path":"README.md"},"seq":2}

id: 3
event: agent.toolFinished
data: {"id":"tc1","name":"read_file","output":"...","status":"done","seq":3}

id: 4
event: run.completed
data: {"message":"完成……","seq":4}
```

事件先写 SQLite 再发送。断线后使用下面任意一种方式续传：

```http
Last-Event-ID: 3
```

或：

```text
GET /v1/runs/{id}/events?after=3
```

### 4. 审批、steer 和停止

`MAI_API_APPROVE_RISKY=false` 时，review 级工具会令 Run 进入
`waiting_approval`，并产生 `run.waiting_approval` 事件：

```bash
curl -X POST http://127.0.0.1:3141/v1/runs/$RUN_ID/approval \
  -H "Authorization: Bearer $MAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"approved":true}'
```

在下一个工具边界追加指导：

```bash
curl -X POST http://127.0.0.1:3141/v1/runs/$RUN_ID/steer \
  -H "Authorization: Bearer $MAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"message":"不要改配置文件，先补测试"}'
```

停止模型请求、等待中的审批或正在运行的 sandbox 命令：

```bash
curl -X POST http://127.0.0.1:3141/v1/runs/$RUN_ID/stop \
  -H "Authorization: Bearer $MAI_API_KEY"
```

## Session 与 Run 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/v1/sessions` | 分页列出会话，支持 `limit`/`offset` |
| `POST` | `/v1/sessions` | 创建会话 |
| `GET` | `/v1/sessions/{id}` | 会话元数据和完整 provider-neutral history |
| `PATCH` | `/v1/sessions/{id}` | 修改 title/provider/model |
| `DELETE` | `/v1/sessions/{id}` | 删除会话、Run 和事件 |
| `GET` | `/v1/sessions/{id}/messages` | 获取最新持久化模型/工具历史 |
| `GET` | `/v1/sessions/{id}/runs` | 列出会话的 Run |
| `POST` | `/v1/sessions/{id}/runs` | 创建异步 Run |
| `GET` | `/v1/runs/{id}` | 查询状态、回复或错误 |
| `GET` | `/v1/runs/{id}/events` | 可恢复 SSE 事件流 |
| `POST` | `/v1/runs/{id}/approval` | 批准或拒绝待审工具 |
| `POST` | `/v1/runs/{id}/steer` | 排队中途指导 |
| `POST` | `/v1/runs/{id}/stop` | 中止 Run |

Run 状态：`queued`、`running`、`waiting_approval`、`completed`、`failed`、
`cancelled`。API 异常重启时，未完成 Run 会在 SQLite 中标记为 `failed`，已完成会话和事件
不丢失。

同一个 Session 可以在模型仍在处理时继续 `POST .../runs`。新 Run 会按提交顺序保持
`queued`，当前 Run 结束（包括失败或被中止）后逐个启动，并读取前一 Run 完成后保存的最新
会话历史。不同 Session 的 Run 仍可并行执行。对尚未启动的 Run 调用 `/stop` 会直接将其
标记为 `cancelled` 并从队列移除。

## Skills、Tools 与文件

```text
GET /v1/capabilities
GET /v1/providers
GET /v1/models?provider=openai
GET /v1/tools
GET /v1/skills
GET /v1/skills/{name}
```

`/v1/tools` 返回当前权限下实际向模型提供的 function declarations。Skills 在每个 Run
开始时重新扫描，因此新增或修改 workspace skill 不需要重启 API。

列目录和读取文件：

```bash
curl 'http://127.0.0.1:3141/v1/files?path=src' \
  -H "Authorization: Bearer $MAI_API_KEY"

curl 'http://127.0.0.1:3141/v1/files/content?path=src/api.ts' \
  -H "Authorization: Bearer $MAI_API_KEY"
```

写入 UTF-8 或 base64 文件：

```bash
curl -X PUT http://127.0.0.1:3141/v1/files \
  -H "Authorization: Bearer $MAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"path":"generated/result.txt","encoding":"utf8","content":"done\n"}'
```

所有路径必须是 workspace 相对路径，真实路径和符号链接不能逃出 workspace。直接文件接口
单文件限制为 10 MiB。

## 交互式 Sandbox Terminal

交互终端不是宿主 Shell。`mai-api` 启动同一个 `mai-sandbox --terminal`，在 Linux
bubblewrap/seccomp、无网络、workspace-only 写入边界内分配 PTY。

创建终端：

```bash
curl -X POST http://127.0.0.1:3141/v1/terminals \
  -H "Authorization: Bearer $MAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"command":"exec bash -i","cols":120,"rows":40}'
```

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/v1/terminals` | 创建 sandbox PTY |
| `GET` | `/v1/terminals/{id}` | 查询终端状态和 exit code |
| `GET` | `/v1/terminals/{id}/events` | 可恢复 SSE 输出/退出事件 |
| `POST` | `/v1/terminals/{id}/input` | 写 stdin，支持 `utf8`/`base64` |
| `POST` | `/v1/terminals/{id}/resize` | 修改 rows/cols |
| `POST` | `/v1/terminals/{id}/signal` | `INT`、`TERM`、`KILL` |
| `DELETE` | `/v1/terminals/{id}` | 关闭终端 |

输入：

```json
{"data":"npm test\n","encoding":"utf8"}
```

终端输出是任意字节，所以 `terminal.output` 事件使用 base64：

```text
event: terminal.output
data: {"data":"bm9kZSAtdg0K","encoding":"base64","seq":2}
```

终端 metadata 和输出事件保存在 SQLite，断线后可以回放；活动进程本身不能跨 API 进程
重启恢复，重启后会标记为 `failed`。

## 兼容 `/v1/chat`

`POST /v1/chat` 仍执行完整 agent turn，支持原 JSON 和 NDJSON 格式：

```json
{
  "message": "读取 README 并运行测试",
  "history": [],
  "provider": "openai",
  "model": "gpt-5.6-sol",
  "stream": true
}
```

该接口仍由调用方回传 `history`，也不能在断线后恢复审批或进度。新集成应使用
Session/Run API。

## HTTP 状态码

| 状态码 | 说明 |
| --- | --- |
| `200/201/202/204` | 成功、创建、后台 Run 已接受、删除成功 |
| `400` | JSON、参数、provider 或路径错误 |
| `401` | Bearer Token 错误 |
| `403` | 写入或 Shell 功能未开启 |
| `404` | Session、Run、Terminal、Skill 或文件不存在 |
| `409` | Session 已有活动 Run，或目标不在可操作状态 |
| `413` | 请求体或直接文件超过限制 |
| `501` | 当前平台没有交互 sandbox 后端 |
| `500` | 内部错误 |
