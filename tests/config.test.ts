import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ProfileStore} from '../src/config.js';

test('profile store is mode 0600 and contains no password field', async () => {
	const folder = await mkdtemp(join(tmpdir(), 'cpm-config-'));
	const path = join(folder, 'nested', 'config.json');
	const store = new ProfileStore(path);
	await store.save([{
		name: 'dev',
		sshHost: 'cpu',
		proxyHost: 'proxy.example',
		proxyPort: 8022,
		proxyUser: 'alice',
		noProxy: ['.internal'],
		replaceClaude: true,
		timezone: 'America/Los_Angeles',
		locale: 'en_US.UTF-8',
		claudeConfigDir: '',
	}]);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	const raw = await readFile(path, 'utf8');
	assert.equal(raw.includes('password'), false);
	const loaded = await store.load();
	assert.equal(loaded[0]?.name, 'dev');
	assert.equal(loaded[0]?.replaceClaude, true);
});
