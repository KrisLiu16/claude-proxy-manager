# CPM

`cpm` 是一个 TypeScript 单文件程序，同时负责：

- 通过 SSH 管理多台开发机
- 安装官方 Claude Code
- 把适合开发机平台的 `cpm` 分发到远端
- 内置 HTTP → SOCKS5 bridge
- 在独立容器中运行 Claude、Codex 或任意开发命令
- 逐项检查文件、网络、环境变量、时区和出口 IP
- 安装和设置时显示阶段、百分比、传输 MiB 与已用时间

远端没有单独的代理启动器或 Python bridge。运行代理版 Claude 的命令是：

```bash
cpm proxy
```

开启默认替换后，直接输入 `claude` 也会执行 `cpm proxy`。真实 Claude 二进制不会被覆盖。

默认替换同时使用 shell 函数和 PATH shim：函数优先执行 `cpm proxy`，shim 作为非交互命令的后备。开启或关闭后需要重新登录 SSH shell，可以运行 `command -V claude` 确认解析结果。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/KrisLiu16/claude-proxy-manager/main/install.sh | sh
```

安装指定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/KrisLiu16/claude-proxy-manager/main/install.sh | CPM_VERSION=v0.8.0 sh
```

安装器支持 Linux/macOS 的 x64 和 arm64，验证 Release 资产的 SHA-256，默认写入 `~/.local/bin/cpm`。可用以下变量调整：

```text
CPM_INSTALL_DIR=/custom/bin
CPM_NO_MODIFY_PATH=1
CPM_VERSION=v0.8.0
```

## 工作方式

```text
本机 cpm
  ├─ 使用 ~/.ssh/config、SSH agent 和密钥连接开发机
  ├─ 检查开发机平台与 Claude Code
  ├─ Claude 缺失时在本机下载并校验 Anthropic 官方平台包
  ├─ 选择开发机平台对应的 cpm 二进制
  │   ├─ 同平台：直接分发当前 cpm
  │   └─ 跨平台：本机从本仓库 Release 下载并校验对应资产
  └─ 通过 SSH 标准输入上传到 ~/.local/bin/cpm

开发机 cpm proxy
  ├─ 读取 ~/.config/cpm/proxy.env
  ├─ 启动前验证 SOCKS5、代理出口与地理信息
  ├─ 构建固定基础镜像：Git、Node.js、Python、官方 Claude、cpm
  ├─ 启动无外网、只读根文件系统、无 capability 的独立容器
  ├─ 仅挂容器专属 HOME、工作区卷和只读 sidecar 通信目录
  ├─ 在容器里复查直连阻断、DNS、时区和代理出口
  └─ 默认执行 Claude，也可执行 Codex 或任意命令
```

Claude/cpm 二进制仍从管理器通过 SSH 分发。开发机首次构建镜像时从系统源安装工具；首次运行 Codex 时，它在独立 HOME 中通过受控代理安装官方 npm 包。

管理器支持 Linux/macOS x64 与 arm64；独立容器当前支持 Linux 开发机。开发机需要 Docker Engine、seccomp 与 AppArmor；`s` 会在缺少 Docker 的 Ubuntu/Debian 开发机上尝试通过免密 sudo 安装并启动它。缺少隔离能力时启动失败。

## TUI

```bash
cpm
```

```text
↑/↓  选择机器
a    添加机器
e    编辑机器
c    逐项检查
s    安装、配置、切换默认替换并检查
g    在 macOS 上打开 CPM 安全浏览器
t    切换 claude → cpm proxy
d    删除本地机器配置
q    退出
```

安装过程会实时显示当前阶段。下载 Claude/cpm 和 SSH 上传时同时显示已传输 MiB，远端检查阶段持续显示已用时间。

`s` 是幂等操作：开发机已有 Claude Code 时直接复用；远端 `cpm --version` 与当前管理器版本一致时，跳过 cpm 下载、校验和 SSH 上传。镜像按二进制摘要、时区、语言和构建规则缓存；HOME 和工作区卷跨启动保留。

### macOS 安全浏览器

先用 `⌘Q` 完全退出 Google Chrome，按 `s` 完成远端设置，再按 `g` 打开安全浏览器。它默认打开 `https://ip.net.coffee/claude/`，用户也可以在该 Chrome 实例中自行访问 Claude 登录页：

