import {mkdir, chmod, readFile, rename, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {HostProfile} from './types.js';
import {normalizeNoProxy, validateHost} from './types.js';

type ConfigDocument = {
	version: 1;
	hosts: HostProfile[];
};

export function defaultConfigPath(): string {
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
	return join(base, 'claude-proxy-manager', 'config.json');
}

export class ProfileStore {
	public constructor(public readonly path = defaultConfigPath()) {}

	public async load(): Promise<HostProfile[]> {
		let raw: string;
		try {
			raw = await readFile(this.path, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
		const document = JSON.parse(raw) as Partial<ConfigDocument>;
		if (document.version !== 1 || !Array.isArray(document.hosts)) {
			throw new Error('不支持的配置文件版本');
		}
		const hosts = document.hosts.map(value => ({
			name: String(value.name ?? ''),
			sshHost: String(value.sshHost ?? ''),
			proxyHost: String(value.proxyHost ?? ''),
			proxyPort: Number(value.proxyPort ?? 0),
			proxyUser: String(value.proxyUser ?? ''),
			noProxy: normalizeNoProxy(value.noProxy ?? []),
			replaceClaude: Boolean(value.replaceClaude),
		}));
		for (const host of hosts) validateHost(host);
		return hosts.sort((left, right) => left.name.localeCompare(right.name));
	}

	public async save(hosts: HostProfile[]): Promise<void> {
		for (const host of hosts) validateHost(host);
		const ordered = [...hosts].sort((left, right) => left.name.localeCompare(right.name));
		const document: ConfigDocument = {version: 1, hosts: ordered};
		const folder = dirname(this.path);
		await mkdir(folder, {recursive: true, mode: 0o700});
		const temporary = join(folder, `.config.${randomUUID()}`);
		await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {mode: 0o600});
		await rename(temporary, this.path);
		await chmod(this.path, 0o600);
	}
}

