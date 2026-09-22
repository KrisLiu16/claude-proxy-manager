import {spawn, type ChildProcess} from 'node:child_process';
import {access, readFile} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {startEphemeralBridge, type EphemeralBridge} from './proxy-runtime.js';
import {acquireMacTimezone, type MacTimezoneLease} from './mac-timezone.js';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_ROOT = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const AUTH_HOSTS = new Set(['claude.ai', 'claude.com', 'platform.claude.com', 'console.anthropic.com']);

type SecureBrowserOptions = {
	authorizationUrl: string;
	proxyUrl: string;
	timezone: string;
	locale: string;
};

export type SecureLoginBrowser = {
	profileSource: string;
	timezoneChanged: boolean;
	originalTimezone: string;
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
	catch { throw new Error(`无效的登录环境时区：${timezone}`); }
}

export async function lastUsedChromeProfile(chromeRoot = CHROME_ROOT): Promise<string> {
	try {
		const state = JSON.parse(await readFile(join(chromeRoot, 'Local State'), 'utf8')) as {profile?: {last_used?: unknown}};
		const selected = state.profile?.last_used;
		if (typeof selected === 'string' && /^(Default|Profile \d+)$/.test(selected)) return selected;
	} catch {}
	return 'Default';
}

function processExit(child: ChildProcess): Promise<number> {
	return new Promise(resolve => {
		child.once('error', () => resolve(1));
		child.once('exit', code => resolve(code ?? 1));
	});
}

async function isChromeRunning(): Promise<boolean> {
	const child = spawn('pgrep', ['-x', 'Google Chrome'], {stdio: 'ignore'});
	return await processExit(child) === 0;
}

async function openUrlInChrome(url: string): Promise<void> {
	const child = spawn('/usr/bin/open', ['-a', 'Google Chrome', url], {stdio: 'ignore'});
	if (await processExit(child) !== 0) throw new Error('macOS 无法把 Claude 登录链接交给 Google Chrome');
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>(resolve => child.once('exit', () => resolve()));
}

export async function openSecureClaudeLogin(options: SecureBrowserOptions): Promise<SecureLoginBrowser> {
	if (process.platform !== 'darwin') throw new Error('远端 Claude 登录目前只支持 macOS');
	const authorizationUrl = validateClaudeAuthorizationUrl(options.authorizationUrl);
	validateTimezone(options.timezone);
	const locale = browserLocale(options.locale);
	try { await access(CHROME_PATH, fsConstants.X_OK); }
	catch { throw new Error('没有找到 Google Chrome，请先安装到 /Applications'); }
	if (await isChromeRunning()) {
		throw new Error('请先用 ⌘Q 完全退出 Google Chrome，再按 l 登录；否则 Chrome 会忽略本次代理参数');
	}

	let bridge: EphemeralBridge | undefined;
	let timezone: MacTimezoneLease | undefined;
	let child: ChildProcess | undefined;
	let killWithParent: (() => void) | undefined;
	try {
		const profileName = await lastUsedChromeProfile();
		bridge = await startEphemeralBridge(options.proxyUrl);
		timezone = await acquireMacTimezone(options.timezone);
		child = spawn(CHROME_PATH, [
			`--profile-directory=${profileName}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-quic',
			'--dns-prefetch-disable',
			'--disable-features=MediaRouter',
			'--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
			`--proxy-server=http://127.0.0.1:${bridge.port}`,
			'--proxy-bypass-list=<-loopback>',
			`--lang=${locale}`,
			'about:blank',
		], {
			stdio: ['ignore', 'ignore', 'pipe'],
			env: {...process.env, TZ: options.timezone, LANG: options.locale},
		});
		const stderr: Buffer[] = [];
		child.stderr?.on('data', chunk => {
			stderr.push(Buffer.from(chunk));
			if (stderr.length > 32) stderr.shift();
		});
		killWithParent = () => { if (child && child.exitCode === null) child.kill('SIGTERM'); };
		process.once('exit', killWithParent);

		await Promise.race([
			new Promise<void>(resolve => setTimeout(resolve, 1_200)),
			processExit(child).then(code => {
				const detail = Buffer.concat(stderr).toString('utf8').trim().slice(-500);
				throw new Error(detail || `Google Chrome 启动失败，退出码 ${code}`);
			}),
		]);
		await openUrlInChrome(authorizationUrl.toString());
		let closed = false;
		return {
			profileSource: profileName,
			timezoneChanged: timezone.changed,
			originalTimezone: timezone.original,
			close: async () => {
				if (closed) return;
				closed = true;
				if (killWithParent) process.off('exit', killWithParent);
				if (child && child.exitCode === null) child.kill('SIGTERM');
				if (child) await waitForExit(child);
				await bridge?.close();
				await timezone?.restore();
			},
		};
	} catch (error) {
		if (killWithParent) process.off('exit', killWithParent);
		if (child && child.exitCode === null) child.kill('SIGTERM');
		if (child) await waitForExit(child);
		await bridge?.close();
		await timezone?.restore();
		throw error;
	}
}
