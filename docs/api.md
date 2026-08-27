# Mai HTTP API

Mai HTTP API 把 CLI 和 GUI 使用的同一套 agent loop、provider、skills、文件工具及
Rust sandbox 通过 HTTP 暴露出来。API 是无状态的：服务端不会保存会话，请求方在后续
调用中传回上一次响应的 `history`，因此多个客户端可以安全并发使用，不会共享上下文。

## 启动

开发模式：

```bash
npm run api:dev
```

构建后启动：

```bash
npm run build
npm run api
```

默认地址是 `http://127.0.0.1:3141`。如果通过 npm 全局安装，也可以运行
`mai-api`。服务使用启动进程的当前目录作为 agent workspace。

至少需要为当前 provider 配置对应的模型 API Key。例如：

```bash
API_PROVIDER=openai OPENAI_API_KEY=... npm run api:dev
```

## 服务配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MAI_API_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `MAI_API_PORT` | `3141` | HTTP 监听端口；`0` 表示由系统分配 |
| `MAI_API_KEY` | 空 | `/v1/*` 的 Bearer Token；监听非本机地址时必填 |
| `MAI_API_ALLOW_WRITE` | `false` | 是否向模型提供 `write_file`/`replace_in_file` |
| `MAI_API_ALLOW_SHELL` | `false` | 是否向模型提供 `run_command`；同时受 `MAI_ALLOW_SHELL` 控制 |
| `MAI_API_APPROVE_RISKY` | `false` | 是否自动批准规则引擎标为 review 的调用 |

布尔变量接受 `0`、`false`、`no`、`off` 表示关闭，其他值表示开启。

安全规则：

- 默认仅监听 loopback，默认只允许读取 workspace。
- 监听 `0.0.0.0`、局域网 IP 等非 loopback 地址时，未设置 `MAI_API_KEY` 会拒绝启动。
- 即使 `MAI_API_APPROVE_RISKY=true`，规则引擎判定为 `forbidden` 的命令仍不会执行。
- 文件工具仍有 workspace 边界和符号链接逃逸检查；Shell 仍通过 `mai-sandbox` 执行。

设置 `MAI_API_KEY` 后，请求头必须包含：

```http
Authorization: Bearer your-secret
```

`GET /health` 不要求认证，且不返回任何模型或服务 API Key。

## `GET /health`

检查服务状态和当前权限。

```bash
curl http://127.0.0.1:3141/health
```

示例响应：

```json
{
  "status": "ok",
  "service": "mai-api",
  "workspace": "/workspace/project",
  "provider": "openai",
  "model": "gpt-4.1",
  "permissions": {
    "write": false,
    "shell": false,
    "approveRisky": false
  }
}
```

## `GET /v1/providers`

列出 `providers.json` 中的 provider。`configured` 只表示对应环境变量中是否存在
API Key，不会返回 Key 本身。

```bash
curl -H 'Authorization: Bearer your-secret' \
  http://127.0.0.1:3141/v1/providers
```

示例响应：

```json
{
  "current": "openai",
  "providers": [
    {
      "name": "openai",
      "kind": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "defaultModel": "gpt-4.1",
      "configured": true
    }
  ]
}
```

## `GET /v1/models`

从 provider 的模型发现接口实时读取模型列表。省略 `provider` 时使用当前 provider。

```bash
curl -H 'Authorization: Bearer your-secret' \
  'http://127.0.0.1:3141/v1/models?provider=openai'
```

响应：

```json
{
  "provider": "openai",
  "current": "gpt-4.1",
  "models": ["gpt-4.1", "gpt-4.1-mini"]
}
```

## `POST /v1/chat`

执行一个完整 agent turn。模型可以在同一次调用中多轮调用工具，直到输出最终回复或达到
agent 的最大步骤数。

