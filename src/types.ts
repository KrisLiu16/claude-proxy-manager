export const DEFAULT_TIMEZONE = 'auto';
export const DEFAULT_LOCALE = 'auto';

export type CheckState = 'PASS' | 'WARN' | 'FAIL' | 'INFO' | 'SKIP';
export type CheckItem = {name: string; state: CheckState; value: string; detail?: string};
export type RemoteStatus = {connected: boolean; checks: CheckItem[]};

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
	if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('代理主机必须是 IPv4 地址或域名');
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('代理端口必须在 1-65535 之间');
	return {host, port, user, password};
}

function displayWidth(value: string): number {
	return [...value].reduce((width, char) => width + (/[^\u0000-\u00ff]/.test(char) ? 2 : 1), 0);
}

function pad(value: string, width: number): string {
	return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

export function checkHeader(width = 24): string {
	return `${pad('检查项', width)}  状态    结果\n${'─'.repeat(width)}  ──────  ${'─'.repeat(42)}`;
}

export function checkLine(item: CheckItem, width = 24): string {
	const state = item.state === 'PASS' ? 'OK' : item.state;
	return `${pad(item.name, width)}  ${state.padEnd(6)}  ${item.value}${item.detail ? ` (${item.detail})` : ''}`;
}

export function statusSummary(status: RemoteStatus): string {
	const nameWidth = Math.max(displayWidth('检查项'), ...status.checks.map(item => displayWidth(item.name)));
	const lines = checkHeader(nameWidth).split('\n');
	for (const item of status.checks) {
		lines.push(checkLine(item, nameWidth));
	}
	return lines.join('\n');
}
