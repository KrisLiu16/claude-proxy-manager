import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {downloadOfficialClaude} from '../src/official-claude.js';

test('official Claude downloader follows npm platform metadata and verifies sha512', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cpm-official-'));
	const packageDir = join(root, 'source', 'package');
	await mkdir(packageDir, {recursive: true});
	const binary = Buffer.from('#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
	await writeFile(join(packageDir, 'claude'), binary, {mode: 0o755});
	const archive = join(root, 'claude.tgz');
	const packed = spawnSync('tar', ['-czf', archive, '-C', join(root, 'source'), 'package']);
	assert.equal(packed.status, 0, packed.stderr?.toString());
	const tarball = await readFile(archive);
	const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;

	const server = createServer((request, response) => {
		const path = request.url ?? '';
		response.setHeader('content-type', 'application/json');
		if (path === '/@anthropic-ai%2Fclaude-code/latest') {
			response.end(JSON.stringify({
				version: '9.9.9',
				optionalDependencies: {'@anthropic-ai/claude-code-linux-x64': '9.9.9'},
			}));
			return;
		}
		if (path === '/@anthropic-ai%2Fclaude-code-linux-x64/9.9.9') {
			response.end(JSON.stringify({
				dist: {tarball: `http://127.0.0.1:${(server.address() as {port: number}).port}/claude.tgz`, integrity},
			}));
			return;
		}
		if (path === '/claude.tgz') {
			response.setHeader('content-type', 'application/octet-stream');
			response.end(tarball);
			return;
		}
		response.statusCode = 404;
		response.end('{}');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const port = (server.address() as {port: number}).port;
		const downloaded = await downloadOfficialClaude('linux-x64', `http://127.0.0.1:${port}`);
		try {
			assert.equal(downloaded.version, '9.9.9');
			assert.equal(downloaded.packageName, '@anthropic-ai/claude-code-linux-x64');
			assert.deepEqual(await readFile(downloaded.binaryPath), binary);
		} finally {
			await downloaded.cleanup();
		}
	} finally {
		server.close();
	}
});

