import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {localConfigPath, readLocalSettings, saveLocalSettings, setReplaceClaude} from '../src/local-setup.js';

test('local configuration stores a private proxy URL and updates only this user shell route', async () => {
	const home = await mkdtemp(join(tmpdir(), 'cpm-local-settings-'));
	const keys = ['HOME', 'XDG_STATE_HOME', 'CPM_PROXY_CONFIG', 'CPM_SOCKS5_PROXY', 'SOCKS5_PROXY', 'CPM_HTTP_PORT'] as const;
	const old = new Map(keys.map(key => [key, process.env[key]]));
	process.env.HOME = home;
	process.env.XDG_STATE_HOME = join(home, '.local', 'state');
	for (const key of ['CPM_PROXY_CONFIG', 'CPM_SOCKS5_PROXY', 'SOCKS5_PROXY', 'CPM_HTTP_PORT'] as const) delete process.env[key];
	try {
		await saveLocalSettings({proxySpec: 'proxy.example:8022:alice:pa:ss', noProxy: 'naiveai-dev.com,.naiveai-dev.com,10.0.0.0/8', timezone: 'auto', locale: 'auto', httpPort: '17891', replaceClaude: true});
		const path = localConfigPath();
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		const content = await readFile(path, 'utf8');
		assert.match(content, /SOCKS5_PROXY=socks5h:\/\/alice:pa%3Ass@proxy\.example:8022/);
		assert.match(content, /REPLACE_CLAUDE=1/);
		assert.match(await readFile(join(home, '.bashrc'), 'utf8'), /claude\(\) \{ "\$HOME\/\.local\/bin\/cpm" proxy/);
		const settings = await readLocalSettings();
		assert.equal(settings.endpoint, 'proxy.example:8022');
		assert.equal(settings.settings.proxySpec, '');
		await assert.rejects(saveLocalSettings({...settings.settings, noProxy: 'http://internal.example/path'}), /无效的白名单项/);
		assert.equal(await readFile(path, 'utf8'), content);
		await setReplaceClaude(false);
		assert.doesNotMatch(await readFile(join(home, '.bashrc'), 'utf8'), /claude\(\)/);
		assert.match(await readFile(path, 'utf8'), /REPLACE_CLAUDE=0/);
	} finally {
		for (const key of keys) {
			const value = old.get(key);
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
});
