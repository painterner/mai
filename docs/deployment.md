# Mai 跨平台部署与发布

## 目标

Mai 不在 Node 进程内部自行 daemonize。开发和交付共有三种运行方式，其中后两种是面向
测试者的产品形态：

1. **Mai Local**：通过 `npm link` 暴露 `mai`/`mai-api`，供源码开发和本机调试。
2. **Mai Desktop**：Tauri 安装包。Tauri 负责系统托盘、登录时启动、Node
   daemon/API sidecar 的启动、退出和 API 崩溃重启。
3. **Mai Server**：Docker/Compose。容器由 Docker restart policy 管理，提供完整
   workspace 写入与 bubblewrap/seccomp Shell 能力。

这样无需分别维护 systemd、launchd 和 Windows Service 安装脚本。真正要求“无人登录即
启动”的服务器场景统一交给 Docker；个人电脑使用 Tauri 的跨平台登录启动。

## 源码布局

本地构建脚本默认三个工程是同级目录：

```text
workspace/
├── mai-cli-node/
├── mai-cli-gui/
└── mail-cli-rust/
```

- `mai-cli-node`：CLI、stdio daemon、HTTP API 和 sidecar 打包脚本。
- `mai-cli-gui`：Tauri 桌面宿主和安装包。
- `mail-cli-rust`：`mai-sandbox`，Linux 下实际执行 Shell 的安全边界。

## 三种运行方式的区别

无论客户端来自本机还是网络，都遵循同一个原则：**API、agent 和 sandbox 在同一个执行
节点运行，workspace 由这个节点直接访问**。外部 API 客户端只负责发送任务和接收事件；
请求不会自动转发给另一台电脑上的 Desktop 或 sandbox。

| 运行方式 | 入口 | Agent/API 在哪里 | Sandbox 在哪里 | Workspace 在哪里 | 主要用途 |
| --- | --- | --- | --- | --- | --- |
| Mai Local | `mai`、`mai-api` | 本机 Node.js 进程 | 本机 `mai-sandbox` 可执行文件 | 启动命令时的当前目录 | 源码开发、调试 |
| Mai Desktop | Tauri GUI/托盘 | 本机安装包 sidecar | 本机安装包 sidecar；当前完整实现仅支持 Linux | `MAI_WORKSPACE`、已记忆目录或启动目录 | 发给普通测试者 |
| Mai Server | Docker Compose/OCI 镜像 | Docker 容器内 | 同一个容器内，位于 Docker 外层隔离之内 | 宿主目录 bind mount 到 `/workspace` | 服务器、NAS、无人值守测试 |

三种方式可以同时存在，但它们是彼此独立的 Mai 实例，各自拥有进程、会话和 workspace。
一次请求命中哪个 API，工具和命令就在哪个 API 所属的执行节点运行。

### Mai Local：源码开发模式

```text
终端 mai / mai-api
        ↓
本机 mai-cli-node
        ↓
本机 mail-cli-rust/target/.../mai-sandbox
        ↓
本机当前工作目录
```

`mai-cli-node` 查找的不是 Rust 动态库，而是独立的 `mai-sandbox` 可执行程序，并通过
stdin/stdout JSON 协议调用它。查找顺序是：

1. `MAI_SANDBOX_BIN`；
2. 同级 `mail-cli-rust/target/release/mai-sandbox`；
3. 同级 `mail-cli-rust/target/debug/mai-sandbox`；
4. `PATH` 中的 `mai-sandbox`。

典型构建和链接方式：

```bash
cd mail-cli-rust
cargo build --release --bin mai-sandbox

cd ../mai-cli-node
npm install
npm run build
npm link
```

完成后，`mai` 启动 CLI，`mai-api` 启动同一 agent 内核的 HTTP 服务。CLI 输入 `/gui`
时会查找同级 `mai-cli-gui/src-tauri/target/{release,debug}/mai-gui`，写入 conversation
handoff 后退出 CLI 并启动 GUI；GUI 的 **Switch to CLI** 会保存同一 handoff、打开系统
终端并恢复 CLI 会话。这条双向切换链路是发布升级时必须保留的回归测试。

### Mai Desktop：本机安装模式

```text
本机 Tauri GUI
  ├── mai-daemon sidecar
  ├── mai-api sidecar
  ├── mai-cli sidecar
  └── mai-sandbox sidecar（Linux Shell 后端）
        ↓
     本机 workspace
```

Desktop 不依赖 Docker。安装包在用户电脑上启动 API 和 agent，所以通过 Desktop API
发起的远程请求也会在这台用户电脑上执行。构建配置会携带 `mai-sandbox` sidecar，但
当前 bubblewrap/seccomp 后端是 Linux 专用：Linux Desktop 可以执行完整 sandbox
Shell，macOS/Windows 在原生后端完成前不能把它降级成不受保护的宿主 Shell。