- 浏览器流量经本机随机回环端口转入该机器配置的 SOCKS5 代理，代理凭据只保存在 CPM 内存中
- 直接使用最近打开的原 Chrome Profile，现有 Cookie、Local Storage 和登录状态原生生效，不复制或解密 Cookie
- Cookie 和站点状态来自原 Profile；扩展在本次登录中禁用，避免代理扩展或 PAC 把部分域名改成直连
- 本次使用独立空缓存目录，避免 IP 检测网站读到原 Profile 中缓存的旧出口结果
- Chrome 完全退出后，临时设置原 Profile 的 `intl.accept_languages` 与 `intl.selected_languages`，使 `navigator.languages` 和请求语言匹配出口；关闭安全浏览器后只恢复这两个字段
- 启动前经 macOS 管理员授权临时切换系统时区，关闭安全浏览器后再恢复原时区
- 安全浏览器强制全量走代理，不继承 `NO_PROXY`，避免域名因白名单误配而直连
- 整个 Chrome 实例的 HTTP/HTTPS 流量使用 CPM 本机代理，并禁用 DNS 预取、QUIC 与非代理 WebRTC UDP
- Chrome 首先访问随机的 `cpm.internal` 探针；只有 CPM bridge 收到请求并通过所配置的 SOCKS5 成功建立 HTTPS 隧道才继续，任一步失败都会关闭并报错

回到 TUI 按 Esc 或 Enter 后，本次 Chrome 与本机代理会关闭，并恢复语言和时区。因为 Chrome 必须完全退出后才能让新的进程级代理参数生效，检测到 Chrome 已运行时 CPM 会拒绝启动并给出提示。

需要人工确认时，可在该 Chrome 实例中新开标签访问 `https://ip.net.coffee/claude/`。中国出口 IPv4、Cloudflare 出口和 Claude AI 出口应一致，WebRTC UDP 项不应显示不同的公网 IP。独立空缓存会避免读取原 Profile 中旧的 IP 检测结果。

如果 CPM、Chrome 或 macOS 在登录期间异常终止，自动恢复步骤可能来不及执行，此时需要用户在 macOS“日期与时间”设置中手动改回原时区。

每台机器可以独立配置：

- SSH alias 或 `user@host`
- SOCKS5 主机、端口、用户名和密码
- `NO_PROXY` 白名单
- Claude 进程时区，默认 `auto`，根据代理出口注入 IANA 时区
- Claude 进程 locale，默认 `auto`，根据出口国家与语言注入
- Claude 与 Codex 的登录状态保存在各自开发机的容器 HOME 卷中
- 是否让 `claude` 默认执行 `cpm proxy`，新建机器默认开启

代理也可以用一行快速导入：

```text
proxy.example.com:8022:USERNAME:PASSWORD
```

白名单使用逗号分隔，不带协议或路径：

```text
localhost,127.0.0.1,::1,naiveai-dev.com,.naiveai-dev.com,10.34.8.92
```

根域与 `.根域` 同时填写，可以兼容不同客户端的 `NO_PROXY` 匹配规则。

## CLI

```bash
cpm list
cpm check dev
cpm setup dev
cpm enable dev
cpm disable dev

# 在当前机器直接运行
cpm proxy
cpm proxy codex
cpm proxy -- python3 --version
cpm sandbox -- git clone https://example.com/project.git
cpm sandbox -- bash
cpm proxy --check
```

首次添加机器和代理密码使用 TUI。之后可以用非交互命令重复部署和检查。

## 逐项检查

`cpm check <机器>` 和开发机上的 `cpm proxy --check` 都输出表格。每一项独立显示 `OK`、`WARN`、`FAIL` 或 `INFO`：

| 类别 | 检查项 |
|---|---|
| 安装 | SSH、cpm 版本与路径、配置文件权限、真实 Claude |
| 代理 | SOCKS5H 配置、网关 TCP、内置 bridge、远端 DNS |
| 环境 | `ALL_PROXY`、`HTTPS_PROXY`、`HTTP_PROXY` 及小写版本 |
| 白名单 | `NO_PROXY`、`no_proxy` |
| 区域 | `TZ`、`LANG`、`LC_ALL`、`LC_CTYPE`、`LC_MESSAGES` |
| 网络 | 宿主直连探测状态、代理出口 IP、节点 IP 对比、Anthropic API |
| 地理信息 | 国家、州/地区、城市、ISP/组织、IANA 时区、语言、数据来源 |
| 启动 | 默认替换开关、Docker 服务、seccomp、AppArmor |

