import {Entry} from '@napi-rs/keyring';

const service = 'claude-proxy-manager';

export class SecretStore {
	private entry(name: string): Entry {
		return new Entry(service, name);
	}

	public get(name: string): string | undefined {
		return this.entry(name).getPassword() ?? undefined;
	}

	public set(name: string, password: string): void {
		this.entry(name).setPassword(password);
	}

	public delete(name: string): void {
		this.entry(name).deletePassword();
	}
}

