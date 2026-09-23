import {spawn} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {access, chmod, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import net, {type Socket} from 'node:net';
import {homedir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import tls from 'node:tls';
import {domainToASCII} from 'node:url';
import {statusSummary, type CheckItem, type CheckState} from './types.js';
import {VERSION} from './version.js';
import {loadCachedGeo, lookupGeoProfile, saveCachedGeo, type GeoProfile} from './geolocation.js';
import {inspectContainerPrerequisites, runIsolatedContainer} from './isolated-sandbox.js';
import {pipeSockets} from './socket-pair.js';
import {TerminalProgress, type CheckProgress} from './progress-display.js';
import {CheckStream} from './check-stream.js';

const DEFAULT_PORT = 17_891;
const DEFAULT_TIMEZONE = 'auto';
const DEFAULT_LOCALE = 'auto';
const FALLBACK_TIMEZONE = 'America/Los_Angeles';
const FALLBACK_LOCALE = 'en_US.UTF-8';
const GEO_CACHE_AGE_MS = 6 * 60 * 60 * 1_000;
const HTTP_OK = new Set([200, 400, 401, 403, 404, 405]);

export type RuntimeConfig = {
	proxyUrl: string;
	noProxy: string;
	claudeBin: string;
	timezone: string;
	locale: string;
	claudeConfigDir: string;
	httpPort: number;
};

function configPath(): string {
	return process.env.CPM_PROXY_CONFIG || join(homedir(), '.config', 'cpm', 'proxy.env');
}

function stateDir(): string {
	return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'cpm');
}

function pidPath(port: number): string {
	return join(stateDir(), `bridge-${port}.pid`);
}

function logPath(port: number): string {
	return join(stateDir(), `bridge-${port}.log`);
}

export async function readRuntimeConfig(): Promise<RuntimeConfig> {
	const values = new Map<string, string>();
	try {
		for (const raw of (await readFile(configPath(), 'utf8')).split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith('#')) continue;
			const index = line.indexOf('=');
			if (index > 0) values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const proxyUrl = process.env.CPM_SOCKS5_PROXY || values.get('SOCKS5_PROXY') || '';
	const portText = process.env.CPM_HTTP_PORT || values.get('HTTP_PORT') || String(DEFAULT_PORT);
	return {
		proxyUrl,
		noProxy: process.env.CPM_NO_PROXY ?? values.get('NO_PROXY') ?? '',
		claudeBin: process.env.CLAUDE_BIN || values.get('CLAUDE_BIN') || '',
		timezone: process.env.CPM_TZ || values.get('TZ') || DEFAULT_TIMEZONE,
		locale: process.env.CPM_LANG || values.get('LANG') || DEFAULT_LOCALE,
		claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || values.get('CLAUDE_CONFIG_DIR') || '',
		httpPort: Number(portText),
	};
}

function parseProxy(proxyUrl: string): URL {
	let parsed: URL;
	try { parsed = new URL(proxyUrl); } catch { throw new Error('SOCKS5_PROXY 格式无效'); }
	if (!['socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname || !parsed.port) {
		throw new Error('SOCKS5_PROXY 必须是 socks5h://USER:PASS@HOST:PORT');
	}
	return parsed;
}

class SocketReader {
	private data = Buffer.alloc(0);
	private waiting: (() => void) | undefined;
	private failure: Error | undefined;
	public constructor(private readonly socket: Socket) {
		socket.on('data', chunk => {
			this.data = Buffer.concat([this.data, Buffer.from(chunk)]);
			this.waiting?.();
		});
		socket.on('error', error => { this.failure = error; this.waiting?.(); });
		socket.on('end', () => { this.failure = new Error('SOCKS5 连接意外关闭'); this.waiting?.(); });
	}
	public async exact(size: number): Promise<Buffer> {
		while (this.data.length < size) {
			if (this.failure) throw this.failure;
			await new Promise<void>(resolve => { this.waiting = resolve; });
			this.waiting = undefined;
		}
		const result = this.data.subarray(0, size);
		this.data = this.data.subarray(size);
		return result;
	}
}

function connectTcp(host: string, port: number, timeoutMs = 8_000): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({host, port});
		const timer = setTimeout(() => socket.destroy(new Error(`连接 ${host}:${port} 超时`)), timeoutMs);
		socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
		socket.once('error', error => { clearTimeout(timer); reject(error); });
	});
}

