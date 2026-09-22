import {constants as fsConstants} from 'node:fs';
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
	const block = `${START}\ncase ":$PATH:" in\n  *":$HOME/.local/share/cpm/shim-bin:"*) ;;\n  *) export PATH="$HOME/.local/share/cpm/shim-bin:$PATH" ;;\nesac\n${END}`;
	for (const name of ['.profile', '.bashrc', '.zshrc']) {
		const path = join(homedir(), name);
		let text = '';
		try { text = await readFile(path, 'utf8'); } catch {}
		text = removeBlock(text);
		if (enabled) text = `${text}\n\n${block}`.trimStart();
		await writeFile(path, `${text.trimEnd()}\n`);
	}
}

async function replaceEnabled(): Promise<boolean> {
	for (const name of ['.profile', '.bashrc', '.zshrc']) {
		try { if ((await readFile(join(homedir(), name), 'utf8')).includes(START)) return true; } catch {}
	}
	return false;
}

export async function remoteStatus(): Promise<RemoteStatus> {
	let checks: CheckItem[];
	try { checks = await inspectProxyRuntime(); }
	catch (error) { checks = [{name: '运行时检查', state: 'FAIL', value: '失败', detail: (error as Error).message}]; }
	checks.unshift({name: 'SSH 连接', state: 'PASS', value: '正常'});
	checks.push({name: '默认替换', state: 'PASS', value: await replaceEnabled() ? '开启' : '关闭'});
	return {connected: true, checks};
}

export async function remoteConfigMode(): Promise<string> {
	try { return ((await stat(configPath())).mode & 0o777).toString(8); } catch { return '-'; }
}

export async function removeTemporary(path: string): Promise<void> {
	await rm(path, {force: true});
}
