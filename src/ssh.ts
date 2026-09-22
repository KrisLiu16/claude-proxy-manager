import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import type {HostProfile, RemoteStatus} from './types.js';
import {validateHost} from './types.js';
import {downloadOfficialClaude, type ClaudePlatform} from './official-claude.js';
import {runtimeForRemote} from './runtime-distribution.js';

const claudeProbeScript = String.raw`set -eu
config="$HOME/.config/cpm/proxy.env"
claude_path=""
if [ -f "$config" ]; then
  claude_path=$(awk 'index($0,"CLAUDE_BIN=")==1 {print substr($0,12); exit}' "$config")
  [ -x "$claude_path" ] || claude_path=""
fi
if [ -z "$claude_path" ]; then
  for candidate in "$HOME/.local/bin/claude" /usr/local/bin/claude /usr/bin/claude; do
    [ ! -x "$candidate" ] || { claude_path="$candidate"; break; }
  done
fi
printf 'claude_path=%s\n' "$claude_path"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) platform=linux-x64 ;;
  Linux-aarch64|Linux-arm64) platform=linux-arm64 ;;
  Darwin-x86_64) platform=darwin-x64 ;;
  Darwin-arm64) platform=darwin-arm64 ;;
  *) echo "unsupported=$(uname -s)-$(uname -m)"; exit 0 ;;
esac
case "$platform" in
  linux-*) if [ -e /etc/alpine-release ] || (ldd --version 2>&1 || true) | grep -qi musl; then platform="$platform-musl"; fi ;;
esac
printf 'platform=%s\n' "$platform"
`;

const installClaudeScript = String.raw`set -eu
mkdir -p "$HOME/.local/bin"
target="$HOME/.local/bin/claude"
tmp="$target.cpm.$$"
trap 'rm -f "$tmp"' EXIT HUP INT TERM
cat > "$tmp"
chmod 755 "$tmp"
reported=$("$tmp" --version 2>&1) || { printf '%s\n' "$reported" >&2; exit 4; }
mv "$tmp" "$target"
trap - EXIT HUP INT TERM
printf 'claude_path=%s\n' "$target"
printf 'claude_version=%s\n' "$reported"
`;

const installRuntimeScript = String.raw`set -eu
mkdir -p "$HOME/.local/bin"
target="$HOME/.local/bin/cpm"
tmp="$target.new.$$"
trap 'rm -f "$tmp"' EXIT HUP INT TERM
cat > "$tmp"
chmod 755 "$tmp"
"$tmp" --version >/dev/null
if [ -x "$target" ]; then "$target" __stop-bridge >/dev/null 2>&1 || true; fi
mv "$tmp" "$target"
trap - EXIT HUP INT TERM
"$target" --version
`;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseValues(output: string): Map<string, string> {
	return new Map(output.split('\n').filter(line => line.includes('=')).map(line => {
		const index = line.indexOf('=');
		return [line.slice(0, index), line.slice(index + 1)] as const;
	}));
}

export class SSHClient {
	public constructor(private readonly connectTimeoutSeconds = 10) {}

