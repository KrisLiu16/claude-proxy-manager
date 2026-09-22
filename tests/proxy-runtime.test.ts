import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {proxyEnvironment, readRuntimeConfig, resolveAutomaticEnvironment, socksConnect, startEphemeralBridge, type RuntimeConfig} from '../src/proxy-runtime.js';
import {saveCachedGeo, type GeoProfile} from '../src/geolocation.js';

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

test('ephemeral browser bridge listens on loopback and forwards CONNECT through SOCKS5', async () => {
	let requested = '';
	const upstream = net.createServer(socket => {
		let stage = 0;
		socket.on('data', data => {
			if (stage === 0) {
				stage = 1;
				socket.write(Buffer.from([5, 2]));
			} else if (stage === 1) {
				stage = 2;
				socket.write(Buffer.from([1, 0]));
			} else if (stage === 2) {
				const length = data[4]!;
				requested = data.subarray(5, 5 + length).toString();
				stage = 3;
				socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
			}
		});
	});
	await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
	const upstreamAddress = upstream.address();
	assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
	const bridge = await startEphemeralBridge(`socks5h://alice:secret@127.0.0.1:${upstreamAddress.port}`);
	const client = net.createConnection({host: '127.0.0.1', port: bridge.port});
	const response = new Promise<string>((resolve, reject) => {
		client.once('data', chunk => resolve(chunk.toString('latin1')));
		client.once('error', reject);
	});
	client.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
	assert.match(await response, /^HTTP\/1\.1 200/);
	assert.equal(requested, 'api.anthropic.com');
	client.destroy();
	await bridge.close();
	await new Promise<void>(resolve => upstream.close(() => resolve()));
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

test('automatic environment reuses stale cache when every geolocation API fails', async () => {
	const folder = await mkdtemp(join(tmpdir(), 'cpm-stale-geo-'));
	const previous = process.env.CPM_GEO_CACHE;
	process.env.CPM_GEO_CACHE = join(folder, 'geo.json');
	const config: RuntimeConfig = {
		proxyUrl: 'socks5h://alice:secret@proxy.example:8022',
		noProxy: '',
		claudeBin: '/opt/claude',
		timezone: 'auto',
		locale: 'auto',
		claudeConfigDir: '',
		httpPort: 17_891,
	};
	const fingerprint = createHash('sha256').update(`${config.proxyUrl}\0${config.httpPort}`).digest('hex');
	const stale: GeoProfile = {ip: '203.0.113.9', country: 'United States', countryCode: 'US', region: 'Ohio', city: 'Columbus', isp: 'Example ISP', asn: 'AS64500', timezone: 'America/New_York', languages: 'en-US', locale: 'en_US.UTF-8', source: 'ipapi.co', detectedAt: '2000-01-01T00:00:00.000Z'};
	try {
		await saveCachedGeo(fingerprint, stale);
		const result = await resolveAutomaticEnvironment(config, true, stale.ip, async () => { throw new Error('all providers unavailable'); });
		assert.equal(result.cached, true);
		assert.equal(result.geo?.city, 'Columbus');
		assert.equal(result.config.timezone, 'America/New_York');
		assert.equal(result.config.locale, 'en_US.UTF-8');
		assert.match(result.error || '', /all providers unavailable/);
	} finally {
		if (previous === undefined) delete process.env.CPM_GEO_CACHE; else process.env.CPM_GEO_CACHE = previous;
	}
});
