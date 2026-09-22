import {constants as fsConstants} from 'node:fs';
import {spawn} from 'node:child_process';
import {access, chmod, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {inspectProxyRuntime, readRuntimeConfig, stopBridge} from './proxy-runtime.js';
import type {CheckItem, RemoteStatus} from './types.js';

const START = '# >>> cpm >>>';
const END = '# <<< cpm <<<';

function configPath(): string {
	return join(homedir(), '.config', 'cpm', 'proxy.env');
}

async function executable(path: string): Promise<boolean> {
	try { await access(path, fsConstants.X_OK); return true; } catch { return false; }
}

export async function findClaude(): Promise<string> {
	try {
		const configured = (await readRuntimeConfig()).claudeBin;
		if (configured && await executable(configured)) return configured;
	} catch {}
	const candidates = [join(homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/usr/bin/claude'];
	for (const candidate of candidates) if (await executable(candidate)) return candidate;
	for (const folder of (process.env.PATH || '').split(':')) {
		const candidate = resolve(folder || '.', 'claude');
		if (candidate.includes('/.local/share/cpm/shim-bin/')) continue;
		if (await executable(candidate)) return candidate;
	}
	return '';
}

async function stdinText(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}

export async function applyRemoteConfig(): Promise<void> {
	const incoming = await stdinText();
	if (!/^SOCKS5_PROXY=socks5h?:\/\//m.test(incoming)) throw new Error('缺少有效的 SOCKS5_PROXY');
	if (/[\0]/.test(incoming)) throw new Error('配置包含无效字符');
	const claude = await findClaude();
	if (!claude) throw new Error('Claude CLI 未安装');
	const path = configPath();
	await mkdir(dirname(path), {recursive: true, mode: 0o700});
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${incoming.trimEnd()}\nCLAUDE_BIN=${claude}\n`, {mode: 0o600});
	await chmod(temporary, 0o600);
	await rename(temporary, path);
	const config = await readRuntimeConfig();
	await stopBridge(config.httpPort);
}

function removeBlock(text: string): string {
	while (text.includes(START)) {
		const before = text.slice(0, text.indexOf(START));
		const afterStart = text.slice(text.indexOf(START) + START.length);
		const end = afterStart.indexOf(END);
		text = end < 0 ? before : `${before.trimEnd()}\n${afterStart.slice(end + END.length).trimStart()}`;
	}
	return text.trimEnd();
}

export async function toggleRemote(enabled: boolean): Promise<void> {
	const shimDir = join(homedir(), '.local', 'share', 'cpm', 'shim-bin');
	await mkdir(shimDir, {recursive: true, mode: 0o700});
	const shim = join(shimDir, 'claude');
	await writeFile(shim, '#!/bin/sh\nexec "$HOME/.local/bin/cpm" proxy "$@"\n', {mode: 0o755});
	await chmod(shim, 0o755);
	const block = `${START}
cpm_shim_dir="$HOME/.local/share/cpm/shim-bin"
case "$PATH" in
  "$cpm_shim_dir"|"$cpm_shim_dir":*) ;;
  *) export PATH="$cpm_shim_dir:$PATH" ;;
esac
unalias claude 2>/dev/null || true
unset -f claude 2>/dev/null || true
claude() { "$HOME/.local/bin/cpm" proxy "$@"; }
hash -r 2>/dev/null || true
unset cpm_shim_dir
${END}`;
	const names = ['.profile', '.bashrc', '.zshrc'];
	for (const optional of ['.bash_profile', '.bash_login']) {
		try { await access(join(homedir(), optional)); names.push(optional); } catch {}
	}
	for (const name of names) {
		const path = join(homedir(), name);
		let text = '';
		try { text = await readFile(path, 'utf8'); } catch {}
		text = removeBlock(text);
		if (enabled) text = `${text}\n\n${block}`.trimStart();
		await writeFile(path, `${text.trimEnd()}\n`);
	}
}

async function replaceEnabled(): Promise<boolean> {
	if (!await executable(join(homedir(), '.local', 'share', 'cpm', 'shim-bin', 'claude'))) return false;
	for (const name of ['.profile', '.bashrc', '.zshrc']) {
		try { if ((await readFile(join(homedir(), name), 'utf8')).includes(START)) return true; } catch {}
	}
	return false;
}

async function claudeResolution(): Promise<string> {
	const shell = process.env.SHELL || '/bin/sh';
	if (!shell.startsWith('/') || /[\r\n\0]/.test(shell)) return '';
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		return await new Promise(resolve => {
			const child = spawn(shell, ['-lic', 'command -V claude'], {stdio: ['ignore', 'pipe', 'ignore'], signal: controller.signal});
			const output: Buffer[] = [];
			child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
			child.once('error', () => resolve(''));
			child.once('close', code => resolve(code === 0 ? Buffer.concat(output).toString('utf8').trim() : ''));
		});
	} finally { clearTimeout(timer); }
}

export async function remoteStatus(): Promise<RemoteStatus> {
	let checks: CheckItem[];
	try { checks = await inspectProxyRuntime(); }
	catch (error) { checks = [{name: '运行时检查', state: 'FAIL', value: '失败', detail: (error as Error).message}]; }
	checks.unshift({name: 'SSH 连接', state: 'PASS', value: '正常'});
	const replacement = await replaceEnabled();
	checks.push({name: '默认替换', state: replacement ? 'PASS' : 'INFO', value: replacement ? '开启' : '关闭'});
	if (replacement) {
		const resolution = await claudeResolution();
		const routed = /is a (?:shell )?function|\.local\/share\/cpm\/shim-bin\/claude|\.local\/bin\/cpm["']? proxy/.test(resolution);
		checks.push({
			name: 'claude 命令解析',
			state: routed ? 'PASS' : 'FAIL',
			value: routed ? 'cpm proxy' : '仍指向原生 Claude',
			...(resolution ? {detail: resolution.replaceAll(/\s+/g, ' ').slice(0, 240)} : {detail: '登录 shell 中找不到 claude'}),
		});
	}
	return {connected: true, checks};
}

export async function remoteConfigMode(): Promise<string> {
	try { return ((await stat(configPath())).mode & 0o777).toString(8); } catch { return '-'; }
}

export async function removeTemporary(path: string): Promise<void> {
	await rm(path, {force: true});
}
