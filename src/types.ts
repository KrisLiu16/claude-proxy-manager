export const DEFAULT_TIMEZONE = 'America/Los_Angeles';
export const DEFAULT_LOCALE = 'en_US.UTF-8';

export type HostProfile = {
	name: string;
	sshHost: string;
	proxyHost: string;
	proxyPort: number;
	proxyUser: string;
	noProxy: string[];
	replaceClaude: boolean;
	timezone: string;
	locale: string;
	claudeConfigDir: string;
};

export type CheckState = 'PASS' | 'WARN' | 'FAIL' | 'INFO' | 'SKIP';
export type CheckItem = {name: string; state: CheckState; value: string; detail?: string};
export type RemoteStatus = {connected: boolean; checks: CheckItem[]};

export function validateHost(profile: HostProfile, requireProxy = false): void {
	if (!/^[\p{L}\p{N}_.-]+$/u.test(profile.name)) throw new Error('配置名称只能包含字母、数字、点、下划线和短横线');
	if (!profile.sshHost || profile.sshHost.startsWith('-') || /\s/.test(profile.sshHost)) throw new Error('SSH 主机必须是有效的 SSH alias 或 user@host');
	if (requireProxy || profile.proxyHost || profile.proxyPort || profile.proxyUser) {
		if (!profile.proxyHost) throw new Error('代理主机不能为空');
		if (!Number.isInteger(profile.proxyPort) || profile.proxyPort < 1 || profile.proxyPort > 65_535) throw new Error('代理端口必须在 1-65535 之间');
		if (!profile.proxyUser) throw new Error('代理用户名不能为空');
	}
	for (const item of profile.noProxy) if (!item || /[\s,]/.test(item)) throw new Error(`无效的网络白名单项: ${item}`);
	if (!profile.timezone || /[\r\n=]/.test(profile.timezone)) throw new Error('时区不能为空或包含换行');
	if (!profile.locale || /[\r\n=]/.test(profile.locale)) throw new Error('locale 不能为空或包含换行');
	if (/[\r\n]/.test(profile.claudeConfigDir)) throw new Error('Claude 配置目录不能包含换行');
}

export function normalizeNoProxy(value: string | string[]): string[] {
	const items = Array.isArray(value) ? value : value.split(',');
	return [...new Set(items.map(item => item.trim()).filter(Boolean))];
}

export function parseProxySpec(spec: string): {host: string; port: number; user: string; password: string} {
	const parts = spec.trim().split(':');
	if (parts.length < 4) throw new Error('代理格式应为 HOST:PORT:USER:PASSWORD');
	const [host = '', portText = '', user = '', ...passwordParts] = parts;
	const password = passwordParts.join(':');
	const port = Number(portText);
	if (![host, user, password].every(Boolean) || /[\r\n]/.test(spec)) throw new Error('代理格式应为 HOST:PORT:USER:PASSWORD');
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('代理端口必须在 1-65535 之间');
	return {host, port, user, password};
}

function displayWidth(value: string): number {
	return [...value].reduce((width, char) => width + (/[^\u0000-\u00ff]/.test(char) ? 2 : 1), 0);
}

function pad(value: string, width: number): string {
	return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

export function statusSummary(status: RemoteStatus): string {
	const nameWidth = Math.max(displayWidth('检查项'), ...status.checks.map(item => displayWidth(item.name)));
	const lines = [`${pad('检查项', nameWidth)}  状态    结果`, `${'─'.repeat(nameWidth)}  ──────  ${'─'.repeat(42)}`];
	for (const item of status.checks) {
		const state = item.state === 'PASS' ? 'OK' : item.state;
		lines.push(`${pad(item.name, nameWidth)}  ${state.padEnd(6)}  ${item.value}${item.detail ? ` (${item.detail})` : ''}`);
	}
	return lines.join('\n');
}
