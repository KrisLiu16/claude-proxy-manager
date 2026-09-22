import {chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';

function defaultPath(): string {
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
	return join(base, 'claude-proxy-manager', 'secrets.json');
}

export class SecretStore {
	public constructor(private readonly path = defaultPath()) {}

	private load(): Record<string, string> {
		try {
			return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
			throw error;
		}
	}

	private save(values: Record<string, string>): void {
		const folder = dirname(this.path);
		mkdirSync(folder, {recursive: true, mode: 0o700});
		const temporary = join(folder, `.secrets.${randomUUID()}`);
		writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, {mode: 0o600});
		renameSync(temporary, this.path);
		chmodSync(this.path, 0o600);
	}

	public get(name: string): string | undefined {
		return this.load()[name];
	}

	public set(name: string, password: string): void {
		this.save({...this.load(), [name]: password});
	}

	public delete(name: string): void {
		const values = this.load();
		delete values[name];
		this.save(values);
	}
}
