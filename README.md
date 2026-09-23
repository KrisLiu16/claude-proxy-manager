# CPM

CPM 在**当前 Linux 开发机**创建一个持久的隔离工作区。它在新容器中运行 Claude、Codex 或普通开发命令，通过本机 sidecar 把网络请求送到指定 SOCKS5 代理。配置、检查、镜像构建和运行都在这台机器完成；没有 SSH 分发步骤。

## 安装与首次使用

在开发机上运行：

```bash
curl -fsSL https://raw.githubusercontent.com/KrisLiu16/claude-proxy-manager/refs/heads/main/install.sh | sh
cpm                 # 打开本机 TUI，按 e 填写代理、白名单、时区和语言
cpm setup           # 安装缺失的 Claude，准备 Docker、镜像和持久卷
cpm check           # 逐项检查；解决 FAIL 后再使用
cpm enter           # 在 /workspace 打开交互式 bash
```

安装器从 [GitHub Releases](https://github.com/KrisLiu16/claude-proxy-manager/releases) 下载当前平台的 CPM 单文件程序，校验 SHA-256，默认放到 `~/.local/bin/cpm`。`CPM_VERSION=v0.10.0` 可固定版本；`CPM_INSTALL_DIR` 可指定目录。升级时会先停止旧的宿主代理 bridge，新启动的命令会使用新版本；已经运行的容器不会被中断。独立容器目前只支持 Linux，且要求 Docker Engine、seccomp、AppArmor 和普通用户。Ubuntu/Debian 缺少 Docker 时，`cpm setup` 会尝试使用免密 sudo 安装并启动它；其他发行版需要先自行安装 Docker。

首次构建镜像会读取宿主 `/etc/os-release` 选择基础镜像，并安装 Git、Python、bubblewrap 等开发工具，可能需要几分钟。Ubuntu 和 Debian 宿主使用对应发行版与版本的基础镜像；其他发行版继续使用 Ubuntu 24.04 基础镜像，并在宿主对照中显示差异。后续同版本、同区域配置和相同 Claude 二进制会复用镜像。已有官方 Claude 二进制会直接复用；缺少时，CPM 从官方 npm 平台包下载并验证 SHA-512，再安装到本机 `~/.local/bin/claude`。Codex 首次运行时会在容器 HOME 中安装，其状态随后持久保存。首次登录 Codex 时，CPM 会启动设备码流程，由用户在自己的浏览器完成验证；隔离容器无法接收普通浏览器流程的 localhost OAuth 回调。设备码登录需要在账户或工作区中启用，详见 [OpenAI Codex 登录说明](https://learn.chatgpt.com/docs/auth)。

## TUI

运行 `cpm` 可看到一个面板：

- **配置与准备**：代理节点、白名单、时区、语言、Claude、Docker 和默认命令路由。
- **共享工作区**：显示持久卷状态，并说明哪些目录会保留、哪些会在下一条命令重置。
- **逐项检查**：可滚动查看每个检查项的结果和详细错误；失败项保留原始原因。
- **帮助**：常用命令和隔离边界。

快捷键：`e` 编辑、`s` 准备、`c` 检查、`1` 进入工作区、`2` 启动 Claude、`3` 启动 Codex、`t` 切换 `claude` 默认路由、`r` 刷新、`h` 帮助、`q` 退出。编辑页用 Tab/方向键切换字段，`Ctrl+T` 切换默认路由，`Ctrl+S` 保存，Esc 取消。已有代理时，完整代理输入框留空表示沿用原值；输入框会掩码，不在面板上展示密码。准备过程显示阶段和已用时间。

代理输入格式：

```text
HOST:PORT:USER:PASSWORD
```

白名单用逗号分隔，支持域名、IP 和 CIDR。放行整个公司域时，填写根域和子域形式，例如：

```text
naiveai-dev.com,.naiveai-dev.com,10.0.0.0/8
```

白名单匹配到的流量由宿主 sidecar 直连；云元数据地址和宿主回环地址仍被拒绝。只填写确实需要直连的公司资源。时区和语言默认 `auto`，根据**代理出口 IP** 探测；实时 API 失败会复用之前的缓存，没有缓存则停止启动。也可手动填写 `America/New_York` 和 `en_US.UTF-8`。

## 日常命令

```bash
cpm help                      # 查看完整帮助
cpm check                     # 逐项检查本机配置和出口
cpm setup                     # 重新准备或更新镜像
cpm enter                     # 交互式进入共享工作区
cpm exec -- git status        # 在 /workspace 执行一条命令
cpm exec -- git clone https://github.com/ORG/REPO.git
cpm proxy                     # 在新容器中运行 Claude
cpm proxy codex               # 在新容器中运行 Codex
cpm sandbox -- python3 -V     # 在同一工作区运行其他程序
cpm enable                    # 让新 shell 的 claude 默认进入 CPM
cpm disable                   # 关闭默认路由
```

每次启动目标命令前，CPM 会对照宿主与镜像的发行版、内核、架构、UID/GID、Node、Python、Git 和 bubblewrap，再在容器内验证直连阻断、DNS、时区、主机名、权限和实际代理出口。任何 `FAIL` 都会阻止目标程序运行；工具补丁版本差异显示为 `WARN`。`cpm proxy codex` 等非 Claude 命令不会要求 Anthropic API 连通。`cpm check` 在**当前机器**执行，不连接 SSH。

## 文件与进程生命周期

每条命令都启动一个新的临时容器。以下两个 Docker 具名卷由同一开发机用户共享，不会在命令退出时自动清除：

| 容器目录 | 用途 | 下次命令 |
|---|---|---|
| `/home/node` | CLI 登录、用户配置、npm 包、个人工具 | 保留 |
| `/workspace` | 克隆的仓库、代码、虚拟环境 | 保留 |
| `/tmp`、`/run`、只读镜像层 | 临时文件、后台进程、系统文件 | 重置 |

宿主 HOME、SSH 凭据、Docker socket 和已有宿主项目目录不会挂载进容器。请在 `/workspace` 内克隆代码。CPM 记录两个卷的身份；卷丢失、只剩一个或被重建时，会停止启动，避免把空环境当成旧工作区。主动使用 `docker volume rm` 仍会删除数据，重要仓库应自行备份。

容器采用 `--network none`、只读根文件系统、普通用户、capability 全部删除、`no-new-privileges`、seccomp 和 AppArmor。CPM 不额外设置内存、CPU、cgroup 进程数或总连接数上限，并把宿主的打开文件数、锁定内存、用户进程数和 core 文件 ulimit 传入容器。Docker 守护进程及宿主系统的限制仍会生效。`/tmp` 使用退出时删除的匿名 Docker 卷，与本机一样由磁盘容量决定；`/run` 仍是临时内存文件系统。容器通过只读 Unix socket 访问宿主 sidecar；代理凭据留在宿主 `0600` 配置文件中。应用可识别 Docker 或受同一宿主内核影响，因此 CPM **不能保证绝对安全或完全隐藏宿主特征**。直接调用宿主原生 Claude 路径也会绕过 CPM；默认 `claude` 路由只对加载了新 shell 配置的命令生效。

## 本地文件

```text
~/.local/bin/cpm
~/.local/bin/claude                    # 缺少官方 Claude 时由 cpm setup 安装
~/.config/cpm/proxy.env               # 代理凭据和白名单，权限 0600
~/.local/share/cpm/shim-bin/claude    # 可选的 claude 路由 shim
~/.local/state/cpm/geolocation.json   # 出口区域缓存
~/.local/state/cpm/sandbox-volumes.json
```

Docker 卷名为 `cpm-home-<ID>` 和 `cpm-workspace-<ID>`。`cpm setup` 不会主动删除它们。

### 与宿主机的差异

容器共用宿主 Linux 内核与 CPU 架构，采用当前用户相同的 UID/GID，并从宿主读取主要 ulimit。基础发行版按宿主选择：本机 Ubuntu 24.04 使用 Ubuntu 24.04 镜像；Node 来自固定版本的官方 Node 构建阶段，版本差异会显示在对照表里。容器用户名为 `node`，只保留主组；宿主的补充用户组、HOME、SSH 密钥、已安装工具和项目路径不会自动进入。容器主机名固定为 `cpm-dev`，只有回环网卡与受控 DNS，时区和语言按代理出口配置。CPM 只传入运行所需的代理、时区、语言、终端变量和 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`；运行 Claude 时加 `--no-chrome`。根文件系统只读；软件应安装在持久的 `/home/node` 或 `/workspace` 中。后台进程随本次命令结束。`/run` 由 Docker tmpfs 提供，默认容量可能与宿主 `/run` 不同。

Ubuntu 24.04 镜像安装了 `bubblewrap`，但当前 Docker/AppArmor 外层隔离不允许它再创建内层 user namespace。默认 `cpm proxy codex` 因此给 **Codex 内层**设置 `--sandbox danger-full-access`：Codex 能操作容器内的 HOME 和工作区，外层 CPM 的网络、文件和权限隔离仍生效。显式传入 Codex 的 `--sandbox` 参数会按用户选择执行。CPM 的对照表会分别显示 bubblewrap 是否安装和内层 user namespace 是否可用。参见 [Codex Linux 沙箱前提](https://learn.chatgpt.com/docs/sandboxing)。

这些差异是隔离边界的一部分。CPM 不设 CPU、内存或 cgroup 进程配额，但 Docker 守护进程、父 cgroup 与主机策略仍可能设置约束；可用 `docker inspect <正在运行的 cpm-run 容器>` 检查实际值。

## 给 Codex 使用的 skill

仓库提供 [CPM skill](skills/cpm/SKILL.md)，说明本机安装、检查、进入持久工作区和安全边界。可在开发机上安装到 Codex：

```bash
mkdir -p ~/.codex/skills/cpm
curl -fsSL https://raw.githubusercontent.com/KrisLiu16/claude-proxy-manager/refs/heads/main/skills/cpm/SKILL.md -o ~/.codex/skills/cpm/SKILL.md
```

`cpm help` 是无需安装 skill 的内置操作说明。

## 开发

源码使用 TypeScript，开发需要 Node.js 22 或更高版本；Release 使用 Bun 编译单文件程序。

```bash
npm install
npm run check
npm run build:release
```