export async function socksConnect(proxyUrl: string, targetHost: string, targetPort: number): Promise<Socket> {
	const proxy = parseProxy(proxyUrl);
	const socket = await connectTcp(proxy.hostname.replace(/^\[|\]$/g, ''), Number(proxy.port), 12_000);
	const reader = new SocketReader(socket);
	try {
		const username = decodeURIComponent(proxy.username);
		const password = decodeURIComponent(proxy.password);
		const user = Buffer.from(username);
		const pass = Buffer.from(password);
		if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5 用户名或密码过长');
		socket.write(username || password ? Buffer.from([5, 1, 2]) : Buffer.from([5, 1, 0]));
		const negotiation = await reader.exact(2);
		if (negotiation[0] !== 5 || negotiation[1] === 255) throw new Error('SOCKS5 不支持所需认证方式');
		if (negotiation[1] === 2) {
			socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
			const auth = await reader.exact(2);
			if (auth[1] !== 0) throw new Error('SOCKS5 用户名或密码被拒绝');
		} else if (negotiation[1] !== 0) {
			throw new Error(`SOCKS5 返回未知认证方式 ${negotiation[1]}`);
		}
		const host = Buffer.from(domainToASCII(targetHost) || targetHost, 'ascii');
		if (host.length > 255) throw new Error('目标域名过长');
		socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([targetPort >> 8, targetPort & 255])]));
		const response = await reader.exact(4);
		if (response[1] !== 0) throw new Error(`SOCKS5 CONNECT 失败，状态 ${response[1]}`);
		const addressSize = response[3] === 1 ? 4 : response[3] === 4 ? 16 : response[3] === 3 ? (await reader.exact(1))[0]! : 0;
		if (!addressSize) throw new Error('SOCKS5 返回未知地址类型');
		await reader.exact(addressSize + 2);
		socket.removeAllListeners('data');
		socket.setTimeout(0);
		return socket;
	} catch (error) {
		socket.destroy();
		throw error;
	}
}

type HttpResult = {status: number; body: string};

