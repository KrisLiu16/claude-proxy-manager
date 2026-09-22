import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {parseCheckOutput, scriptsForTest} from '../src/ssh.js';

test('apply script writes a private config and records the real Claude path', async () => {
	const home = await mkdtemp(join(tmpdir(), 'cpm-apply-'));
	const bin = join(home, 'bin');
	await mkdir(bin, {recursive: true});
	const claude = join(bin, 'claude');
	await writeFile(claude, '#!/bin/sh\nexit 0\n', {mode: 0o755});
	const result = spawnSync('sh', ['-c', scriptsForTest.applyScript], {
		input: 'SOCKS5_PROXY=socks5h://alice:secret@proxy.example:8022\nNO_PROXY=.internal\n',
		env: {...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`},
		encoding: 'utf8',
	});
	assert.equal(result.status, 0, result.stderr);
	const path = join(home, '.config', 'claude-proxy', 'config');
	const raw = await readFile(path, 'utf8');
	assert.match(raw, /NO_PROXY=\.internal/);
	assert.ok(raw.includes(`CLAUDE_BIN=${claude}`));
	assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('toggle script uses a PATH shim and never overwrites the real Claude binary', async () => {
	const home = await mkdtemp(join(tmpdir(), 'cpm-toggle-'));
	const realDir = join(home, '.local', 'bin');
	await mkdir(realDir, {recursive: true});
	const realClaude = join(realDir, 'claude');
	await writeFile(realClaude, 'real claude', {mode: 0o755});
	for (const mode of ['on', 'off']) {
		const result = spawnSync('sh', ['-s', '--', mode], {
			input: scriptsForTest.toggleScript,
			env: {...process.env, HOME: home},
			encoding: 'utf8',
		});
		assert.equal(result.status, 0, result.stderr);
		const profile = await readFile(join(home, '.profile'), 'utf8');
		assert.equal(profile.includes('>>> claude-proxy-manager >>>'), mode === 'on');
	}
	assert.equal(await readFile(realClaude, 'utf8'), 'real claude');
});

test('check script returns a redacted launcher error', async () => {
	const home = await mkdtemp(join(tmpdir(), 'cpm-check-'));
	const localBin = join(home, '.local', 'bin');
	const share = join(home, '.local', 'share', 'claude-proxy');
	const configDir = join(home, '.config', 'claude-proxy');
	await mkdir(localBin, {recursive: true});
	await mkdir(share, {recursive: true});
	await mkdir(configDir, {recursive: true});
	await writeFile(join(localBin, 'claude-proxy'), '#!/bin/sh\necho "bad socks5h://test-user:test-password@proxy.example:8022" >&2\nexit 3\n', {mode: 0o755});
	await writeFile(join(share, 'socks_http_bridge.py'), '# bridge\n');
	await writeFile(join(configDir, 'config'), 'SOCKS5_PROXY=socks5h://test-user:test-password@proxy.example:8022\n', {mode: 0o600});
	const result = spawnSync('sh', ['-s'], {
		input: scriptsForTest.checkScript,
		env: {...process.env, HOME: home},
		encoding: 'utf8',
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /proxy_health=FAILED/);
	const encoded = result.stdout.match(/^proxy_error_b64=(.+)$/m)?.[1];
	assert.ok(encoded);
	const diagnostic = Buffer.from(encoded, 'base64').toString('utf8');
	assert.match(diagnostic, /bad socks5h:\/\/<redacted>@proxy\.example:8022/);
	assert.equal(diagnostic.includes('test-password'), false);
	const status = parseCheckOutput(result.stdout);
	assert.equal(status.proxyHealth, 'FAILED');
	assert.match(status.proxyError, /<redacted>@proxy\.example:8022/);
	assert.equal(status.proxyError.includes('test-password'), false);
});

test('Claude probe detects a missing binary and installer places the streamed executable', async () => {
	const home = await mkdtemp(join(tmpdir(), 'cpm-claude-install-'));
	const probe = spawnSync('sh', ['-s'], {
		input: scriptsForTest.claudeProbeScript,
		env: {...process.env, HOME: home, PATH: '/usr/bin:/bin'},
		encoding: 'utf8',
	});
	assert.equal(probe.status, 0, probe.stderr);
	assert.match(probe.stdout, /^claude_path=$/m);
	assert.match(probe.stdout, /^platform=linux-(x64|arm64)(-musl)?$/m);

	const fakeClaude = '#!/bin/sh\necho "9.9.9 (Claude Code)"\n';
	const installed = spawnSync('sh', ['-c', scriptsForTest.installClaudeScript], {
		input: fakeClaude,
		env: {...process.env, HOME: home},
		encoding: 'utf8',
	});
	assert.equal(installed.status, 0, installed.stderr);
	assert.match(installed.stdout, /claude_version=9\.9\.9 \(Claude Code\)/);
	assert.equal(await readFile(join(home, '.local', 'bin', 'claude'), 'utf8'), fakeClaude);
});

test('embedded remote scripts pass syntax checks', () => {
	const launcher = resolve('assets/claude-proxy');
	const bridge = resolve('assets/socks_http_bridge.py');
	assert.equal(spawnSync('sh', ['-n', launcher]).status, 0);
	const python = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', bridge]);
	assert.equal(python.status, 0);
});