### 请求体

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `message` | string | 是 | 用户消息，不能为空，最大 100,000 字符 |
| `history` | `Content[]` | 否 | 上一次响应返回的历史；默认 `[]`，最多 200 项 |
| `provider` | string | 否 | `providers.json` 中的 provider 名称；不区分大小写 |
| `model` | string | 否 | 覆盖本次请求使用的模型，不修改 CLI 已保存的选择 |
| `stream` | boolean | 否 | `true` 返回 NDJSON 事件流；默认 `false` |

### 普通 JSON 调用

```bash
curl -X POST http://127.0.0.1:3141/v1/chat \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-secret' \
  -d '{
    "message": "概括一下这个项目的结构",
    "stream": false
  }'
```

成功响应：

```json
{
  "id": "chat_2b4e4c8d-...",
  "provider": "openai",
  "model": "gpt-4.1",
  "message": "这个项目……",
  "events": [
    {"type": "toolStart", "id": "tc1", "name": "list_files", "args": {"path": "."}},
    {"type": "toolFinished", "id": "tc1", "name": "list_files", "output": "...", "status": "done"},
    {"type": "text", "text": "这个项目……"},
    {"type": "done"}
  ],
  "history": [
    {"role": "user", "parts": [{"text": "概括一下这个项目的结构"}]},
    {"role": "model", "parts": [{"text": "这个项目……"}]}
  ]
}
```

`message` 只拼接最终回复的 `text` 事件；思考内容和工具过程保留在 `events` 中。

### 延续对话

把前一次响应中的 `history` 原样放入下一次请求：

```json
{
  "message": "再详细说明 src/agent",
  "history": [
    {"role": "user", "parts": [{"text": "概括一下这个项目的结构"}]},
    {"role": "model", "parts": [{"text": "这个项目……"}]}
  ]
}
```

`history` 使用 Mai 的 provider-neutral `Content` 格式。`parts` 支持三种结构：

```json
{"text": "文本", "thought": false}
{"functionCall": {"name": "read_file", "args": {"path": "README.md"}}}
{"functionResponse": {"name": "read_file", "response": {"result": "..."}}}
```

通常不需要自行组装工具历史，直接保存和回传服务响应即可。

### NDJSON 流式调用

```bash
curl -N -X POST http://127.0.0.1:3141/v1/chat \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-secret' \
  -d '{"message":"读取 README 并用一句话概括","stream":true}'
```

响应的 `Content-Type` 是 `application/x-ndjson`，每行都是一个完整 JSON 对象：

```jsonl
{"type":"toolStart","id":"tc1","name":"read_file","args":{"path":"README.md"}}
{"type":"toolFinished","id":"tc1","name":"read_file","output":"...","status":"done"}
{"type":"text","text":"Mai 是……"}
{"type":"done"}
{"type":"result","id":"chat_...","provider":"openai","model":"gpt-4.1","message":"Mai 是……","history":[...]}
```

最后一行固定为 `type: "result"`，包含下一次调用需要的 `history`。流式结果不重复返回
`events`，因为所有事件已经逐行发送。

### Agent 事件

| `type` | 用途 |
| --- | --- |
| `text` | 最终回复的文本增量 |
| `thought` | provider 返回的推理文本增量 |
| `toolStart` | 工具开始运行 |
| `toolApprovalNeeded` | 工具需要批准；API 根据服务端配置自动同意或拒绝 |
| `toolFinished` | 工具完成、失败或被拒绝 |
| `done` | agent turn 正常完成 |
| `error` | provider 或 agent 执行错误 |

## HTTP 状态码

| 状态码 | 说明 |
| --- | --- |
| `200` | 请求成功；流式请求开始后发生的错误通过 `error` 事件表示 |
| `400` | JSON、参数、provider、history 或 provider API Key 配置错误 |
| `401` | Bearer Token 缺失或不正确 |
| `404` | 路径不存在 |
| `413` | 请求体超过 2 MiB |
| `500` | API 内部错误 |
| `502` | 非流式调用中，底层模型/provider 返回错误 |

