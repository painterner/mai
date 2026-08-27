# Mai 跨平台部署与发布

## 目标

Mai 不在 Node 进程内部自行 daemonize，而是交付两种产品形态：

1. **Mai Desktop**：Tauri 安装包。Tauri 负责系统托盘、登录时启动、Node
   daemon/API sidecar 的启动、退出和 API 崩溃重启。
2. **Mai Server**：Docker/Compose。容器由 Docker restart policy 管理，提供完整
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

## Mai Desktop

### 用户体验

- 关闭主窗口只会隐藏到系统托盘。
- 托盘左键或 **Show Mai** 恢复窗口，**Quit Mai** 才会退出。
- GUI 中的 **Start at login** 开关通过 Tauri autostart 注册启动项。
- 后台同时运行 stdio daemon 和 `mai-api`；API 异常退出后两秒自动重启。
- `API running` 状态会显示在 GUI 顶栏。
- 安装包内包含 `mai-daemon`、`mai-api`、`mai-cli`、`mai-sandbox`，目标机器不需要
  安装 Node.js。

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

健康检查和 API 请求：

```bash
curl http://127.0.0.1:3141/health

curl -X POST http://127.0.0.1:3141/v1/chat \
  -H "Authorization: Bearer $MAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"检查项目并运行测试","stream":false}'
```

停止：`docker compose --env-file .env.docker down`。

### 为什么 Compose 增加 `SYS_ADMIN`

Docker 默认 seccomp/AppArmor 会阻止 bubblewrap 创建嵌套 namespace。Compose 因此添加
`SYS_ADMIN` capability，并对该容器关闭 Docker 外层 seccomp/AppArmor；容器本身不是
`privileged`，不挂载 Docker socket 或宿主设备，实际命令仍进入 Mai 的内层
bubblewrap + seccomp sandbox。

这是保留 Shell sandbox 功能所需的明确权衡。不要增加 Docker socket、宿主根目录或其他
敏感挂载。

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
