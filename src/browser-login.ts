import {spawn, type ChildProcess} from 'node:child_process';
import {access, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Readable, Writable} from 'node:stream';
import {startEphemeralBridge, type EphemeralBridge} from './proxy-runtime.js';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const AUTH_HOSTS = new Set(['claude.ai', 'claude.com', 'platform.claude.com', 'console.anthropic.com']);

type CdpMessage = {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: {message?: string};
	sessionId?: string;
};

type SecureBrowserOptions = {
	authorizationUrl: string;
	proxyUrl: string;
	timezone: string;
	locale: string;
};

export type SecureLoginBrowser = {
	close: () => Promise<void>;
};

export function validateClaudeAuthorizationUrl(value: string): URL {
	let url: URL;
	try { url = new URL(value); }
	catch { throw new Error('Claude 返回了无效的登录链接'); }
	const host = url.hostname.toLowerCase();
	if (url.protocol !== 'https:' || !AUTH_HOSTS.has(host) || url.username || url.password) {
		throw new Error(`拒绝打开非 Claude 官方 HTTPS 登录链接：${host || '<未知主机>'}`);
	}
	if (!url.searchParams.get('state') || !url.searchParams.get('code_challenge')) {
		throw new Error('Claude 登录链接缺少 OAuth state 或 PKCE challenge');
	}
	return url;
}

export function browserLocale(locale: string): string {
	const candidate = locale.split('.')[0]!.replaceAll('_', '-');
	try { return new Intl.Locale(candidate).toString(); }
	catch { throw new Error(`无法转换浏览器语言：${locale}`); }
}

function validateTimezone(timezone: string): void {
	try { new Intl.DateTimeFormat('en-US', {timeZone: timezone}).format(); }
	catch { throw new Error(`无法注入浏览器时区：${timezone}`); }
}

class PipeCdp {
	private nextId = 1;
	private buffer = Buffer.alloc(0);
	private readonly pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void}>();
	private readonly listeners = new Set<(message: CdpMessage) => void>();

	public constructor(private readonly input: Writable, output: Readable) {
		output.on('data', chunk => this.consume(Buffer.from(chunk)));
		output.on('error', error => this.fail(error));
		output.on('close', () => this.fail(new Error('Chrome DevTools 连接已关闭')));
	}

	public onEvent(listener: (message: CdpMessage) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
		const id = this.nextId++;
		const message = JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})});
		const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, {resolve, reject}));
		this.input.write(`${message}\0`);
		return await response;
	}

	private consume(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const end = this.buffer.indexOf(0);
			if (end < 0) return;
			const raw = this.buffer.subarray(0, end).toString('utf8');
			this.buffer = this.buffer.subarray(end + 1);
			if (!raw) continue;
			let message: CdpMessage;
			try { message = JSON.parse(raw) as CdpMessage; }
			catch { continue; }
			if (message.id) {
				const waiter = this.pending.get(message.id);
				if (!waiter) continue;
				this.pending.delete(message.id);
				if (message.error) waiter.reject(new Error(message.error.message || 'Chrome DevTools 命令失败'));
				else waiter.resolve(message.result);
			} else {
				for (const listener of this.listeners) listener(message);
			}
		}
	}

	private fail(error: Error): void {
		for (const waiter of this.pending.values()) waiter.reject(error);
		this.pending.clear();
	}
}

async function writePrivateProfile(profile: string, locale: string): Promise<void> {
	const folder = join(profile, 'Default');
	await mkdir(folder, {recursive: true, mode: 0o700});
	const preferences = {
		browser: {check_default_browser: false},
		intl: {accept_languages: `${locale},en`},
		profile: {default_content_setting_values: {
			geolocation: 2,
			media_stream_camera: 2,
			media_stream_mic: 2,
			notifications: 2,
		}},
		webrtc: {ip_handling_policy: 'disable_non_proxied_udp'},
	};
	await writeFile(join(folder, 'Preferences'), JSON.stringify(preferences), {mode: 0o600});
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>(resolve => child.once('exit', () => resolve()));
}

