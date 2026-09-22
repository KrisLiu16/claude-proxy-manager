import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

test('non-interactive CLI prints staged remote progress', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cpm-progress-'));
	const bin = join(root, 'bin');
	await mkdir(bin);
	await writeFile(join(bin, 'ssh'), '#!/bin/sh\necho CPM_NOT_INSTALLED\n', {mode: 0o755});
	const config = join(root, 'hosts.json');
	await writeFile(config, JSON.stringify({version: 1, hosts: [{
		name: 'dev', sshHost: 'fake-host', proxyHost: 'proxy.example', proxyPort: 8022,
		proxyUser: 'alice', noProxy: [], replaceClaude: true, timezone: 'auto', locale: 'auto', claudeConfigDir: '',
	}]}));
	const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.tsx', '--config', config, 'check', 'dev'], {
		cwd: process.cwd(),
		env: {...process.env, PATH: `${bin}:${process.env.PATH}`},
		encoding: 'utf8',
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /\[[= ]+\]\s+5% 正在通过 SSH 连接 dev/);
	assert.match(result.stderr, /15% 正在执行远端逐项检查/);
	assert.match(result.stderr, /100% 检查完成：远端尚未安装 cpm/);
});
