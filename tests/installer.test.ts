import assert from 'node:assert/strict';
import {chmod, mkdtemp, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';

test('installer reports Aster-style stages and configures PATH without ANSI when piped', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cpm-installer-'));
	const home = join(root, 'home');
	const fakeBin = join(root, 'bin');
	await mkdir(home, {recursive: true});
	await mkdir(fakeBin, {recursive: true});
	const fixture = Buffer.from('#!/bin/sh\necho 9.9.9\n');
	const fixturePath = join(root, 'fixture-cpm');
	await writeFile(fixturePath, fixture, {mode: 0o755});
	const checksum = createHash('sha256').update(fixture).digest('hex');
	const fakeCurl = join(fakeBin, 'curl');
	await writeFile(fakeCurl, `#!/bin/sh
set -eu
case "$*" in
  *-fsIL*) printf 'HTTP/2 200\\r\\ncontent-length: %s\\r\\n' "$(wc -c < "$CPM_TEST_FIXTURE" | tr -d ' ')" ;;
  *checksums.txt*)
    while [ "$#" -gt 0 ]; do [ "$1" = -o ] && { shift; printf '%s  cpm-linux-x64\\n' "$CPM_TEST_SHA" > "$1"; exit 0; }; shift; done
    exit 1 ;;
  *cpm-linux-x64*)
    while [ "$#" -gt 0 ]; do [ "$1" = -o ] && { shift; cp "$CPM_TEST_FIXTURE" "$1"; exit 0; }; shift; done
    exit 1 ;;
  *) exit 1 ;;
esac
`, {mode: 0o755});
	await chmod(fakeCurl, 0o755);

	const result = spawnSync('sh', [resolve('install.sh')], {
		env: {
			...process.env,
			HOME: home,
			PATH: `${fakeBin}:${process.env.PATH}`,
			CPM_VERSION: 'v9.9.9',
			CPM_TEST_FIXTURE: fixturePath,
			CPM_TEST_SHA: checksum,
		},
		encoding: 'utf8',
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Claude Proxy Manager v9\.9\.9/);
	for (const label of ['平台', '来源', '下载', '校验', '安装', '路径', '启动']) {
		assert.match(result.stdout, new RegExp(label));
	}
	assert.equal(result.stdout.includes('\u001B'), false);
	const installed = join(home, '.local', 'bin', 'cpm');
	assert.deepEqual(await readFile(installed), fixture);
	assert.equal((await stat(installed)).mode & 0o777, 0o755);
	assert.match(await readFile(join(home, '.profile'), 'utf8'), /Claude Proxy Manager/);
});

