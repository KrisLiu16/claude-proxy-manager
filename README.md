# Claude Proxy Manager (`cpm`)

通过本机 SSH 配置管理多台远端开发机上的 `claude-proxy`。每台机器可独立设置代理、网络白名单，以及是否让 `claude` 默认经过代理。

## 功能

- 检查远端是否安装 `claude-proxy`、bridge 和私有配置文件
- 一键安装或更新启动器与 HTTP → SOCKS5 bridge
- 每台机器独立设置 SOCKS5 地址、账号、密码和 `NO_PROXY`
- 检查代理实际连通性
- 可选地让 `claude` 默认执行 `claude-proxy`
- 同时提供 TUI 和非交互命令
- 本地密码使用系统钥匙串；普通 JSON 配置不含密码

## 安全设计

- 代理密码不进入 Git、本地 JSON、SSH 参数或远端进程参数
- 密码通过 SSH 标准输入写入远端 `~/.config/claude-proxy/config`，权限固定为 `600`
- bridge 只监听 `127.0.0.1`，运行时从私有配置文件读取凭据
- 启动器在配置缺失、bridge 启动失败或真实 Claude 不存在时停止，不回落到直连
- “替换 Claude”不会覆盖真实二进制。它在独立目录创建 shim，并通过受标记的 shell 配置块调整 `PATH`，关闭开关即可撤销

在 macOS 和 Windows 上，密码存入系统原生钥匙串。在 Linux 上优先使用 Secret Service，缺失时尝试内核 keyring。若当前 Linux 登录会话没有可用钥匙串，密码只保留到本次 TUI 退出，仍可立即执行一键设置。

## 环境要求

本机：

- Node.js 22 或更高版本
- OpenSSH 客户端
- 已在 `~/.ssh/config`、SSH agent 或密钥文件中配置免交互登录

远端开发机：

- Linux、POSIX shell
- `python3`、`curl`、`base64`
- 已安装 Claude Code CLI

SSH 操作使用 `BatchMode=yes`，不会在 TUI 中询问 SSH 密码。

## 安装

开发环境：

```bash
npm install
npm run build
npm link
cpm
```

直接从 GitHub 安装：

```bash
npm install -g github:KrisLiu16/claude-proxy-manager
cpm
```

## TUI 使用

```text
↑/↓  选择机器
a    添加机器
e    编辑机器
c    检查远端状态
i    只安装/更新启动器
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
cpm install dev
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
