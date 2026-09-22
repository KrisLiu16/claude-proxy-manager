import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import type {HostProfile, RemoteStatus} from './types.js';
import {validateHost} from './types.js';
import {downloadOfficialClaude, type ClaudePlatform} from './official-claude.js';
import {runtimeForRemote} from './runtime-distribution.js';

export type OperationProgress = {percent: number; label: string};
export type ProgressReporter = (progress: OperationProgress) => void;

function report(reporter: ProgressReporter | undefined, percent: number, label: string): void {
	reporter?.({percent: Math.max(0, Math.min(100, Math.round(percent))), label});
}

function scoped(reporter: ProgressReporter | undefined, start: number, end: number): ProgressReporter | undefined {
	if (!reporter) return undefined;
	return progress => reporter({percent: start + Math.round((end - start) * progress.percent / 100), label: progress.label});
}

function transferLabel(label: string, received: number, total: number): string {
	const mib = (value: number) => (value / 1_048_576).toFixed(1);
	return total > 0 ? `${label} ${mib(received)} / ${mib(total)} MiB` : `${label} ${mib(received)} MiB`;
}

function transferReporter(reporter: ProgressReporter | undefined, start: number, end: number, label: string): (received: number, total: number) => void {
	let lastPercent = -1;
	return (received, total) => {
		const percent = Math.round(total > 0 ? start + (end - start) * received / total : start);
		if (percent === lastPercent) return;
		lastPercent = percent;
		report(reporter, percent, transferLabel(label, received, total));
	};
}

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

	private async runFile(host: string, command: string, path: string, timeoutMs: number, progress?: (sent: number, total: number) => void): Promise<string> {
		if (!host || host.startsWith('-') || /\s/.test(host)) throw new Error('无效的 SSH 主机');
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const total = (await stat(path)).size;
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
				let sent = 0;
				let lastPercent = -1;
				source.on('data', chunk => {
					sent += chunk.length;
					const percent = total > 0 ? Math.floor(sent * 100 / total) : 0;
					if (percent !== lastPercent) { lastPercent = percent; progress?.(sent, total); }
				});
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

	public async check(host: HostProfile, reporter?: ProgressReporter): Promise<RemoteStatus> {
		report(reporter, 5, `正在通过 SSH 连接 ${host.name}`);
		report(reporter, 15, '正在执行远端逐项检查（出口 IP、时区、地理信息）');
		const output = await this.run(host.sshHost, 'if [ -x "$HOME/.local/bin/cpm" ]; then exec "$HOME/.local/bin/cpm" __remote-check; else echo CPM_NOT_INSTALLED; fi', '', 90_000);
		if (output.trim() === 'CPM_NOT_INSTALLED') {
			report(reporter, 100, '检查完成：远端尚未安装 cpm');
			return {connected: true, checks: [
			{name: 'SSH 连接', state: 'PASS', value: '正常'},
			{name: 'cpm 运行时', state: 'FAIL', value: '未安装', detail: '~/.local/bin/cpm'},
			]};
		}
		try {
			const status = JSON.parse(output) as RemoteStatus;
			report(reporter, 100, '远端逐项检查完成');
			return status;
		}
		catch { throw new Error(`远端 cpm 返回了无效检查结果：${output.trim().slice(0, 500)}`); }
	}

	private async installSteps(host: HostProfile, reporter?: ProgressReporter): Promise<void> {
		await this.ensureClaude(host, scoped(reporter, 0, 52));
		report(reporter, 56, '正在确认开发机平台');
		const probe = await this.probe(host);
		if (probe.get('unsupported')) throw new Error(`cpm 不支持远端平台 ${probe.get('unsupported')}`);
		const platform = probe.get('platform') as ClaudePlatform | undefined;
		if (!platform) throw new Error('无法识别远端平台');
		report(reporter, 64, `正在准备 ${platform} 的 cpm 运行时`);
		const runtime = await runtimeForRemote(platform, transferReporter(reporter, 64, 76, '正在下载并校验 cpm'));
		try {
			report(reporter, 78, '正在通过 SSH 上传并校验 cpm');
			await this.runFile(host.sshHost, `sh -c ${shellQuote(installRuntimeScript)}`, runtime.binaryPath, 10 * 60_000, transferReporter(reporter, 78, 98, '正在通过 SSH 上传 cpm'));
			report(reporter, 100, 'Claude 与 cpm 运行时已就绪');
		}
		finally { await runtime.cleanup(); }
	}

	public async install(host: HostProfile, reporter?: ProgressReporter): Promise<void> {
		await this.installSteps(host, reporter);
	}

	public async ensureClaude(host: HostProfile, reporter?: ProgressReporter): Promise<{path: string; version: string; installed: boolean}> {
		report(reporter, 5, '正在检查开发机上的 Claude Code');
		const probe = await this.probe(host);
		if (probe.get('claude_path')) {
			report(reporter, 100, '开发机已安装 Claude Code');
			return {path: probe.get('claude_path')!, version: '', installed: false};
		}
		if (probe.get('unsupported')) throw new Error(`Claude Code 不支持远端平台 ${probe.get('unsupported')}`);
		const platform = probe.get('platform') as ClaudePlatform | undefined;
		if (!platform) throw new Error('无法识别远端平台');
		report(reporter, 22, `正在下载并校验官方 Claude Code（${platform}）`);
		const downloaded = await downloadOfficialClaude(platform, 'https://registry.npmjs.org', transferReporter(reporter, 22, 64, '正在下载官方 Claude Code'));
		try {
			report(reporter, 68, '正在通过 SSH 上传并校验 Claude Code');
			const output = await this.runFile(host.sshHost, `sh -c ${shellQuote(installClaudeScript)}`, downloaded.binaryPath, 10 * 60_000, transferReporter(reporter, 68, 98, '正在通过 SSH 上传 Claude Code'));
			const installed = parseValues(output);
			const path = installed.get('claude_path');
			if (!path) throw new Error('远端安装完成，但没有返回 Claude 路径');
			report(reporter, 100, `Claude Code ${installed.get('claude_version') || downloaded.version} 安装完成`);
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

	public async setup(host: HostProfile, password: string, reporter?: ProgressReporter): Promise<RemoteStatus> {
		await this.installSteps(host, scoped(reporter, 0, 70));
		report(reporter, 76, '正在写入代理、白名单、时区和语言配置');
		await this.applyConfig(host, password);
		report(reporter, 84, `正在${host.replaceClaude ? '开启' : '关闭'} claude → cpm proxy`);
		await this.setReplaceClaude(host, host.replaceClaude);
		report(reporter, 90, '正在验证代理出口和完整运行环境');
		const status = await this.check(host, scoped(reporter, 90, 100));
		report(reporter, 100, '安装、配置和验证全部完成');
		return status;
	}
}

export const scriptsForTest = {claudeProbeScript, installClaudeScript, installRuntimeScript};
