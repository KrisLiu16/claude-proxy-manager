import assert from 'node:assert/strict';
import test from 'node:test';
import {containerRunArguments} from '../src/isolated-sandbox.js';
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
	const mounts = args.flatMap((item, index) => item === '--mount' ? [args[index + 1]!] : []);
	assert.deepEqual(mounts, [
		'type=volume,src=cpm-home-abc123,dst=/home/node',
		'type=volume,src=cpm-workspace-abc123,dst=/workspace',
		'type=bind,src=/tmp/cpm-egress-test,dst=/cpm-egress,readonly',
	]);
	assert.equal(args.includes('NO_PROXY=localhost,127.0.0.1,::1'), true);
	assert.equal(args.join(' ').includes('secret'), false);
	assert.equal(args.join(' ').includes('/home/ubuntu'), false);
	assert.deepEqual(args.slice(-4), ['/usr/local/bin/cpm', '__container-run', 'codex', '--version']);
});
