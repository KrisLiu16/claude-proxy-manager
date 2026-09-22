# Claude Proxy Manager (`cpm`)

通过本机 SSH 配置管理多台远端开发机上的 `claude-proxy`。每台机器可独立设置代理、网络白名单，以及是否让 `claude` 默认经过代理。

## 功能

- 检查远端是否安装 `claude-proxy`、bridge 和私有配置文件
- 缺少 Claude Code 时，从 Anthropic 官方 npm 平台包校验并安装原生二进制
- 一键安装或更新启动器与 HTTP → SOCKS5 bridge
- 每台机器独立设置 SOCKS5 地址、账号、密码和 `NO_PROXY`
- 检查代理实际连通性
- 可选地让 `claude` 默认执行 `claude-proxy`
- 同时提供 TUI 和非交互命令
- 本地密码使用独立的 `0600` 机密文件；普通主机配置不含密码

## 安全设计

- 代理密码不进入 Git、普通主机配置、SSH 参数或远端进程参数
- 密码通过 SSH 标准输入写入远端 `~/.config/claude-proxy/config`，权限固定为 `600`
- bridge 只监听 `127.0.0.1`，运行时从私有配置文件读取凭据
- 启动器在配置缺失、bridge 启动失败或真实 Claude 不存在时停止，不回落到直连
- “替换 Claude”不会覆盖真实二进制。它在独立目录创建 shim，并通过受标记的 shell 配置块调整 `PATH`，关闭开关即可撤销

本地密码位于 `~/.config/claude-proxy-manager/secrets.json`，目录权限为 `0700`，文件权限为 `0600`。这样发布的单文件可执行程序不依赖平台原生扩展。

## 安装与运行架构

GitHub Release 分发的是本机运行的 `cpm` 单文件程序。GitHub Actions 使用 Bun 从本仓库的 TypeScript 源码构建它。

开发机上的组件不从 GitHub 或 npm 下载。执行 `cpm install` 或 TUI 中的安装操作时，链路是：

```text
本机 cpm
  ├─ 通过 SSH 检查开发机上的真实 claude
  ├─ 缺失时：本机访问 registry.npmjs.org
  │   ├─ 读取 @anthropic-ai/claude-code 的 latest 元数据
  │   ├─ 选择开发机平台对应的 @anthropic-ai/claude-code-* 包
  │   ├─ 下载 tarball 并核对 npm 的 SHA-512 integrity
  │   └─ 只提取 package/claude
  └─ 系统 ssh（读取 ~/.ssh/config 和 SSH agent）
      ├─ 写入 ~/.local/bin/claude
      ├─ 写入 ~/.local/bin/claude-proxy
      └─ 写入 ~/.local/share/claude-proxy/socks_http_bridge.py
```

这两个文件已嵌入 `cpm`：

- `claude-proxy` 是仓库 [`assets/claude-proxy`](assets/claude-proxy) 中的 POSIX shell 启动脚本，不是外部二进制。
- `socks_http_bridge.py` 是仓库 [`assets/socks_http_bridge.py`](assets/socks_http_bridge.py) 中的 Python bridge。
- 开发机已有真实 Claude Code CLI 时，`cpm` 保留它并记录绝对路径为 `CLAUDE_BIN`。
- 开发机缺失时，`cpm` 按 Aster 脚手架同步使用的 npm 平台包算法在本机取得官方原生二进制，再通过 SSH 标准输入上传；远端不需要公网访问。

远端检查失败时，`cpm` 会回传 `claude-proxy --check` 的输出并显示在 `代理=FAILED` 下方。回传前会对 SOCKS5 URL 中的用户名和密码脱敏。

## 环境要求

本机：

- OpenSSH 客户端
- `tar`（缺少 Claude 时提取官方 npm 平台包）
- 已在 `~/.ssh/config`、SSH agent 或密钥文件中配置免交互登录

远端开发机：

- Linux、POSIX shell
- `python3`、`curl`、`base64`

SSH 操作使用 `BatchMode=yes`，不会在 TUI 中询问 SSH 密码。

## 安装

一键安装或升级最新版本：

```bash
curl -fsSL https://raw.githubusercontent.com/KrisLiu16/claude-proxy-manager/main/install.sh | sh
```

安装指定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/KrisLiu16/claude-proxy-manager/main/install.sh | CPM_VERSION=v0.1.4 sh
```

安装器支持 Linux/macOS 的 x64 和 arm64，下载 GitHub Release 中的单文件可执行程序，并在安装前验证 SHA-256。连接终端时会显示实时进度条、百分比和 MiB；CI 或重定向输出时使用无控制字符的纯文本状态行。

默认安装到 `~/.local/bin/cpm` 并为 bash、zsh、fish 配置 PATH。可用以下变量调整：

```text
CPM_INSTALL_DIR=/custom/bin   自定义安装目录
CPM_NO_MODIFY_PATH=1         不修改 shell 配置
CPM_VERSION=v0.1.4           安装固定版本
```

开发环境：

开发源码需要 Node.js 22 或更高版本。

```bash
npm install
npm run build
npm link
cpm
```

## TUI 使用

```text
↑/↓  选择机器
a    添加机器
e    编辑机器
c    检查远端状态
i    检查并安装官方 Claude、代理启动器和 bridge
s    一键安装、写配置、应用默认替换并验证
t    切换 claude → claude-proxy
d    删除本地配置（需按两次，不删除远端文件）
q    退出
```

编辑页面：

```text
Tab / Shift+Tab   切换字段
Ctrl+T            切换默认替换
Ctrl+S            保存
Esc               取消
```

代理可以拆分填写，也可以直接粘贴到“快速导入”字段。例如服务商给出：

```text
proxy.example.com:8022:USERNAME:PASSWORD
```

对应填写代理主机、端口、用户和密码四个字段。

白名单使用逗号分隔，不包含协议和路径：

```text
naiveai-dev.com,.naiveai-dev.com,10.34.8.92
```

根域和 `.根域` 同时填写，可以兼容不同客户端的 `NO_PROXY` 匹配规则。

## CLI

```bash
cpm list
cpm check dev
cpm install dev      # 缺 Claude 时自动安装官方平台包
cpm setup dev
cpm enable dev
cpm disable dev
```

首次添加机器和输入密码使用 TUI。之后可以通过非交互命令检查或重复部署。

## 远端文件

```text
~/.local/bin/claude-proxy
~/.local/share/claude-proxy/socks_http_bridge.py
~/.local/share/claude-proxy/shim-bin/claude
~/.config/claude-proxy/config
~/.local/state/claude-proxy/
```

默认替换开关只修改以下 shell 文件中带明确标记的配置块：

```text
~/.profile
~/.bashrc
~/.zshrc
```

## 开发

```bash
npm run build
npm test
npm run check
```
