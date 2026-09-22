import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {VERSION} from '../src/version.js';

test('non-interactive CLI prints staged remote progress', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cpm-progress-'));
	const bin = join(root, 'bin');
	await mkdir(bin);
	await writeFile(join(bin, 'ssh'), '#!/bin/sh\necho CPM_NOT_INSTALLED\n', {mode: 0o755});
	const config = join(root, 'hosts.json');
	await writeFile(config, JSON.stringify({version: 1, hosts: [{
		name: 'dev', sshHost: 'fake-host', proxyHost: 'proxy.example', proxyPort: 8022,
		proxyUser: 'alice', noProxy: [], replaceClaude: true, timezone: 'auto', locale: 'auto', claudeConfigDir: '',
	}]}));
	const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.tsx', '--config', config, 'check', 'dev'], {
		cwd: process.cwd(),
		env: {...process.env, PATH: `${bin}:${process.env.PATH}`},
		encoding: 'utf8',
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /\[[= ]+\]\s+5% 正在通过 SSH 连接 dev/);
	assert.match(result.stderr, /15% 正在执行远端逐项检查/);
	assert.match(result.stderr, /100% 检查完成：远端尚未安装 cpm/);
});

test('setup skips Claude and cpm transfer when matching remote binaries already exist', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cpm-idempotent-'));
	const bin = join(root, 'bin');
	const home = join(root, 'home');
	const remoteHome = join(root, 'remote');
	const log = join(root, 'ssh.log');
	await mkdir(bin, {recursive: true});
	await mkdir(join(home, '.config', 'cpm'), {recursive: true});
	await mkdir(join(remoteHome, '.local', 'bin'), {recursive: true});
	await writeFile(join(remoteHome, '.local', 'bin', 'claude'), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', {mode: 0o755});
	await writeFile(join(remoteHome, '.local', 'bin', 'cpm'), `#!/bin/sh\necho "${VERSION}"\n`, {mode: 0o755});
	await writeFile(join(home, '.config', 'cpm', 'secrets.json'), JSON.stringify({dev: 'secret'}), {mode: 0o600});
	await writeFile(join(bin, 'ssh'), `#!/bin/sh
command=''
for argument in "$@"; do command=$argument; done
printf '%s\n' "$command" >> "$CPM_SSH_LOG"
case "$command" in
  'sh -s --') HOME="$CPM_REMOTE_HOME" PATH=/usr/bin:/bin /bin/sh -s -- ;;
  *'__remote-apply-config'*) cat >/dev/null ;;
  *'__remote-toggle'*) cat >/dev/null ;;
  *'__remote-check'*) cat >/dev/null; printf '%s\n' '{"connected":true,"checks":[]}' ;;
  *) cat >/dev/null; exit 9 ;;
esac
`, {mode: 0o755});
	const config = join(root, 'hosts.json');
	await writeFile(config, JSON.stringify({version: 1, hosts: [{
		name: 'dev', sshHost: 'fake-host', proxyHost: 'proxy.example', proxyPort: 8022,
		proxyUser: 'alice', noProxy: [], replaceClaude: true, timezone: 'America/New_York', locale: 'en_US.UTF-8', claudeConfigDir: '',
	}]}));
	const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.tsx', '--config', config, 'setup', 'dev'], {
		cwd: process.cwd(),
		env: {...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: `${bin}:${process.env.PATH}`, CPM_REMOTE_HOME: remoteHome, CPM_SSH_LOG: log},
		encoding: 'utf8',
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /Claude Code 9\.9\.9 \(Claude Code\)，跳过下载和上传/);
	assert.match(result.stderr, new RegExp(`cpm ${VERSION.replaceAll('.', '\\.')} 已是当前版本，跳过下载和上传`));
	assert.doesNotMatch(await readFile(log, 'utf8'), /sh -c/);
});
