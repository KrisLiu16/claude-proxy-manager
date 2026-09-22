import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {scriptsForTest} from '../src/ssh.js';
import {toggleRemote} from '../src/remote.js';
import {VERSION} from '../src/version.js';

test('remote toggle creates a cpm proxy shim and edits shell files', async () => {
	const home = await mkdtemp(join(tmpdir(), 'cpm-toggle-'));
	const previous = process.env.HOME;
	process.env.HOME = home;
	try {
		await toggleRemote(true);
		const shim = join(home, '.local', 'share', 'cpm', 'shim-bin', 'claude');
		assert.equal((await stat(shim)).mode & 0o777, 0o755);
		assert.match(await readFile(shim, 'utf8'), /\.local\/bin\/cpm" proxy/);
		assert.match(await readFile(join(home, '.profile'), 'utf8'), />>> cpm >>>/);
		await toggleRemote(false);
		assert.doesNotMatch(await readFile(join(home, '.profile'), 'utf8'), />>> cpm >>>/);
	} finally {
		if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
	}
});

test('Claude probe detects a missing binary and installer places the streamed executable', async () => {
	const home = await mkdtemp(join(tmpdir(), 'cpm-claude-install-'));
	const probe = spawnSync('sh', ['-s'], {input: scriptsForTest.claudeProbeScript, env: {...process.env, HOME: home, PATH: '/usr/bin:/bin'}, encoding: 'utf8'});
	assert.equal(probe.status, 0, probe.stderr);
	assert.match(probe.stdout, /^claude_path=$/m);
	assert.match(probe.stdout, /^cpm_path=$/m);
	assert.match(probe.stdout, /^cpm_version=$/m);
	assert.match(probe.stdout, /^platform=linux-(x64|arm64)(-musl)?$/m);
	const fakeClaude = '#!/bin/sh\necho "9.9.9 (Claude Code)"\n';
	const installed = spawnSync('sh', ['-c', scriptsForTest.installClaudeScript], {input: fakeClaude, env: {...process.env, HOME: home}, encoding: 'utf8'});
	assert.equal(installed.status, 0, installed.stderr);
	assert.match(installed.stdout, /claude_version=9\.9\.9 \(Claude Code\)/);
	assert.equal(await readFile(join(home, '.local', 'bin', 'claude'), 'utf8'), fakeClaude);
	await writeFile(join(home, '.local', 'bin', 'cpm'), `#!/bin/sh\necho "${VERSION}"\n`, {mode: 0o755});
	const installedProbe = spawnSync('sh', ['-s'], {input: scriptsForTest.claudeProbeScript, env: {...process.env, HOME: home, PATH: '/usr/bin:/bin'}, encoding: 'utf8'});
	assert.equal(installedProbe.status, 0, installedProbe.stderr);
	assert.match(installedProbe.stdout, /^claude_version=9\.9\.9 \(Claude Code\)$/m);
	assert.match(installedProbe.stdout, new RegExp(`^cpm_version=${VERSION.replaceAll('.', '\\.')}$`, 'm'));
});

test('runtime installer accepts one cpm executable and installs no launcher or bridge asset', async () => {
	const home = await mkdtemp(join(tmpdir(), 'cpm-runtime-install-'));
	await mkdir(join(home, '.local', 'bin'), {recursive: true});
	const fakeCpm = '#!/bin/sh\n[ "$1" = "--version" ] && echo 0.3.0\n';
	const installed = spawnSync('sh', ['-c', scriptsForTest.installRuntimeScript], {input: fakeCpm, env: {...process.env, HOME: home}, encoding: 'utf8'});
	assert.equal(installed.status, 0, installed.stderr);
	assert.equal(await readFile(join(home, '.local', 'bin', 'cpm'), 'utf8'), fakeCpm);
	assert.deepEqual(await readdir(join(home, '.local', 'bin')), ['cpm']);
});
