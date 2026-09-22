export type HostProfile = {
	name: string;
	sshHost: string;
	proxyHost: string;
	proxyPort: number;
	proxyUser: string;
	noProxy: string[];
	replaceClaude: boolean;
};

export type RemoteStatus = {
	connected: boolean;
	launcher: boolean;
	bridge: boolean;
	config: boolean;
	configMode: string;
	proxyConfigured: boolean;
	realClaude: string;
	replaceClaude: boolean;
	noProxy: string;
	proxyHealth: string;
};

export function validateHost(profile: HostProfile, requireProxy = false): void {
	if (!/^[\p{L}\p{N}_.-]+$/u.test(profile.name)) {
		throw new Error('配置名称只能包含字母、数字、点、下划线和短横线');
	}
	if (!profile.sshHost || profile.sshHost.startsWith('-') || /\s/.test(profile.sshHost)) {
		throw new Error('SSH 主机必须是有效的 SSH alias 或 user@host');
	}
	if (requireProxy || profile.proxyHost || profile.proxyPort || profile.proxyUser) {
		if (!profile.proxyHost) throw new Error('代理主机不能为空');
		if (!Number.isInteger(profile.proxyPort) || profile.proxyPort < 1 || profile.proxyPort > 65_535) {
			throw new Error('代理端口必须在 1-65535 之间');
		}
		if (!profile.proxyUser) throw new Error('代理用户名不能为空');
	}
	for (const item of profile.noProxy) {
		if (!item || /[\s,]/.test(item)) throw new Error(`无效的网络白名单项: ${item}`);
	}
}

export function normalizeNoProxy(value: string | string[]): string[] {
	const items = Array.isArray(value) ? value : value.split(',');
	return [...new Set(items.map(item => item.trim()).filter(Boolean))];
}

export function parseProxySpec(spec: string): {
	host: string;
	port: number;
	user: string;
	password: string;
} {
	const parts = spec.trim().split(':');
	if (parts.length < 4) throw new Error('代理格式应为 HOST:PORT:USER:PASSWORD');
	const [host = '', portText = '', user = '', ...passwordParts] = parts;
	const password = passwordParts.join(':');
	const port = Number(portText);
	if (![host, user, password].every(Boolean) || /[\r\n]/.test(spec)) {
		throw new Error('代理格式应为 HOST:PORT:USER:PASSWORD');
	}
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error('代理端口必须在 1-65535 之间');
	}
	return {host, port, user, password};
}

export function statusSummary(status: RemoteStatus): string {
	const yn = (value: boolean) => (value ? '是' : '否');
	return [
		`连接=${yn(status.connected)}`,
		`启动器=${yn(status.launcher)}`,
		`配置=${yn(status.config)}(${status.configMode})`,
		`代理=${status.proxyHealth}`,
		`默认替换=${yn(status.replaceClaude)}`,
		`白名单=${status.noProxy || '<空>'}`,
	].join('  ');
}

