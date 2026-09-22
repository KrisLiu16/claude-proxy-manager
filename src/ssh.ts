import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import type {HostProfile, RemoteStatus} from './types.js';
import {validateHost} from './types.js';

const checkScript = String.raw`set -eu
config="$HOME/.config/claude-proxy/config"
launcher="$HOME/.local/bin/claude-proxy"
bridge="$HOME/.local/share/claude-proxy/socks_http_bridge.py"
echo connected=yes
[ -x "$launcher" ] && echo launcher=yes || echo launcher=no
[ -f "$bridge" ] && echo bridge=yes || echo bridge=no
if [ -f "$config" ]; then
  echo config=yes
  mode=$(stat -c '%a' "$config" 2>/dev/null || stat -f '%Lp' "$config" 2>/dev/null || echo unknown)
  printf 'config_mode=%s\n' "$mode"
  grep -Eq '^SOCKS5_PROXY=socks5h?://' "$config" && echo proxy_configured=yes || echo proxy_configured=no
  awk 'index($0,"CLAUDE_BIN=")==1 {print "real_claude=" substr($0,12); exit}' "$config"
  awk 'index($0,"NO_PROXY=")==1 {print "no_proxy=" substr($0,10); exit}' "$config"
else
  echo config=no
  echo config_mode=-
  echo proxy_configured=no
fi
if grep -q '>>> claude-proxy-manager >>>' "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc" 2>/dev/null; then
  echo replace_claude=yes
else
  echo replace_claude=no
fi
if [ -x "$launcher" ] && [ -f "$config" ] && grep -q '^SOCKS5_PROXY=' "$config"; then
  if timeout 35 "$launcher" --check >/dev/null 2>&1; then
    echo proxy_health=OK
  else
    echo proxy_health=FAILED
  fi
else
  echo proxy_health=NOT_CONFIGURED
fi
`;

const applyScript = String.raw`set -eu
umask 077
config_dir="$HOME/.config/claude-proxy"
config="$config_dir/config"
mkdir -p "$config_dir"
chmod 700 "$config_dir"
incoming=$(mktemp "$config_dir/.incoming.XXXXXX")
output=$(mktemp "$config_dir/.config.XXXXXX")
cleanup() { python3 - "$incoming" "$output" <<'PY'
import os, sys
for path in sys.argv[1:]:
    try: os.unlink(path)
    except FileNotFoundError: pass
PY
}
trap cleanup EXIT HUP INT TERM
cat > "$incoming"
real_claude=""
if [ -f "$config" ]; then
  real_claude=$(awk 'index($0,"CLAUDE_BIN=")==1 {print substr($0,12); exit}' "$config")
fi
if [ -z "$real_claude" ]; then
  candidate=$(command -v claude 2>/dev/null || true)
  case "$candidate" in */.local/share/claude-proxy/shim-bin/claude) candidate="" ;; esac
  real_claude="$candidate"
fi
if [ -z "$real_claude" ]; then
  for candidate in "$HOME/.local/bin/claude" /usr/local/bin/claude /usr/bin/claude; do
    if [ -x "$candidate" ] && [ "$candidate" != "$HOME/.local/share/claude-proxy/shim-bin/claude" ]; then
      real_claude="$candidate"
      break
    fi
  done
fi
if [ -z "$real_claude" ]; then
  echo 'Claude CLI is not installed or could not be located' >&2
  exit 4
fi
cat "$incoming" > "$output"
printf 'CLAUDE_BIN=%s\n' "$real_claude" >> "$output"
chmod 600 "$output"
mv "$output" "$config"
`;

const toggleScript = String.raw`set -eu
mode="$1"
shim_dir="$HOME/.local/share/claude-proxy/shim-bin"
mkdir -p "$shim_dir"
cat > "$shim_dir/claude" <<'SHIM'
#!/bin/sh
exec "$HOME/.local/bin/claude-proxy" "$@"
SHIM
chmod 755 "$shim_dir/claude"
python3 - "$mode" "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc" <<'PY'
from pathlib import Path
import sys
mode = sys.argv[1]
start = "# >>> claude-proxy-manager >>>"
end = "# <<< claude-proxy-manager <<<"
block = (
    f"{start}\n"
    'case ":$PATH:" in\n'
    '  *":$HOME/.local/share/claude-proxy/shim-bin:"*) ;;\n'
    '  *) export PATH="$HOME/.local/share/claude-proxy/shim-bin:$PATH" ;;\n'
    'esac\n'
    f"{end}\n"
)
for name in sys.argv[2:]:
    path = Path(name)
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    while start in text:
        before, _, rest = text.partition(start)
        _, separator, after = rest.partition(end)
        text = before.rstrip("\n") + ("\n" + after.lstrip("\n") if separator else "\n")
    if mode == "on":
        text = text.rstrip("\n") + "\n\n" + block
    path.write_text(text, encoding="utf-8")
PY
`;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assetPath(name: string): string {
	return fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
}