### Mai Server：容器部署模式

```text
外部客户端
    ↓ HTTP
Docker 容器中的 mai-api
    ↓
同一容器中的 mai-sandbox（bubblewrap + seccomp）
    ↓
/workspace（宿主 MAI_WORKSPACE 的 bind mount）
```

Docker 不是去调用 Desktop 的 sandbox，而是在镜像中包含并运行另一份相同的
`mai-sandbox`。这里有两层边界：外层是 Docker 容器，内层是 Mai 的
bubblewrap/seccomp sandbox。命令在容器内执行，文件修改通过 `/workspace` 挂载写回
宿主目录，所以重新创建容器后仍然可以读取修改后的内容。

如果外部调用的是 Docker API，执行发生在 Docker 主机；如果调用的是 Desktop API，
执行发生在 Desktop 所在电脑。未来即使让 Windows/macOS Desktop 选择 Docker 作为
Shell 后端，也应明确显示当前执行节点，不能把两种模式混成一个隐式行为。

## Mai Desktop

### 用户体验

- 关闭主窗口只会隐藏到系统托盘。
- 托盘左键或 **Show Mai** 恢复窗口，**Quit Mai** 才会退出。
- GUI 中的 **Start at login** 开关通过 Tauri autostart 注册启动项。
- 后台同时运行 stdio daemon 和 `mai-api`；API 异常退出后两秒自动重启。
- Session、Run、事件和终端 scrollback 写入 workspace 的 `.mai/api.sqlite`；API 重启后
  可继续查询已完成记录和按序号回放事件。
- `API running` 状态会显示在 GUI 顶栏。
- 安装包构建配置包含 `mai-daemon`、`mai-api`、`mai-cli`、`mai-sandbox`，目标机器不需要
  安装 Node.js；当前 `mai-sandbox` 完整 Shell 后端仅在 Linux 生效。

默认 API 地址是 `http://127.0.0.1:3141`。可通过环境变量覆盖：

```bash
MAI_API_HOST=127.0.0.1
MAI_API_PORT=3141
MAI_API_KEY=long-random-token
```

Desktop API 默认开启写文件和 Shell 工具。需要自动批准规则引擎标记为 review 的命令时，
再显式设置 `MAI_API_APPROVE_RISKY=true`。规则引擎判定为 `forbidden` 的命令无法绕过。

### Workspace

Desktop 按以下顺序选择 workspace：

1. `MAI_WORKSPACE` 环境变量；
2. 首次运行时记住的工作目录；
3. 当前工作目录。

记忆文件位于 Tauri 的平台应用配置目录。测试指定工程时可这样启动：

```bash
MAI_WORKSPACE=/absolute/path/to/project npm run tauri dev
```

### 本地生成安装包

安装三个工程依赖后，在 GUI 工程运行：

```bash
cd mai-cli-node && npm ci
cd ../mai-cli-gui && npm ci
cd ../mai-cli-gui && npm run bundle
```

`npm run bundle` 会依次：

1. 构建 `mail-cli-rust` 的 `mai-sandbox`；
2. 使用 `@yao-pkg/pkg` 把三个 Node 入口打成独立可执行文件；
3. 复制所有目标 sidecar 到 Tauri 的 `src-tauri/binaries`；
4. 执行 `tauri build` 生成当前平台安装包。

交叉目标可用 `npm run bundle -- --target aarch64-apple-darwin`。实际发布建议在对应平台
runner 上原生构建。生成的 sidecar 是构建产物，不提交仓库。

### 自动发布

`mai-cli-gui/.github/workflows/release.yml` 构建 Linux x64、Windows x64、macOS
Apple Silicon 和 macOS Intel。GUI GitHub 仓库需要设置：

| Repository variable | 内容 |
| --- | --- |
| `MAI_NODE_REPOSITORY` | `owner/mai-cli-node` |
| `MAI_RUST_REPOSITORY` | `owner/mail-cli-rust` |

私有仓库还需设置 `MAI_SOURCE_TOKEN` secret。推送 `v*` tag 或手动运行 workflow 后，
Tauri Action 会创建 draft prerelease 并上传安装包。公开发布还应配置 Apple
签名/notarization 与 Windows 代码签名。