export async function httpsRequest(host: string, path: string, socket?: Socket): Promise<HttpResult> {
	return await new Promise((resolve, reject) => {
		const secure = tls.connect({host, port: 443, socket, servername: host, rejectUnauthorized: true});
		const timer = setTimeout(() => secure.destroy(new Error(`HTTPS ${host} 超时`)), 20_000);
		const chunks: Buffer[] = [];
		secure.once('secureConnect', () => {
			secure.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: cpm/${VERSION}\r\nConnection: close\r\n\r\n`);
		});
		secure.on('data', chunk => chunks.push(Buffer.from(chunk)));
		secure.once('error', error => { clearTimeout(timer); reject(error); });
		secure.once('end', () => {
			clearTimeout(timer);
			const raw = Buffer.concat(chunks);
			const separator = raw.indexOf('\r\n\r\n');
			const head = raw.subarray(0, separator).toString('latin1');
			let body = separator >= 0 ? raw.subarray(separator + 4) : Buffer.alloc(0);
			if (/\r\ntransfer-encoding:\s*chunked/i.test(`\r\n${head}`)) body = decodeChunked(body);
			const status = Number(head.match(/^HTTP\/\S+\s+(\d+)/)?.[1] || 0);
			resolve({status, body: body.toString('utf8').trim()});
		});
	});
}

function decodeChunked(input: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
	const chunks: Buffer<ArrayBuffer>[] = [];
	let offset = 0;
	while (offset < input.length) {
		const lineEnd = input.indexOf('\r\n', offset);
		if (lineEnd < 0) break;
		const size = Number.parseInt(input.subarray(offset, lineEnd).toString('ascii').split(';')[0] || '', 16);
		if (!Number.isFinite(size) || size < 0) break;
		offset = lineEnd + 2;
		if (size === 0) return Buffer.concat(chunks);
		if (offset + size > input.length) break;
		chunks.push(input.subarray(offset, offset + size));
		offset += size + 2;
	}
	return input;
}

async function httpProxyConnect(port: number, targetHost: string, targetPort: number): Promise<Socket> {
	const socket = await connectTcp('127.0.0.1', port, 3_000);
	return await new Promise((resolve, reject) => {
		let response = Buffer.alloc(0);
		const timer = setTimeout(() => socket.destroy(new Error('HTTP bridge CONNECT 超时')), 8_000);
		const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); };
		const onError = (error: Error) => { cleanup(); reject(error); };
		const onData = (chunk: Buffer) => {
			response = Buffer.concat([response, chunk]);
			const end = response.indexOf('\r\n\r\n');
			if (end < 0) return;
			cleanup();
			const status = Number(response.subarray(0, end).toString('latin1').match(/^HTTP\/\S+\s+(\d+)/)?.[1] || 0);
			if (status !== 200) { socket.destroy(); reject(new Error(`HTTP bridge CONNECT 返回 ${status || '无效响应'}`)); return; }
			resolve(socket);
		};
		socket.on('data', onData);
		socket.once('error', onError);
		socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
	});
}

export async function bridgedHttps(port: number, host: string, path: string): Promise<HttpResult> {
	return httpsRequest(host, path, await httpProxyConnect(port, host, 443));
}

type AutomaticResolution = {
	config: RuntimeConfig;
	geo?: GeoProfile;
	error?: string;
	cached: boolean;
	exitIp?: string;
};

export async function resolveAutomaticEnvironment(
	config: RuntimeConfig,
	force: boolean,
	knownExitIp?: string,
	lookup: typeof lookupGeoProfile = lookupGeoProfile,
): Promise<AutomaticResolution> {
	const autoTimezone = config.timezone.toLowerCase() === 'auto';
	const autoLocale = config.locale.toLowerCase() === 'auto';
	if (!force && !autoTimezone && !autoLocale) return {config, cached: false};
	const fingerprint = createHash('sha256').update(`${config.proxyUrl}\0${config.httpPort}`).digest('hex');
	try {
		let geo = force ? undefined : await loadCachedGeo(fingerprint, GEO_CACHE_AGE_MS);
		const cached = Boolean(geo);
		let exitIp = knownExitIp;
		if (!geo) {
			if (!exitIp) {
				const result = await bridgedHttps(config.httpPort, 'api.ipify.org', '/');
				if (result.status !== 200 || !result.body) throw new Error(`出口 IP 查询返回 HTTP ${result.status}`);
				exitIp = result.body;
			}
			geo = await lookup(exitIp, async (host, path) => {
				const result = await bridgedHttps(config.httpPort, host, path);
				if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
				try { return JSON.parse(result.body) as unknown; }
				catch { throw new Error('返回内容不是 JSON'); }
			});
			await saveCachedGeo(fingerprint, geo);
		}
		return {
			config: {...config, timezone: autoTimezone ? geo.timezone : config.timezone, locale: autoLocale ? geo.locale : config.locale},
			geo,
			cached,
			exitIp: exitIp || geo.ip,
		};
	} catch (error) {
		const message = (error as Error).message;
		const stale = await loadCachedGeo(fingerprint, Number.POSITIVE_INFINITY);
		if (stale) {
			return {
				config: {...config, timezone: autoTimezone ? stale.timezone : config.timezone, locale: autoLocale ? stale.locale : config.locale},
				geo: stale,
				error: message,
				cached: true,
				...(knownExitIp ? {exitIp: knownExitIp} : {exitIp: stale.ip}),
			};
		}
		return {
			config: {...config, timezone: autoTimezone ? FALLBACK_TIMEZONE : config.timezone, locale: autoLocale ? FALLBACK_LOCALE : config.locale},
			error: message,
			cached: false,
			...(knownExitIp ? {exitIp: knownExitIp} : {}),
		};
	}
}

function splitHostPort(value: string, fallback: number): [string, number] {
	if (value.startsWith('[')) {
		const end = value.indexOf(']');
		if (end < 0) throw new Error('CONNECT 地址无效');
		return [value.slice(1, end), Number(value.slice(end + 2) || fallback)];
	}
	const index = value.lastIndexOf(':');
	return index > 0 ? [value.slice(0, index), Number(value.slice(index + 1))] : [value, fallback];
}

async function readHttpHead(client: Socket): Promise<{head: Buffer; rest: Buffer}> {
	return await new Promise((resolve, reject) => {
		let data = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			data = Buffer.concat([data, chunk]);
			const index = data.indexOf('\r\n\r\n');
			if (index >= 0) {
				client.pause();
				cleanup();
				resolve({head: data.subarray(0, index), rest: data.subarray(index + 4)});
			} else if (data.length > 65_536) {
				cleanup(); reject(new Error('HTTP 请求头过大'));
			}
		};
		const onError = (error: Error) => { cleanup(); reject(error); };
		const cleanup = () => { client.off('data', onData); client.off('error', onError); };
		client.on('data', onData);
		client.once('error', onError);
	});
}

async function handleProxyClient(client: Socket, proxyUrl: string, healthToken: string, dial?: (host: string, port: number) => Promise<Socket>): Promise<void> {
	let upstream: Socket | undefined;
	client.once('close', () => upstream?.destroy());
	client.on('error', () => upstream?.destroy());
	try {
		const {head, rest} = await readHttpHead(client);
		const lines = head.toString('latin1').split('\r\n');
		const [method = '', target = '', protocol = ''] = (lines.shift() || '').split(' ');
		if (!method || !target || !protocol) throw new Error('HTTP 请求行无效');
		if (method === 'GET' && target === `http://cpm.internal/__health/${healthToken}`) {
			client.end(`HTTP/1.1 200 OK\r\nContent-Length: ${healthToken.length}\r\nConnection: close\r\n\r\n${healthToken}`);
			return;
		}
		if (method.toUpperCase() === 'CONNECT') {
			const [host, port] = splitHostPort(target, 443);
			upstream = await (dial ? dial(host, port) : socksConnect(proxyUrl, host, port));
			client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (rest.length) upstream.write(rest);
		} else {
			const url = new URL(target);
			if (url.protocol !== 'http:') throw new Error('仅支持 HTTP 绝对地址或 CONNECT');
			upstream = await (dial ? dial(url.hostname, Number(url.port || 80)) : socksConnect(proxyUrl, url.hostname, Number(url.port || 80)));
			const filtered = lines.filter(line => !/^(proxy-connection|proxy-authorization|connection|keep-alive):/i.test(line));
			if (!filtered.some(line => /^host:/i.test(line))) filtered.push('Host: ' + url.host);
			const path = `${url.pathname || '/'}${url.search}`;
			upstream.write(`${method} ${path} ${protocol}\r\n${filtered.join('\r\n')}\r\nConnection: close\r\n\r\n`);
			if (rest.length) upstream.write(rest);
		}
		pipeSockets(client, upstream);
	} catch {
		if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
		upstream?.destroy();
	}
}

export async function handleSidecarHttp(client: Socket, proxyUrl: string, dial: (host: string, port: number) => Promise<Socket>): Promise<void> {
	await handleProxyClient(client, proxyUrl, '', dial);
}

export async function runBridge(configFile: string, port: number, healthToken: string): Promise<never> {
	process.env.CPM_PROXY_CONFIG = configFile;
	const config = await readRuntimeConfig();
	parseProxy(config.proxyUrl);
	await mkdir(stateDir(), {recursive: true, mode: 0o700});
	const clients = new Set<Socket>();
	const server = net.createServer(client => {
		clients.add(client);
		client.once('close', () => clients.delete(client));
		void handleProxyClient(client, config.proxyUrl, healthToken);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	await writeFile(pidPath(port), `${JSON.stringify({pid: process.pid, token: healthToken})}\n`, {mode: 0o600});
	let closing = false;
	const stop = () => {
		if (closing) return;
		closing = true;
		for (const client of clients) client.destroy();
		server.close();
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
	await new Promise<void>(resolve => server.once('close', resolve));
	await rm(pidPath(port), {force: true});
	process.exit(0);
}

async function executable(path: string): Promise<boolean> {
	try { await access(path, fsConstants.X_OK); return true; } catch { return false; }
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

async function portOpen(port: number): Promise<boolean> {
	try { (await connectTcp('127.0.0.1', port, 1_000)).destroy(); return true; } catch { return false; }
}

async function bridgeHealthy(port: number, token: string): Promise<boolean> {
	try {
		const socket = await connectTcp('127.0.0.1', port, 1_000);
		return await new Promise<boolean>(resolve => {
			let response = '';
			const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1_000);
			socket.on('data', chunk => { response += chunk.toString('utf8'); });
			socket.once('end', () => { clearTimeout(timer); resolve(response.endsWith(token)); });
			socket.once('error', () => { clearTimeout(timer); resolve(false); });
			socket.end(`GET http://cpm.internal/__health/${token} HTTP/1.1\r\nHost: cpm.internal\r\nConnection: close\r\n\r\n`);
		});
	} catch { return false; }
}

function relaunchArgs(command: string, args: string[]): {executable: string; args: string[]} {
	const executable = process.execPath;
	if (['node', 'nodejs', 'bun'].includes(basename(executable))) {
		return {executable, args: [process.argv[1]!, command, ...args]};
	}
	return {executable, args: [command, ...args]};
}

export async function stopBridge(port = DEFAULT_PORT): Promise<void> {
	let signaledPid = 0;
	try {
		const stored = JSON.parse(await readFile(pidPath(port), 'utf8')) as {pid?: number; token?: string};
		if (Number.isInteger(stored.pid) && stored.token && processAlive(stored.pid!) && await bridgeHealthy(port, stored.token)) {
			process.kill(stored.pid!, 'SIGTERM');
			signaledPid = stored.pid!;
		}
	} catch {}
	await rm(pidPath(port), {force: true});
	if (signaledPid) {
		for (let attempt = 0; attempt < 30 && (processAlive(signaledPid) || await portOpen(port)); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		if (processAlive(signaledPid) && process.platform === 'linux') {
			try {
				const command = await readFile(`/proc/${signaledPid}/cmdline`, 'utf8');
				if (command.includes('__proxy-bridge')) process.kill(signaledPid, 'SIGKILL');
			} catch {}
		}
	}
}

export async function ensureBridge(config: RuntimeConfig): Promise<void> {
	if (!Number.isInteger(config.httpPort) || config.httpPort < 1 || config.httpPort > 65_535) throw new Error('HTTP_PORT 必须在 1-65535 之间');
	let owned = false;
	try {
		const stored = JSON.parse(await readFile(pidPath(config.httpPort), 'utf8')) as {pid?: number; token?: string};
		owned = Number.isInteger(stored.pid) && processAlive(stored.pid!) && Boolean(stored.token) && await bridgeHealthy(config.httpPort, stored.token!);
	} catch {}
	if (owned) return;
	if (await portOpen(config.httpPort)) throw new Error(`端口 ${config.httpPort} 被非 cpm 进程占用`);
	await mkdir(stateDir(), {recursive: true, mode: 0o700});
	const token = randomBytes(18).toString('hex');
	const relaunch = relaunchArgs('__proxy-bridge', ['--config', configPath(), '--port', String(config.httpPort), '--health-token', token]);
	const child = spawn(relaunch.executable, relaunch.args, {
		detached: true,
		stdio: ['ignore', 'ignore', (await import('node:fs')).openSync(logPath(config.httpPort), 'a')],
	});
	child.unref();
	for (let index = 0; index < 40; index++) {
		if (await bridgeHealthy(config.httpPort, token)) return;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`本地代理 bridge 启动失败，日志：${logPath(config.httpPort)}`);
}

export function proxyEnvironment(config: RuntimeConfig): NodeJS.ProcessEnv {
	const proxy = `http://127.0.0.1:${config.httpPort}`;
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		ALL_PROXY: proxy, all_proxy: proxy,
		HTTPS_PROXY: proxy, https_proxy: proxy,
		HTTP_PROXY: proxy, http_proxy: proxy,
		NO_PROXY: config.noProxy, no_proxy: config.noProxy,
		TZ: config.timezone,
		LANG: config.locale, LC_ALL: config.locale, LC_CTYPE: config.locale, LC_MESSAGES: config.locale,
	};
	if (config.claudeConfigDir) environment.CLAUDE_CONFIG_DIR = config.claudeConfigDir;
	return environment;
}

export async function resolvedRuntimeEnvironment(): Promise<{timezone: string; locale: string}> {
	const config = await readRuntimeConfig();
	parseProxy(config.proxyUrl);
	await ensureBridge(config);
	const resolution = await resolveAutomaticEnvironment(config, false);
	return {
		timezone: resolution.config.timezone,
		locale: resolution.config.locale,
	};
}

function row(name: string, state: CheckState, value: string, detail = ''): CheckItem {
	return {name, state, value, detail};
}

async function currentBinaryMatches(): Promise<boolean> {
	try {
		const current = await realpath(process.execPath);
		const installed = await realpath(join(homedir(), '.local', 'bin', 'cpm'));
		return current === installed;
	} catch { return false; }
}

export async function inspectProxyRuntime(target: 'claude' | 'generic' = 'claude', report?: (progress: CheckProgress) => void, onRow?: (item: CheckItem) => void): Promise<CheckItem[]> {
	const rows: CheckItem[] = [];
	const add = (item: CheckItem) => { rows.push(item); onRow?.(item); };
	report?.({percent: 2, label: '读取本机配置与 Claude 路径'});
	const config = await readRuntimeConfig();
	add(row('cpm 运行时', await currentBinaryMatches() ? 'PASS' : 'INFO', VERSION, process.execPath));
	try {
		const mode = ((await import('node:fs/promises')).stat(configPath()).then(value => (value.mode & 0o777).toString(8)));
		const actual = await mode;
		add(row('配置文件', actual === '600' ? 'PASS' : 'WARN', configPath(), `权限 ${actual}`));
	} catch { add(row('配置文件', 'FAIL', '缺失', configPath())); }
	add(row('Claude CLI', await executable(config.claudeBin) ? 'PASS' : 'FAIL', config.claudeBin || '未配置'));
	let parsed: URL | undefined;
	try {
		parsed = parseProxy(config.proxyUrl);
		add(row('SOCKS5 配置', parsed.protocol === 'socks5h:' ? 'PASS' : 'WARN', `${parsed.hostname}:${parsed.port}`, parsed.protocol === 'socks5h:' ? '远端 DNS' : '建议使用 socks5h'));
	} catch (error) { add(row('SOCKS5 配置', 'FAIL', (error as Error).message)); }
	if (parsed) {
		report?.({percent: 14, label: '连接代理网关 TCP'});
		try { const tcp = await connectTcp(parsed.hostname.replace(/^\[|\]$/g, ''), Number(parsed.port)); tcp.destroy(); add(row('代理网关 TCP', 'PASS', `${parsed.hostname}:${parsed.port}`)); }
		catch (error) { add(row('代理网关 TCP', 'FAIL', `${parsed.hostname}:${parsed.port}`, (error as Error).message)); }
		report?.({percent: 27, label: '验证 SOCKS5 认证与远端 DNS'});
		try { const socks = await socksConnect(config.proxyUrl, 'api.ipify.org', 443); socks.destroy(); add(row('SOCKS5 认证', 'PASS', '通过')); }
		catch (error) { add(row('SOCKS5 认证', 'FAIL', '失败', (error as Error).message)); }
	}
	let bridgeReady = false;
	report?.({percent: 38, label: '检查本机 HTTP bridge'});
	try { await ensureBridge(config); bridgeReady = true; add(row('内置 HTTP bridge', 'PASS', `127.0.0.1:${config.httpPort}`)); }
	catch (error) { add(row('内置 HTTP bridge', 'FAIL', '不可用', (error as Error).message)); }
	let exitIp = '';
	let exitError = '';
	if (parsed && bridgeReady) {
		report?.({percent: 52, label: '经代理查询实际出口 IP'});
		try {
			const result = await bridgedHttps(config.httpPort, 'api.ipify.org', '/');
			exitIp = result.status === 200 ? result.body : '';
			if (!exitIp) exitError = `HTTP ${result.status}`;
		} catch (error) { exitError = (error as Error).message; }
	}
	report?.({percent: 64, label: '查询出口地区、时区与语言'});
	const resolution = bridgeReady
		? await resolveAutomaticEnvironment(config, true, exitIp || undefined)
		: {
			config: {...config, timezone: config.timezone === 'auto' ? FALLBACK_TIMEZONE : config.timezone, locale: config.locale === 'auto' ? FALLBACK_LOCALE : config.locale},
			error: 'bridge 不可用',
			cached: false,
		};
	const resolved = resolution.config;
	report?.({percent: 78, label: '核对环境变量和地区设置'});
	const env = proxyEnvironment(resolved);
	const proxy = `http://127.0.0.1:${config.httpPort}`;
	for (const name of ['ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const) add(row(name, env[name] === proxy ? 'PASS' : 'FAIL', env[name] || '<空>'));
	for (const name of ['NO_PROXY', 'no_proxy'] as const) add(row(name, env[name] === config.noProxy ? 'PASS' : 'FAIL', env[name] || '<空>'));
	add(row('TZ', resolution.error && config.timezone === 'auto' ? resolution.geo ? 'WARN' : 'FAIL' : env.TZ === resolved.timezone ? 'PASS' : 'FAIL', env.TZ || '<空>', config.timezone === 'auto' ? '自动注入' : '手动配置'));
	try {
		const now = new Date();
		const short = new Intl.DateTimeFormat('en-US', {timeZone: resolved.timezone, timeZoneName: 'short'}).formatToParts(now).find(part => part.type === 'timeZoneName')?.value;
		const offset = new Intl.DateTimeFormat('en-US', {timeZone: resolved.timezone, timeZoneName: 'shortOffset'}).formatToParts(now).find(part => part.type === 'timeZoneName')?.value;
		add(row('时区实际值', 'PASS', [short, offset].filter(Boolean).join(' ')));
	} catch (error) { add(row('时区实际值', 'FAIL', '无效时区', (error as Error).message)); }
	for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES'] as const) add(row(name, resolution.error && config.locale === 'auto' ? resolution.geo ? 'WARN' : 'FAIL' : env[name] === resolved.locale ? 'PASS' : 'FAIL', env[name] || '<空>', config.locale === 'auto' ? '自动注入' : '手动配置'));
	add(row('CLAUDE_CONFIG_DIR', 'INFO', '<容器专属 HOME>', '不挂入宿主 Claude 状态'));
	if (resolution.geo) {
		const geo = resolution.geo;
		const geoDetail = resolution.error
			? `实时失败，复用旧缓存：${resolution.error}`
			: resolution.cached ? '缓存' : '实时';
		add(row('地理信息 API', resolution.error ? 'WARN' : 'PASS', geo.source, geoDetail));
		add(row('IP 归属国家', geo.country ? 'PASS' : 'WARN', [geo.country, geo.countryCode].filter(Boolean).join(' / ') || '<未知>'));
		add(row('州/地区', geo.region ? 'PASS' : 'WARN', geo.region || '<未知>'));
		add(row('城市', geo.city ? 'PASS' : 'WARN', geo.city || '<未知>'));
		add(row('ISP/组织', geo.isp ? 'PASS' : 'WARN', geo.isp || '<未知>'));
		add(row('ASN', geo.asn ? 'PASS' : 'INFO', geo.asn || '<未知>'));
		add(row('探测时区', geo.timezone ? 'PASS' : 'WARN', geo.timezone || '<未知>'));
		add(row('探测语言', geo.languages ? 'PASS' : 'INFO', geo.languages || '<API 未提供>', `locale=${geo.locale}`));
	} else {
		add(row('地理信息 API', config.timezone === 'auto' || config.locale === 'auto' ? 'FAIL' : 'WARN', '探测失败', resolution.error || '没有返回数据'));
	}
	add(row('DNS 模式', parsed?.protocol === 'socks5h:' ? 'PASS' : 'WARN', parsed?.protocol === 'socks5h:' ? 'SOCKS5H 远端解析' : '非远端解析'));
	add(row('开发机直连 IP', 'INFO', '未探测', '启动检查不从宿主机直连外网'));
	if (parsed) {
		if (exitIp) {
			const ip = exitIp;
			add(row('代理出口 IP', 'PASS', ip));
			const endpoint = parsed.hostname;
			const isAddress = net.isIP(endpoint) > 0;
			add(row('出口与节点 IP', !isAddress ? 'INFO' : ip === endpoint ? 'PASS' : 'WARN', !isAddress ? '节点使用域名' : ip === endpoint ? '一致' : '不一致', isAddress && ip !== endpoint ? `${endpoint} → ${ip}` : ''));
		} else add(row('代理出口 IP', 'FAIL', '获取失败', exitError || 'bridge 不可用'));
		if (target === 'claude') {
			report?.({percent: 90, label: '验证 Anthropic API 连通性'});
			try {
				const result = await bridgedHttps(config.httpPort, 'api.anthropic.com', '/v1/messages');
				add(row('Anthropic API', HTTP_OK.has(result.status) ? 'PASS' : 'FAIL', `HTTP ${result.status}`));
			} catch (error) { add(row('Anthropic API', 'FAIL', '不可达', (error as Error).message)); }
		} else add(row('Anthropic API', 'SKIP', '非 Claude 命令'));
	}
	report?.({percent: 100, label: '代理检查完成'});
	return rows;
}

export function formatCheckTable(rows: CheckItem[]): string {
	return statusSummary({connected: true, checks: rows});
}

export async function runProxyPreflight(
	inspect: () => Promise<CheckItem[]> = inspectProxyRuntime,
	write: (text: string) => void = text => process.stderr.write(text),
): Promise<boolean> {
	const rows = await inspect();
	write(`CPM 启动前检查\n${formatCheckTable(rows)}\n`);
	return !rows.some(item => item.state === 'FAIL');
}

async function inspectWithStreaming(target: 'claude' | 'generic', title: string, explicitCheck = false): Promise<CheckItem[]> {
	const progress = new TerminalProgress('CPM 启动检查');
	const stream = new CheckStream(title, line => {
		if (explicitCheck && !(process.stdout.isTTY && process.stderr.isTTY)) process.stdout.write(`${line}\n`);
		else progress.line(line);
	});
	stream.start();
	try {
		const proxyRows = await inspectProxyRuntime(target, update => progress.update({...update, percent: Math.round(update.percent * 0.9)}), item => stream.row(item));
		progress.update({percent: 94, label: '检查 Docker、seccomp 与 AppArmor'});
		const dockerRows = await inspectContainerPrerequisites();
		for (const item of dockerRows) stream.row(item);
		progress.update({percent: 100, label: '启动前检查完成'});
		progress.finish();
		stream.finish();
		return [...proxyRows, ...dockerRows];
	} catch (error) {
		progress.finish();
		stream.row({name: '启动检查异常', state: 'FAIL', value: (error as Error).message});
		stream.finish();
		throw error;
	} finally { progress.finish(); }
}

async function runSandboxTarget(command: string, args: string[]): Promise<number> {
	const config = await readRuntimeConfig();
	parseProxy(config.proxyUrl);
	if (!await executable(config.claudeBin)) throw new Error(`Claude CLI 不存在：${config.claudeBin || '<未配置>'}`);
	const rows = await inspectWithStreaming(command === 'claude' ? 'claude' : 'generic', 'CPM 启动前检查');
	const exitIp = rows.find(item => item.name === '代理出口 IP' && item.state === 'PASS')?.value || '';
	if (rows.some(item => item.state === 'FAIL')) {
		console.error('cpm: 启动前检查存在 FAIL，已停止启动目标命令');
		return 3;
	}
	await ensureBridge(config);
	const resolution = await resolveAutomaticEnvironment(config, false);
	if (resolution.error && (config.timezone === 'auto' || config.locale === 'auto')) {
		console.error(resolution.geo
			? `cpm: IP 地理信息实时探测失败，复用上次缓存：${resolution.error}`
				: `cpm: IP 地理信息探测失败且没有缓存：${resolution.error}`);
	}
	return await runIsolatedContainer(resolution.config, command, args, exitIp);
}

export async function runClaudeProxy(args: string[]): Promise<number> {
	if (args[0] === '--check' || args[0] === 'check') {
		const rows = await inspectWithStreaming('claude', 'CPM Claude 逐项检查', true);
		return rows.some(item => item.state === 'FAIL') ? 3 : 0;
	}
	if (args[0] === '--stop-bridge') { await stopBridge((await readRuntimeConfig()).httpPort); return 0; }
	const target = proxyTarget(args);
	return runSandboxTarget(target.command, target.args);
}

export async function runGenericSandbox(args: string[]): Promise<number> {
	const target = genericTarget(args);
	return runSandboxTarget(target.command, target.args);
}

export function proxyTarget(args: string[]): {command: string; args: string[]} {
	if (args[0] === '--') {
		if (!args[1]) throw new Error('cpm proxy -- 后需要指定命令');
		return {command: args[1], args: args.slice(2)};
	}
	if (args[0] === 'codex' || args[0] === 'claude') return {command: args[0], args: args.slice(1)};
	return {command: 'claude', args};
}

export function genericTarget(args: string[]): {command: string; args: string[]} {
	const values = args[0] === '--' ? args.slice(1) : args;
	return {command: values[0] || 'claude', args: values.slice(1)};
}