	private async run(host: string, command: string, stdin: string | Buffer, timeoutMs: number): Promise<string> {
		if (!host || host.startsWith('-') || /\s/.test(host)) throw new Error('无效的 SSH 主机');
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await new Promise((resolve, reject) => {
				const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${this.connectTimeoutSeconds}`, '--', host, command], {stdio: ['pipe', 'pipe', 'pipe'], signal: controller.signal});
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
				child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
				child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
				child.on('error', reject);
				child.on('close', code => code === 0 ? resolve(Buffer.concat(stdout).toString('utf8')) : reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `SSH 操作失败，退出码 ${code}`)));
				child.stdin.end(stdin);
			});
		} catch (error) {
			if ((error as Error).name === 'AbortError') throw new Error(`连接或远端操作超时: ${host}`);
			throw error;
		} finally { clearTimeout(timer); }
	}

	private async runFile(host: string, command: string, path: string, timeoutMs: number): Promise<string> {
		if (!host || host.startsWith('-') || /\s/.test(host)) throw new Error('无效的 SSH 主机');
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await new Promise((resolve, reject) => {
				let settled = false;
				const finish = (error?: Error, output = '') => { if (settled) return; settled = true; error ? reject(error) : resolve(output); };
				const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${this.connectTimeoutSeconds}`, '--', host, command], {stdio: ['pipe', 'pipe', 'pipe'], signal: controller.signal});
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
				child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
				child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finish(error); });
				child.on('error', finish);
				child.on('close', code => code === 0 ? finish(undefined, Buffer.concat(stdout).toString('utf8')) : finish(new Error(Buffer.concat(stderr).toString('utf8').trim() || `SSH 操作失败，退出码 ${code}`)));
				const source = createReadStream(path);
				source.on('error', error => { child.kill(); finish(error); });
				source.pipe(child.stdin);
			});
		} catch (error) {
			if ((error as Error).name === 'AbortError') throw new Error(`上传文件超时: ${host}`);
			throw error;
		} finally { clearTimeout(timer); }
	}

	private runScript(host: string, script: string, timeoutMs: number, ...args: string[]): Promise<string> {
		return this.run(host, `sh -s --${args.length ? ` ${args.map(shellQuote).join(' ')}` : ''}`, script, timeoutMs);
	}

	private async probe(host: HostProfile): Promise<Map<string, string>> {
		return parseValues(await this.runScript(host.sshHost, claudeProbeScript, 30_000));
	}

	public async check(host: HostProfile): Promise<RemoteStatus> {
		const output = await this.run(host.sshHost, 'if [ -x "$HOME/.local/bin/cpm" ]; then exec "$HOME/.local/bin/cpm" __remote-check; else echo CPM_NOT_INSTALLED; fi', '', 90_000);
		if (output.trim() === 'CPM_NOT_INSTALLED') return {connected: true, checks: [
			{name: 'SSH 连接', state: 'PASS', value: '正常'},
			{name: 'cpm 运行时', state: 'FAIL', value: '未安装', detail: '~/.local/bin/cpm'},
		]};
		try { return JSON.parse(output) as RemoteStatus; }
		catch { throw new Error(`远端 cpm 返回了无效检查结果：${output.trim().slice(0, 500)}`); }
	}

	public async install(host: HostProfile): Promise<void> {
		await this.ensureClaude(host);
		const probe = await this.probe(host);
		if (probe.get('unsupported')) throw new Error(`cpm 不支持远端平台 ${probe.get('unsupported')}`);
		const platform = probe.get('platform') as ClaudePlatform | undefined;
		if (!platform) throw new Error('无法识别远端平台');
		const runtime = await runtimeForRemote(platform);
		try { await this.runFile(host.sshHost, `sh -c ${shellQuote(installRuntimeScript)}`, runtime.binaryPath, 10 * 60_000); }
		finally { await runtime.cleanup(); }
	}

	public async ensureClaude(host: HostProfile): Promise<{path: string; version: string; installed: boolean}> {
		const probe = await this.probe(host);
		if (probe.get('claude_path')) return {path: probe.get('claude_path')!, version: '', installed: false};
		if (probe.get('unsupported')) throw new Error(`Claude Code 不支持远端平台 ${probe.get('unsupported')}`);
		const platform = probe.get('platform') as ClaudePlatform | undefined;
		if (!platform) throw new Error('无法识别远端平台');
		const downloaded = await downloadOfficialClaude(platform);
		try {
			const output = await this.runFile(host.sshHost, `sh -c ${shellQuote(installClaudeScript)}`, downloaded.binaryPath, 10 * 60_000);
			const installed = parseValues(output);
			const path = installed.get('claude_path');
			if (!path) throw new Error('远端安装完成，但没有返回 Claude 路径');
			return {path, version: installed.get('claude_version') || downloaded.version, installed: true};
		} finally { await downloaded.cleanup(); }
	}

	public async applyConfig(host: HostProfile, password: string): Promise<void> {
		validateHost(host, true);
		if (!password || /[\r\n]/.test(password)) throw new Error('代理密码不能为空且不能包含换行');
		const username = encodeURIComponent(host.proxyUser);
		const encodedPassword = encodeURIComponent(password);
		const address = host.proxyHost.includes(':') ? `[${host.proxyHost}]` : host.proxyHost;
		const content = [
			`SOCKS5_PROXY=socks5h://${username}:${encodedPassword}@${address}:${host.proxyPort}`,
			`NO_PROXY=${host.noProxy.join(',')}`,
			'TZ=' + host.timezone,
			'LANG=' + host.locale,
			...(host.claudeConfigDir ? ['CLAUDE_CONFIG_DIR=' + host.claudeConfigDir] : []),
			'HTTP_PORT=17891',
			'',
		].join('\n');
		await this.run(host.sshHost, 'exec "$HOME/.local/bin/cpm" __remote-apply-config', content, 60_000);
	}

	public async setReplaceClaude(host: HostProfile, enabled: boolean): Promise<void> {
		await this.run(host.sshHost, `exec "$HOME/.local/bin/cpm" __remote-toggle ${enabled ? 'on' : 'off'}`, '', 60_000);
	}

	public async setup(host: HostProfile, password: string): Promise<RemoteStatus> {
		await this.install(host);
		await this.applyConfig(host, password);
		await this.setReplaceClaude(host, host.replaceClaude);
		return this.check(host);
	}
}

export const scriptsForTest = {claudeProbeScript, installClaudeScript, installRuntimeScript};