export async function openSecureClaudeLogin(options: SecureBrowserOptions): Promise<SecureLoginBrowser> {
	if (process.platform !== 'darwin') throw new Error('安全登录浏览器目前只支持 macOS');
	const authorizationUrl = validateClaudeAuthorizationUrl(options.authorizationUrl);
	validateTimezone(options.timezone);
	const locale = browserLocale(options.locale);
	try { await access(CHROME_PATH, fsConstants.X_OK); }
	catch { throw new Error('没有找到 Google Chrome，请先安装到 /Applications'); }

	let bridge: EphemeralBridge | undefined;
	let profile = '';
	let child: ChildProcess | undefined;
	let killWithParent: (() => void) | undefined;
	try {
		bridge = await startEphemeralBridge(options.proxyUrl);
		profile = await mkdtemp(join(tmpdir(), 'cpm-login-'));
		await writePrivateProfile(profile, locale);
		child = spawn(CHROME_PATH, [
			`--user-data-dir=${profile}`,
			'--remote-debugging-pipe',
			'--no-startup-window',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-default-apps',
			'--disable-background-networking',
			'--disable-component-update',
			'--disable-extensions',
			'--disable-sync',
			'--disable-quic',
			'--dns-prefetch-disable',
			'--disable-features=MediaRouter',
			'--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
			`--proxy-server=http://127.0.0.1:${bridge.port}`,
			'--proxy-bypass-list=<-loopback>',
			`--lang=${locale}`,
		], {stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']});
		const stderr: Buffer[] = [];
		child.stderr?.on('data', chunk => {
			stderr.push(Buffer.from(chunk));
			if (stderr.length > 32) stderr.shift();
		});
		const commandPipe = child.stdio[3] as Writable | null;
		const eventPipe = child.stdio[4] as Readable | null;
		if (!commandPipe || !eventPipe) throw new Error('无法建立 Chrome DevTools 安全管道');
		const cdp = new PipeCdp(commandPipe, eventPipe);
		killWithParent = () => { if (child && child.exitCode === null) child.kill('SIGTERM'); };
		process.once('exit', killWithParent);

		let resolvePage!: (sessionId: string) => void;
		let rejectPage!: (error: Error) => void;
		const pageReady = new Promise<string>((resolve, reject) => { resolvePage = resolve; rejectPage = reject; });
		let firstPage = false;
		cdp.onEvent(message => {
			if (message.method !== 'Target.attachedToTarget') return;
			const params = message.params as {sessionId?: string; targetInfo?: {type?: string}} | undefined;
			if (!params?.sessionId || params.targetInfo?.type !== 'page') return;
			const sessionId = params.sessionId;
			void (async () => {
				await cdp.send('Emulation.setTimezoneOverride', {timezoneId: options.timezone}, sessionId);
				await cdp.send('Emulation.setLocaleOverride', {locale}, sessionId);
				await cdp.send('Network.enable', {}, sessionId);
				await cdp.send('Network.setExtraHTTPHeaders', {headers: {'Accept-Language': `${locale},en;q=0.8`}}, sessionId);
				await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
				if (!firstPage) { firstPage = true; resolvePage(sessionId); }
			})().catch(rejectPage);
		});

		const startupFailure = new Promise<never>((_, reject) => child!.once('exit', code => {
			const detail = Buffer.concat(stderr).toString('utf8').trim().slice(-500);
			reject(new Error(detail || `Google Chrome 启动失败，退出码 ${code ?? '未知'}`));
		}));
		await Promise.race([
			cdp.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true, flatten: true}),
			startupFailure,
		]);
		await cdp.send('Target.createTarget', {url: 'about:blank'});
		const sessionId = await Promise.race([
			pageReady,
			startupFailure,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Google Chrome 页面启动超时')), 15_000)),
		]);
		await cdp.send('Page.navigate', {url: authorizationUrl.toString()}, sessionId);

		let closed = false;
		return {
			close: async () => {
				if (closed) return;
				closed = true;
				if (killWithParent) process.off('exit', killWithParent);
				try { await cdp.send('Browser.close'); } catch {}
				if (child && child.exitCode === null) child.kill('SIGTERM');
				if (child) await waitForExit(child);
				await bridge?.close();
				if (profile) await rm(profile, {recursive: true, force: true});
			},
		};
	} catch (error) {
		if (killWithParent) process.off('exit', killWithParent);
		if (child && child.exitCode === null) child.kill('SIGTERM');
		if (child) await waitForExit(child);
		await bridge?.close();
		if (profile) await rm(profile, {recursive: true, force: true});
		throw error;
	}
}
