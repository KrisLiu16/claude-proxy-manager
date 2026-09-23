import assert from 'node:assert/strict';
import test from 'node:test';
import {containerRunArguments, parseHostUlimits, verifyVolumeIdentity, volumeAction} from '../src/isolated-sandbox.js';
import {genericTarget, proxyTarget} from '../src/proxy-runtime.js';

test('proxy defaults to Claude and accepts Codex or an explicit arbitrary command', () => {
	assert.deepEqual(proxyTarget([]), {command: 'claude', args: []});
	assert.deepEqual(proxyTarget(['--version']), {command: 'claude', args: ['--version']});
	assert.deepEqual(proxyTarget(['codex', '--version']), {command: 'codex', args: ['--version']});
	assert.deepEqual(proxyTarget(['--', 'python3', '--version']), {command: 'python3', args: ['--version']});
	assert.deepEqual(genericTarget(['--', 'sh', '-c', 'pwd']), {command: 'sh', args: ['-c', 'pwd']});
	assert.throws(() => proxyTarget(['--']), /需要指定命令/);
});

test('generic container has no host workspace or credentials and no direct network', () => {
	const args = containerRunArguments({
		image: 'cpm-workspace:test', directory: '/tmp/cpm-egress-test', name: 'cpm-test',
		volumeId: 'abc123', uid: 1000, gid: 1001, executable: 'codex', args: ['--version'],
		expectedExitIp: '203.0.113.8', terminal: false, term: 'xterm-256color',
		ulimits: ['nofile=1048576:1048576'],
		config: {
			proxyUrl: 'socks5h://alice:secret@proxy.example:8022', noProxy: 'naiveai-dev.com',
			claudeBin: '/home/ubuntu/.local/bin/claude', timezone: 'America/New_York',
			locale: 'en_US.UTF-8', claudeConfigDir: '', httpPort: 17891,
		},
	});
	const option = (flag: string) => args[args.indexOf(flag) + 1];
	assert.equal(option('--network'), 'none');
	assert.ok(args.includes('--read-only'));
	assert.equal(option('--cap-drop'), 'ALL');
	assert.ok(args.includes('no-new-privileges'));
	assert.equal(option('--user'), '1000:1001');
	assert.equal(option('--dns'), '127.0.0.1');
	assert.equal(option('--ulimit'), 'nofile=1048576:1048576');
	assert.equal(args.includes('--memory'), false);
	assert.equal(args.includes('--pids-limit'), false);
	assert.ok(args.includes('type=volume,dst=/tmp'));
	const mounts = args.flatMap((item, index) => item === '--mount' ? [args[index + 1]!] : []);
	assert.deepEqual(mounts, [
		'type=volume,dst=/tmp',
		'type=volume,src=cpm-home-abc123,dst=/home/node',
		'type=volume,src=cpm-workspace-abc123,dst=/workspace',
		'type=bind,src=/tmp/cpm-egress-test,dst=/cpm-egress,readonly',
	]);
	assert.equal(args.includes('NO_PROXY=localhost,127.0.0.1,::1'), true);
	assert.equal(args.join(' ').includes('secret'), false);
	assert.equal(args.join(' ').includes('/home/ubuntu'), false);
	assert.deepEqual(args.slice(-4), ['/usr/local/bin/cpm', '__container-run', 'codex', '--version']);
});

test('a missing persistent volume stops launch instead of silently creating an empty workspace', () => {
	assert.equal(volumeAction(false, false, false), 'create');
	assert.equal(volumeAction(false, true, true), 'adopt');
	assert.equal(volumeAction(true, true, true), 'reuse');
	assert.throws(() => volumeAction(true, false, true), /已丢失/);
	assert.throws(() => volumeAction(true, true, false), /已丢失/);
	assert.throws(() => volumeAction(false, true, false), /只剩一部分/);
	const first = {homeCreatedAt: '2026-09-23T01:00:00Z', workspaceCreatedAt: '2026-09-23T01:00:01Z'};
	assert.doesNotThrow(() => verifyVolumeIdentity(first, {...first}));
	assert.throws(() => verifyVolumeIdentity(first, {...first, workspaceCreatedAt: '2026-09-24T01:00:00Z'}), /已被替换/);
});

test('Docker inherits the host file, memory-lock, process and core limits', () => {
	const limits = [
		'Max core file size        0                    unlimited            bytes',
		'Max processes             504791               504791               processes',
		'Max open files            1048576              1048576              files',
		'Max locked memory         16551706624          16551706624          bytes',
	].join('\n');
	assert.deepEqual(parseHostUlimits(limits), [
		'core=0:-1', 'nproc=504791:504791', 'nofile=1048576:1048576', 'memlock=16551706624:16551706624',
	]);
});