检查会实际完成 SOCKS5 认证、经代理的 TLS 请求和 Anthropic API 连通性测试。启动前不会让宿主机直连公网探测真实 IP。错误行包含具体原因，不包含代理密码。

正常执行 `cpm proxy` 或通过默认替换执行 `claude` 时，会先打印宿主代理检查表，再在容器里打印直连阻断、DNS、时区、主机名和出口检查。任一 `FAIL` 都会停止启动目标命令。运行其他命令时不会要求 Anthropic API 连通。

## 独立运行环境

CPM 只从宿主向容器传入以下运行所需变量；代理密码、SSH 凭据和宿主 Claude/Codex 登录状态不会复制进去：

```text
ALL_PROXY=http://127.0.0.1:17891
all_proxy=http://127.0.0.1:17891
HTTPS_PROXY=http://127.0.0.1:17891
https_proxy=http://127.0.0.1:17891
HTTP_PROXY=http://127.0.0.1:17891
http_proxy=http://127.0.0.1:17891
NO_PROXY=localhost,127.0.0.1,::1
no_proxy=localhost,127.0.0.1,::1
TZ=<根据代理出口自动探测，例如 America/New_York>
LANG=<根据出口语言自动生成，例如 en_US.UTF-8>
LC_ALL=<同 LANG>
LC_CTYPE=<同 LANG>
LC_MESSAGES=<同 LANG>
HOME=/home/node
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

容器使用 Docker 的 `network none`：外部 TCP、UDP 和 IPv6 直连都无法建立。容器里的回环 HTTP/SOCKS 服务通过只读挂载的 Unix socket 联系宿主 sidecar；每台机器的白名单由 sidecar 决定，应用程序不能用 `NO_PROXY` 绕过。未使用代理的网络工具会失败，可以改用支持 HTTP/SOCKS 代理的方式。

宿主项目和 HOME 不挂入容器。容器有自己的 `/home/node` 与 `/workspace` 持久卷，可在里面克隆代码、建立 Python 虚拟环境、安装 npm 包并保留登录状态。根文件系统只读，`/tmp` 和 `/run` 为临时文件系统；需要新增系统包时，要重建基础镜像。容器禁用所有 Linux capability，启用 `no-new-privileges`、seccomp、AppArmor 与进程/内存限额。Linux 内核和容器运行痕迹仍可能被检测到，不能承诺程序无法识别自己处于容器中。

[Claude-Shield](https://github.com/CACEB001/Claude-Shield) 的扫描、locale 和代理审计思路可用于对照检查；它的二进制补丁针对历史 Claude 版本，仓库说明相关路径在 2.1.197+ 已移除。CPM 不修改官方 Claude 或 Codex 的二进制。容器内首次使用时，用户需要自行完成对应 CLI 的登录。

自动探测以 `ipapi.co` 为主，`ipwho.is` 为备用，结果按代理配置缓存 6 小时。时区与 locale 可以按机器显式填写，手动值优先。实时 API 失败时，即使缓存已经超过 6 小时，也会继续使用最后一次成功结果；自动模式下从未生成缓存则停止启动。IP 地理位置来自数据库估算，城市和 ISP 可能在不同供应商之间有差异。

宿主 bridge 只监听 `127.0.0.1`，SOCKS5 凭据从权限为 `0600` 的配置文件读取，不进入容器环境或进程参数。直接执行开发机上的原生 Claude 二进制会绕过 CPM；默认 `claude` 命令由 shell 函数路由到 `cpm proxy`。

## 文件布局

管理器本机：

```text
~/.local/bin/cpm
~/.config/cpm/hosts.json
~/.config/cpm/secrets.json
~/.config/cpm/env
```

开发机：

```text
~/.local/bin/cpm
~/.local/bin/claude
~/.config/cpm/proxy.env
~/.local/share/cpm/shim-bin/claude
~/.local/state/cpm/bridge-17891.pid
~/.local/state/cpm/bridge-17891.log
~/.local/state/cpm/geolocation.json
```

Docker 管理的持久卷为 `cpm-home-<ID>` 和 `cpm-workspace-<ID>`。CPM 不会自动删除其中的代码或登录状态。

密码只保存在本机 `secrets.json` 和开发机 `proxy.env` 中，两者权限均为 `0600`。密码不会写入主机列表、Git、SSH 参数或 bridge 进程参数。

## 开发

源码需要 Node.js 22 或更高版本。Release 使用 Bun 编译四个平台的单文件程序。

```bash
npm install
npm run check
npm run build:release
```
