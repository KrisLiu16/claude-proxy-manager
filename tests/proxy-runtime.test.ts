import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {proxyEnvironment, readRuntimeConfig, socksConnect} from '../src/proxy-runtime.js';

test('integrated SOCKS5 client authenticates and requests remote DNS target', async () => {
	let requested = '';
	const server = net.createServer(socket => {
		let stage = 0;
		socket.on('data', data => {
			if (stage === 0) {
				assert.deepEqual([...data], [5, 1, 2]);
				stage = 1;
				socket.write(Buffer.from([5, 2]));
			} else if (stage === 1) {
				const userLength = data[1]!;
				const passwordLength = data[2 + userLength]!;
				assert.equal(data.subarray(2, 2 + userLength).toString(), 'alice');
				assert.equal(data.subarray(3 + userLength, 3 + userLength + passwordLength).toString(), 'secret');
				stage = 2;
				socket.write(Buffer.from([1, 0]));
			} else if (stage === 2) {
				assert.equal(data[3], 3);
				const length = data[4]!;
				requested = data.subarray(5, 5 + length).toString();
				assert.equal(data.readUInt16BE(5 + length), 443);
				stage = 3;
				socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
			} else {
				socket.write(data);
			}
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	const socket = await socksConnect(`socks5h://alice:secret@127.0.0.1:${address.port}`, 'api.anthropic.com', 443);
	assert.equal(requested, 'api.anthropic.com');
	const echoed = new Promise<Buffer>(resolve => socket.once('data', resolve));
	socket.write('ping');
	assert.equal((await echoed).toString(), 'ping');
	socket.destroy();
	await new Promise<void>(resolve => server.close(() => resolve()));
});

test('runtime config reproduces every Claude proxy environment variable on port 17891', async () => {
	const home = await mkdtemp(join(tmpdir(), 'cpm-proxy-config-'));
	await mkdir(join(home, '.config', 'cpm'), {recursive: true});
	await writeFile(join(home, '.config', 'cpm', 'proxy.env'), [
		'SOCKS5_PROXY=socks5h://alice:secret@proxy.example:8022',
		'NO_PROXY=localhost,.internal',
		'CLAUDE_BIN=/opt/claude',
		'TZ=America/Los_Angeles',
		'LANG=en_US.UTF-8',
		'CLAUDE_CONFIG_DIR=/workspace/claude-home',
		'HTTP_PORT=17891',
	].join('\n'));
	const keys = ['HOME', 'CPM_PROXY_CONFIG', 'CPM_SOCKS5_PROXY', 'SOCKS5_PROXY', 'CPM_HTTP_PORT'] as const;
	const previous = new Map(keys.map(key => [key, process.env[key]]));
	process.env.HOME = home;
	delete process.env.CPM_PROXY_CONFIG;
	delete process.env.CPM_SOCKS5_PROXY;
	delete process.env.SOCKS5_PROXY;
	delete process.env.CPM_HTTP_PORT;
	try {
		const config = await readRuntimeConfig();
		assert.equal(config.httpPort, 17_891);
		const env = proxyEnvironment(config);
		for (const key of ['ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) assert.equal(env[key], 'http://127.0.0.1:17891');
		assert.equal(env.NO_PROXY, 'localhost,.internal');
		assert.equal(env.no_proxy, 'localhost,.internal');
		assert.equal(env.TZ, 'America/Los_Angeles');
		for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES']) assert.equal(env[key], 'en_US.UTF-8');
		assert.equal(env.CLAUDE_CONFIG_DIR, '/workspace/claude-home');
	} finally {
		for (const key of keys) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
});