export class SSHClient {
	public constructor(private readonly connectTimeoutSeconds = 10) {}

	private async run(host: string, command: string, stdin: string | Buffer, timeoutMs: number): Promise<string> {
		if (!host || host.startsWith('-') || /\s/.test(host)) throw new Error('无效的 SSH 主机');
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await new Promise((resolve, reject) => {
				const child = spawn(
					'ssh',
					['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${this.connectTimeoutSeconds}`, '--', host, command],
					{stdio: ['pipe', 'pipe', 'pipe'], signal: controller.signal},
				);
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
				child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
				child.on('error', error => reject(error));
				child.on('close', code => {
					if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
					else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `SSH 操作失败，退出码 ${code}`));
				});
				child.stdin.end(stdin);
			});
		} catch (error) {
			if ((error as Error).name === 'AbortError') throw new Error(`连接或远端操作超时: ${host}`);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private runScript(host: string, script: string, timeoutMs: number, ...args: string[]): Promise<string> {
		const command = `sh -s --${args.length ? ` ${args.map(shellQuote).join(' ')}` : ''}`;
		return this.run(host, command, script, timeoutMs);
	}

	public async check(host: HostProfile): Promise<RemoteStatus> {
		const output = await this.runScript(host.sshHost, checkScript, 60_000);
		const values = new Map(
			output.split('\n').filter(line => line.includes('=')).map(line => {
				const index = line.indexOf('=');
				return [line.slice(0, index), line.slice(index + 1)] as const;
			}),
		);
		return {
			connected: values.get('connected') === 'yes',
			launcher: values.get('launcher') === 'yes',
			bridge: values.get('bridge') === 'yes',
			config: values.get('config') === 'yes',
			configMode: values.get('config_mode') || '-',
			proxyConfigured: values.get('proxy_configured') === 'yes',
			realClaude: values.get('real_claude') || '',
			replaceClaude: values.get('replace_claude') === 'yes',
			noProxy: values.get('no_proxy') || '',
			proxyHealth: values.get('proxy_health') || 'NOT_CHECKED',
		};
	}

	public async install(host: HostProfile): Promise<void> {
		const [launcher, bridge] = await Promise.all([
			readFile(assetPath('claude-proxy')),
			readFile(assetPath('socks_http_bridge.py')),
		]);
		const script = String.raw`set -eu
umask 077
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/claude-proxy"
printf '%s' ${shellQuote(launcher.toString('base64'))} | base64 -d > "$HOME/.local/bin/claude-proxy"
printf '%s' ${shellQuote(bridge.toString('base64'))} | base64 -d > "$HOME/.local/share/claude-proxy/socks_http_bridge.py"
chmod 755 "$HOME/.local/bin/claude-proxy" "$HOME/.local/share/claude-proxy/socks_http_bridge.py"
`;
		await this.runScript(host.sshHost, script, 60_000);
	}

	public async applyConfig(host: HostProfile, password: string): Promise<void> {
		validateHost(host, true);
		if (!password || /[\r\n]/.test(password)) throw new Error('代理密码不能为空且不能包含换行');
		const username = encodeURIComponent(host.proxyUser);
		const encodedPassword = encodeURIComponent(password);
		const address = host.proxyHost.includes(':') ? `[${host.proxyHost}]` : host.proxyHost;
		const content = `SOCKS5_PROXY=socks5h://${username}:${encodedPassword}@${address}:${host.proxyPort}\nNO_PROXY=${host.noProxy.join(',')}\n`;
		await this.run(host.sshHost, `sh -c ${shellQuote(applyScript)}`, content, 60_000);
	}

	public async setReplaceClaude(host: HostProfile, enabled: boolean): Promise<void> {
		await this.runScript(host.sshHost, toggleScript, 60_000, enabled ? 'on' : 'off');
	}

	public async setup(host: HostProfile, password: string): Promise<RemoteStatus> {
		await this.install(host);
		await this.applyConfig(host, password);
		await this.setReplaceClaude(host, host.replaceClaude);
		return this.check(host);
	}
}

export const scriptsForTest = {applyScript, toggleScript};