官方能力参考：[安装包](https://v2.tauri.app/distribute/)、
[sidecar](https://v2.tauri.app/develop/sidecar/)、
[Autostart](https://v2.tauri.app/plugin/autostart/)、
[GitHub Actions](https://v2.tauri.app/distribute/pipelines/github/)。

## Mai Server：完整功能 Docker

Docker 版没有关闭 Shell，也不是只读模式。Compose 明确启用：

```text
MAI_API_ALLOW_WRITE=true
MAI_API_ALLOW_SHELL=true
MAI_API_APPROVE_RISKY=true
MAI_ALLOW_SHELL=true
```

模型可以读写 workspace、在 `mai-sandbox` 中执行命令、执行规则引擎允许或标记为
review 的命令，并使用镜像内的 Node/npm、Rust/Cargo、Git 和 ripgrep 工具链。
永久 forbidden 的命令仍会被规则引擎拒绝。

API 是持久 Agent Gateway，不只是 `/v1/chat`：容器可以管理 Session/Run、SSE 事件、
skills/tools、直接文件读取以及交互式 sandbox PTY。数据库默认位于
`/workspace/.mai/api.sqlite`，因此与文件修改一起通过 bind mount 持久化。Compose 默认
`MAI_API_APPROVE_RISKY=true` 以适合无人值守测试；要由远程客户端逐项审批，改为 `false`
并调用 `/v1/runs/{id}/approval`。

Shell 内部仍使用 bubblewrap namespaces、只读容器根目录、仅 `/workspace` 和 `/tmp`
可写、Mai seccomp BPF 过滤器以及无网络命令环境。

### 启动

```bash
cd mai-cli-node
cp .env.docker.example .env.docker
```

编辑 `.env.docker`，至少设置：

```bash
MAI_API_KEY=long-random-token
MAI_WORKSPACE=/absolute/path/to/test/project
API_PROVIDER=openai
OPENAI_API_KEY=provider-key
```

启动并查看日志：

```bash
docker compose --env-file .env.docker up -d --build
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs -f mai-api
```

健康检查和持久 Run 请求：

```bash
curl http://127.0.0.1:3141/health

SESSION_ID=$(curl -s -X POST http://127.0.0.1:3141/v1/sessions \
  -H "Authorization: Bearer $MAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | jq -r .id)

curl -X POST "http://127.0.0.1:3141/v1/sessions/$SESSION_ID/runs" \
  -H "Authorization: Bearer $MAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"检查项目并运行测试"}'
```

停止：`docker compose --env-file .env.docker down`。

### Docker 权限为什么这样设置

Docker 默认 seccomp/AppArmor 会阻止 bubblewrap 创建嵌套 user/PID/network namespace，
所以 Compose 只对 Mai 容器关闭这两层 Docker 策略。Mai 进程仍以 uid 1000 运行，容器
没有 `SYS_ADMIN` capability，也不是 `privileged`，不挂载 Docker socket 或宿主设备；
实际命令仍进入 Mai 的内层 bubblewrap + seccomp sandbox。

部分内核不允许在容器中再次挂载 procfs。镜像设置
`MAI_SANDBOX_PROC_MODE=bind`，让内层 sandbox 只读复用已经受 Docker 边界限制的
`/proc`，不因此提升容器权限。不要增加 Docker socket、宿主根目录或其他敏感挂载。

### 网络暴露

Compose 默认只发布到宿主 `127.0.0.1`，并强制设置 `MAI_API_KEY`。不要直接把 3141
端口暴露到公网。远程测试应放在 HTTPS reverse proxy 或可信 VPN 后面，并增加限流与
独立测试者 Token。

### 容器自动发布

`mai-cli-node/.github/workflows/container.yml` 使用 Buildx 构建 `linux/amd64` 和
`linux/arm64` 并发布到 GHCR。Node 仓库需设置 `MAI_RUST_REPOSITORY`；私有 Rust
仓库还需要 `MAI_SOURCE_TOKEN`。

## 平台功能边界

| 能力 | Linux Desktop | macOS Desktop | Windows Desktop | Docker |
| --- | --- | --- | --- | --- |
| GUI/托盘/Autostart | 是 | 是 | 是 | 不适用 |
| HTTP API | 是 | 是 | 是 | 是 |
| 文件读写 | 是 | 是 | 是 | 是 |
| sandbox Shell | 是 | 暂不可用 | 暂不可用 | 是 |
| 安装包自动构建 | 是 | 是 | 是 | OCI 镜像 |

macOS/Windows 的 Shell 不会降级到不安全的宿主 Shell；在对应 sandbox 后端实现前会失败
关闭。Docker 运行 Linux 环境，所以保留完整 Shell sandbox。

## 发布策略总结

- 普通测试者下载 Mai Desktop，不安装 Node、Rust 或服务管理器。
- 开发团队和服务器使用 Mai Server 容器。
- 平台差异集中在 Tauri/CI，不维护三套手工服务脚本。
- 真正的系统启动服务只在企业无人值守场景按需增加，不作为默认交付方式。
