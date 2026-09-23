# CPM

`cpm` 是一个 TypeScript 单文件程序，同时负责：

- 通过 SSH 管理多台开发机
- 安装官方 Claude Code
- 把适合开发机平台的 `cpm` 分发到远端
- 内置 HTTP → SOCKS5 bridge
- 在 Linux 开发机的独立进程和网络空间中运行 Claude Code
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
curl -fsSL https://raw.githubusercontent.com/KrisLiu16/claude-proxy-manager/main/install.sh | CPM_VERSION=v0.7.0 sh
```

安装器支持 Linux/macOS 的 x64 和 arm64，验证 Release 资产的 SHA-256，默认写入 `~/.local/bin/cpm`。可用以下变量调整：

```text
CPM_INSTALL_DIR=/custom/bin
CPM_NO_MODIFY_PATH=1
CPM_VERSION=v0.7.0
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
  ├─ 创建独立网络、进程、主机名和挂载空间
  ├─ 保留开发机文件系统读写，覆盖 /etc/localtime 等宿主信息入口
  ├─ sidecar 处理 TCP 出网、合成 DNS 与内网白名单
  ├─ 在沙箱内部复查出口 IP、路由、DNS、时区和主机名
  └─ 执行真实 Claude 及其子进程，并自动加入 --no-chrome
```

开发机不访问 GitHub 或 npm 来安装 Claude/cpm。开发机缺少 redsocks 时，`s` 通过系统 apt 源下载并解包这项网络组件。

管理器支持 Linux/macOS x64 与 arm64；强制隔离的 `cpm proxy` 当前支持 Linux 开发机。开发机需要 `sudo -n` 能创建 namespace，并具备 `unshare`、`mount`、`ip`、`nft`、`setpriv`。隔离不可用时启动会失败，不会退回到只设置代理环境变量的模式。

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

`s` 是幂等操作：开发机已有 Claude Code 时直接复用；远端 `cpm --version` 与当前管理器版本一致时，跳过 cpm 下载、校验和 SSH 上传。沙箱组件、代理、白名单、时区、语言、默认替换开关与最终检查仍会正常执行。

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
- 可选的 `CLAUDE_CONFIG_DIR`，用于需要独立或持久化 Claude 状态的开发机
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
| 网络 | 开发机直连 IP、代理出口 IP、节点 IP 对比、Anthropic API |
| 地理信息 | 国家、州/地区、城市、ISP/组织、IANA 时区、语言、数据来源 |
| 启动 | `--no-chrome`、默认替换开关、沙箱组件与 namespace 权限 |

检查会实际完成 SOCKS5 认证、TLS 请求和 Anthropic API 连通性测试。错误行包含具体原因，不包含代理密码。

正常执行 `cpm proxy` 或通过默认替换执行 `claude` 时，会先打印现有完整检查表，再创建沙箱并打印其中的路由、DNS、时区、主机名和出口检查。任一 `FAIL` 都会停止启动 Claude。

## Claude 运行环境

`cpm proxy` 为 Claude 及其子进程提供：

```text
ALL_PROXY=http://127.0.0.1:17891
all_proxy=http://127.0.0.1:17891
HTTPS_PROXY=http://127.0.0.1:17891
https_proxy=http://127.0.0.1:17891
HTTP_PROXY=http://127.0.0.1:17891
http_proxy=http://127.0.0.1:17891
NO_PROXY=<每台机器的白名单>
no_proxy=<每台机器的白名单>
TZ=<根据代理出口自动探测，例如 America/New_York>
LANG=<根据出口语言自动生成，例如 en_US.UTF-8>
LC_ALL=<同 LANG>
LC_CTYPE=<同 LANG>
LC_MESSAGES=<同 LANG>
CLAUDE_CONFIG_DIR=<可选的 Claude 状态目录>
```

沙箱里的外部 TCP 连接都被重定向到本次 sidecar，沙箱内部的回环连接仍可供本地服务使用。DNS 查询返回会话内的合成地址，再由 sidecar 按域名执行白名单或 SOCKS5 转发。云元数据和宿主回环地址始终拒绝。IPv6 外网和非 DNS UDP 当前不可用，依赖它们的工具会报网络错误。

项目、HOME 和开发机工具仍使用真实文件系统，Claude 修改的文件立即写回原位置。沙箱覆盖 `/etc/localtime`、`/etc/timezone`、主机名、DNS、进程表、云初始化目录以及 `/run`，不复制整个开发环境。对整个文件系统的读写权限也意味着进程可以通过其他宿主 socket 或可写文件间接影响沙箱外的程序；此模式不能提供完全隔绝宿主机的安全边界。

自动探测以 `ipapi.co` 为主，`ipwho.is` 为备用，结果按代理配置缓存 6 小时。时区与 locale 可以按机器显式填写，手动值优先。实时 API 失败时，即使缓存已经超过 6 小时，也会继续使用最后一次成功结果；自动模式下从未生成缓存则停止启动。IP 地理位置来自数据库估算，城市和 ISP 可能在不同供应商之间有差异。

bridge 只监听 `127.0.0.1`，SOCKS5 凭据从权限为 `0600` 的配置文件读取，不进入进程参数。

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
~/.local/share/cpm/native/usr/sbin/redsocks（开发机未预装时）
~/.local/state/cpm/bridge-17891.pid
~/.local/state/cpm/bridge-17891.log
~/.local/state/cpm/geolocation.json
```

密码只保存在本机 `secrets.json` 和开发机 `proxy.env` 中，两者权限均为 `0600`。密码不会写入主机列表、Git、SSH 参数或 bridge 进程参数。

## 开发

源码需要 Node.js 22 或更高版本。Release 使用 Bun 编译四个平台的单文件程序。

```bash
npm install
npm run check
npm run build:release
```
