import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createConnection, createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {stopBridge} from '../src/proxy-runtime.js';

test('stopping the bridge closes open client sockets and exits', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cpm-bridge-stop-'));
	const config = join(root, 'proxy.env');
	await writeFile(config, 'SOCKS5_PROXY=socks5h://user:pass@127.0.0.1:9\n');
	const reserve = createServer();
	reserve.listen(0, '127.0.0.1');
	await once(reserve, 'listening');
	const address = reserve.address();
	assert.ok(address && typeof address !== 'string');
	const port = address.port;
	await new Promise<void>(resolve => reserve.close(() => resolve()));
	const oldState = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = root;
	const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.tsx', '__proxy-bridge', '--config', config, '--port', String(port), '--health-token', 'test-health-token'], {
		cwd: process.cwd(), env: {...process.env, XDG_STATE_HOME: root}, stdio: 'ignore',
	});
	let held: ReturnType<typeof createConnection> | undefined;
	try {
		const pidFile = join(root, 'cpm', `bridge-${port}.pid`);
		let started = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			try { started = Boolean((JSON.parse(await readFile(pidFile, 'utf8')) as {pid: number}).pid); } catch {}
			if (started) break;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		assert.equal(started, true, 'bridge did not start');
		held = createConnection(port, '127.0.0.1');
		held.on('error', () => {});
		await once(held, 'connect');
		await stopBridge(port);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				child.exitCode !== null ? Promise.resolve() : once(child, 'exit'),
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('bridge did not exit')), 5_000); }),
			]);
		} finally { if (timer) clearTimeout(timer); }
		assert.equal(child.exitCode, 0);
	} finally {
		held?.destroy();
		if (child.exitCode === null) child.kill('SIGKILL');
		if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState;
	}
});
