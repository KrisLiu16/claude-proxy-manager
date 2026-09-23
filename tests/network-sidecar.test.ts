import assert from 'node:assert/strict';
import {createConnection, createServer, type Socket} from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {SyntheticDns, directDestination, forbiddenDestination, startNetworkSidecar} from '../src/network-sidecar.js';

function query(name: string, type = 1): Buffer {
	const header = Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
	const labels = name.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
	const tail = Buffer.from([0, type >> 8, type & 255, 0, 1]);
	return Buffer.concat([header, ...labels, tail]);
}

class Reader {
	private bytes = Buffer.alloc(0);
	private wake: (() => void) | undefined;
	public constructor(socket: Socket) { socket.on('data', chunk => { this.bytes = Buffer.concat([this.bytes, chunk]); this.wake?.(); }); }
	public async take(length: number): Promise<Buffer> {
		while (this.bytes.length < length) await new Promise<void>(resolve => { this.wake = resolve; });
		const result = this.bytes.subarray(0, length);
		this.bytes = this.bytes.subarray(length);
		return result;
	}
}

test('synthetic DNS keeps a stable address for a name and has no IPv6 answer', () => {
	const dns = new SyntheticDns();
	const first = dns.answer(query('example.test'));
	assert.equal(first.readUInt16BE(6), 1);
	assert.equal(first.subarray(-4).join('.'), '198.18.0.1');
	assert.equal(dns.lookup('198.18.0.1'), 'example.test');
	assert.deepEqual(dns.answer(query('example.test')).subarray(-4), first.subarray(-4));
	assert.equal(dns.answer(query('example.test', 28)).readUInt16BE(6), 0);
});

test('domain whitelist includes subdomains while metadata and host loopback stay denied', () => {
	assert.equal(directDestination('aster.naiveai-dev.com', 'naiveai-dev.com'), true);
	assert.equal(directDestination('naiveai-dev.com', '.naiveai-dev.com'), true);
	assert.equal(directDestination('evilnaiveai-dev.com', 'naiveai-dev.com'), false);
	assert.equal(directDestination('10.34.8.92', '10.0.0.0/8'), true);
	for (const host of ['169.254.169.254', 'metadata.google.internal', '100.100.100.200', '127.0.0.1', 'localhost']) {
		assert.equal(forbiddenDestination(host), true);
		assert.equal(directDestination(host, '*,' + host + ',0.0.0.0/0'), false);
	}
});

test('sidecar sends raw IP and synthetic domain through configured SOCKS and rejects metadata', async () => {
	const upstreamTargets: string[] = [];
	const upstream = createServer(socket => {
		let step = 0;
		let pending = Buffer.alloc(0);
		socket.on('data', chunk => {
			pending = Buffer.concat([pending, chunk]);
			if (step === 0 && pending.length >= 2 + pending[1]!) {
				pending = pending.subarray(2 + pending[1]!);
				socket.write(Buffer.from([5, 0]));
				step = 1;
			}
			if (step === 1 && pending.length >= 5 && pending.length >= 7 + pending[4]!) {
				assert.equal(pending[3], 3);
				upstreamTargets.push(pending.subarray(5, 5 + pending[4]!).toString());
				pending = pending.subarray(7 + pending[4]!);
				socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
				step = 2;
			}
		});
	});
	await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
	const address = upstream.address();
	assert.ok(address && typeof address !== 'string');
	const directory = await mkdtemp(join(tmpdir(), 'cpm-sidecar-test-'));
	const sidecar = await startNetworkSidecar(directory, {
		proxyUrl: `socks5h://127.0.0.1:${address.port}`, noProxy: '10.0.0.0/8',
		claudeBin: '/bin/true', timezone: 'UTC', locale: 'C', claudeConfigDir: '', httpPort: 17891,
	});
	try {
		const fake = sidecar.dns.answer(query('example.test')).subarray(-4);
		for (const [target, expected] of [[fake, 'example.test'], [Buffer.from([203, 0, 113, 42]), '203.0.113.42']] as const) {
			const socket = createConnection(join(directory, 'socks.sock'));
			const reader = new Reader(socket);
			socket.write(Buffer.from([5, 1, 0]));
			assert.deepEqual(await reader.take(2), Buffer.from([5, 0]));
			socket.write(Buffer.concat([Buffer.from([5, 1, 0, 1]), target, Buffer.from([0, 80])]));
			assert.equal((await reader.take(10))[1], 0);
			assert.equal(upstreamTargets.at(-1), expected);
			socket.destroy();
		}
		const metadata = createConnection(join(directory, 'socks.sock'));
		const reader = new Reader(metadata);
		metadata.write(Buffer.from([5, 1, 0]));
		await reader.take(2);
		metadata.write(Buffer.from([5, 1, 0, 1, 169, 254, 169, 254, 0, 80]));
		assert.equal((await reader.take(10))[1], 2);
		assert.deepEqual(upstreamTargets, ['example.test', '203.0.113.42']);
		metadata.destroy();
	} finally {
		await sidecar.close();
		await new Promise<void>(resolve => upstream.close(() => resolve()));
		await rm(directory, {recursive: true, force: true});
	}
});
