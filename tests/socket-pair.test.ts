import assert from 'node:assert/strict';
import {createConnection, createServer, type Server} from 'node:net';
import {once} from 'node:events';
import test from 'node:test';
import {pipeSockets} from '../src/socket-pair.js';

async function listen(server: Server): Promise<number> {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	return address.port;
}

test('a peer closing during a queued transfer does not crash the relay', async () => {
	const upstream = createServer(socket => socket.once('data', () => socket.destroy()));
	const upstreamPort = await listen(upstream);
	const relay = createServer(client => pipeSockets(client, createConnection(upstreamPort, '127.0.0.1')));
	const relayPort = await listen(relay);
	try {
		const client = createConnection(relayPort, '127.0.0.1');
		client.on('error', () => {});
		await once(client, 'connect');
		client.write(Buffer.alloc(1_048_576, 65));
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('relay 未关闭')), 5_000);
			client.once('close', () => { clearTimeout(timer); resolve(); });
		});
		assert.equal(client.destroyed, true);
	} finally {
		await Promise.all([new Promise<void>(resolve => relay.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
	}
});
