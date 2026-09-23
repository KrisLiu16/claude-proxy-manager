import {spawn} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {startNetworkSidecar} from './network-sidecar.js';
import type {RuntimeConfig} from './proxy-runtime.js';
import {VERSION} from './version.js';
import type {CheckItem} from './types.js';

// Multi-architecture index digest; a local image digest would fail on fresh machines.
const BASE_IMAGE = 'node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6';
const DOCKERFILE = `FROM ${BASE_IMAGE}
ARG CPM_TZ
ARG CPM_LOCALE
ARG CPM_UID
ARG CPM_GID
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client python3 python3-venv python3-pip locales tzdata && rm -rf /var/lib/apt/lists/*
RUN set -eu; test -f "/usr/share/zoneinfo/$CPM_TZ"; cp "/usr/share/zoneinfo/$CPM_TZ" /etc/localtime; printf '%s\\n' "$CPM_TZ" > /etc/timezone; if [ "$CPM_LOCALE" != C.UTF-8 ]; then locale_base=$(printf '%s' "$CPM_LOCALE" | cut -d. -f1); localedef -i "$locale_base" -f UTF-8 "$CPM_LOCALE"; fi
RUN set -eu; if [ "$(id -g node)" != "$CPM_GID" ]; then groupmod -g "$CPM_GID" node; fi; if [ "$(id -u node)" != "$CPM_UID" ]; then usermod -u "$CPM_UID" -g "$CPM_GID" node; fi; mkdir -p /workspace /home/node/.local; chown -R "$CPM_UID:$CPM_GID" /workspace /home/node
COPY cpm /usr/local/bin/cpm
COPY claude /usr/local/bin/claude
RUN chmod 755 /usr/local/bin/cpm /usr/local/bin/claude
ENV HOME=/home/node
ENV PATH=/home/node/.local/node_modules/.bin:/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin
USER node
WORKDIR /workspace
`;

function selfBinary(): string {
	const override = process.env.CPM_SELF_BINARY;
	if (override) return override;
	if (['node', 'nodejs', 'bun'].includes(basename(process.execPath))) throw new Error('容器镜像需要 cpm 单文件二进制；开发模式请设置 CPM_SELF_BINARY');
	return process.execPath;
}

type CommandResult = {code: number; stdout: string; stderr: string};

async function command(program: string, args: string[], options: {cwd?: string; inherit?: boolean; onOutput?: ((line: string) => void) | undefined} = {}): Promise<CommandResult> {
	return await new Promise((resolve, reject) => {
		const child = spawn(program, args, {cwd: options.cwd, stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout?.on('data', chunk => { out.push(Buffer.from(chunk)); options.onOutput?.(Buffer.from(chunk).toString('utf8').trim().split('\n').at(-1) || ''); });
		child.stderr?.on('data', chunk => { err.push(Buffer.from(chunk)); options.onOutput?.(Buffer.from(chunk).toString('utf8').trim().split('\n').at(-1) || ''); });
		child.once('error', reject);
		child.once('exit', code => resolve({code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8')}));
	});
}

let dockerAccess: 'direct' | 'sudo' | undefined;

async function docker(args: string[], options: {cwd?: string; inherit?: boolean; onOutput?: ((line: string) => void) | undefined} = {}): Promise<CommandResult> {
	if (!dockerAccess) {
		const probe = ['version', '--format', '{{.Server.Version}}'];
		const direct = await command('docker', probe).catch(error => ({code: 1, stdout: '', stderr: (error as Error).message}));
		if (direct.code === 0) dockerAccess = 'direct';
		else {
			const elevated = await command('sudo', ['-n', 'docker', ...probe]).catch(error => ({code: 1, stdout: '', stderr: (error as Error).message}));
			if (elevated.code === 0) dockerAccess = 'sudo';
			else throw new Error(`Docker 不可用：${direct.stderr.trim() || elevated.stderr.trim()}`);
		}
	}
	return dockerAccess === 'sudo' ? command('sudo', ['-n', 'docker', ...args], options) : command('docker', args, options);
}

function validatedRegion(config: RuntimeConfig): void {
	if (!/^[A-Za-z0-9_+\-/]+$/.test(config.timezone) || config.timezone.includes('..')) throw new Error('沙箱时区格式无效');
	if (!/^(?:[A-Za-z]{2,3}_[A-Za-z]{2,3}|C)\.UTF-8$/.test(config.locale)) throw new Error('沙箱 locale 必须是 UTF-8 语言地区代码');
}

export async function inspectContainerPrerequisites(): Promise<CheckItem[]> {
	if (process.platform !== 'linux') return [{name: '独立容器', state: 'FAIL', value: '目前只支持 Linux 开发机'}];
	let version: CommandResult;
	try { version = await docker(['version', '--format', '{{.Server.Version}}']); }
	catch (error) { return [{name: 'Docker 服务', state: 'FAIL', value: (error as Error).message}]; }
	if (version.code !== 0) return [{name: 'Docker 服务', state: 'FAIL', value: version.stderr.trim() || '不可用'}];
	const security = await docker(['info', '--format', '{{json .SecurityOptions}}']);
	const options = security.code === 0 ? security.stdout : '';
	return [
		{name: 'Docker 服务', state: 'PASS', value: version.stdout.trim()},
		{name: 'seccomp', state: options.includes('name=seccomp') ? 'PASS' : 'FAIL', value: options.includes('name=seccomp') ? '已启用' : '未启用'},
		{name: 'AppArmor', state: options.includes('name=apparmor') ? 'PASS' : 'FAIL', value: options.includes('name=apparmor') ? '已启用' : '未启用'},
	];
}

export async function prepareDockerEngine(onOutput?: (line: string) => void): Promise<void> {
	if (process.platform !== 'linux') throw new Error('独立容器目前只支持 Linux 开发机');
	if (!(await inspectContainerPrerequisites()).some(item => item.name === 'Docker 服务' && item.state === 'FAIL')) return;
	const release = await readFile('/etc/os-release', 'utf8');
	if (!/^ID=(?:ubuntu|debian)$/m.test(release)) throw new Error('开发机缺少 Docker，请先安装并启动 Docker Engine');
	const executable = await command('/bin/sh', ['-c', 'command -v docker >/dev/null']).catch(() => ({code: 1}));
	if (executable.code !== 0) {
		console.error('CPM：正在通过系统 apt 安装 Docker Engine');
		for (const args of [['apt-get', 'update'], ['apt-get', 'install', '-y', 'docker.io']]) {
			const result = await command('sudo', ['-n', ...args], {inherit: !onOutput, onOutput});
			if (result.code !== 0) throw new Error(`Docker 安装失败：${args.join(' ')}`);
		}
	}
	const started = await command('sudo', ['-n', 'systemctl', 'start', 'docker'], {inherit: !onOutput, onOutput});
	if (started.code !== 0) throw new Error('Docker 已安装但服务启动失败');
	dockerAccess = undefined;
	const checks = await inspectContainerPrerequisites();
	const failed = checks.find(item => item.state === 'FAIL');
	if (failed) throw new Error(`${failed.name}：${failed.value}`);
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}

function volumeId(): string {
	return createHash('sha256').update(`${process.getuid?.() || 0}\0${homedir()}`).digest('hex').slice(0, 16);
}

type VolumeNames = {version: 1; id: string; home: string; workspace: string};
export type VolumeRecord = VolumeNames & {homeCreatedAt: string; workspaceCreatedAt: string};

function volumeNames(id: string): VolumeNames {
	return {version: 1, id, home: `cpm-home-${id}`, workspace: `cpm-workspace-${id}`};
}

function volumeRecordPath(): string {
	return join(homedir(), '.local', 'state', 'cpm', 'sandbox-volumes.json');
}

export function volumeAction(recorded: boolean, homeExists: boolean, workspaceExists: boolean): 'create' | 'adopt' | 'reuse' {
	if (recorded && (!homeExists || !workspaceExists)) throw new Error('CPM 持久卷已丢失；为避免生成空环境，已停止启动');
	if (homeExists !== workspaceExists) throw new Error('CPM 持久卷只剩一部分；为避免覆盖原环境，已停止启动');
	return recorded ? 'reuse' : homeExists ? 'adopt' : 'create';
}

export function verifyVolumeIdentity(recorded: Pick<VolumeRecord, 'homeCreatedAt' | 'workspaceCreatedAt'>, actual: Pick<VolumeRecord, 'homeCreatedAt' | 'workspaceCreatedAt'>): void {
	if (recorded.homeCreatedAt !== actual.homeCreatedAt || recorded.workspaceCreatedAt !== actual.workspaceCreatedAt) {
		throw new Error('CPM 持久卷已被替换；为避免误用空环境，已停止启动');
	}
}

export async function inspectPersistentVolumes(): Promise<CheckItem[]> {
	const expected = volumeNames(volumeId());
	let stored: VolumeRecord | undefined;
	try { stored = JSON.parse(await readFile(volumeRecordPath(), 'utf8')) as VolumeRecord; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return [{name: '持久卷记录', state: 'FAIL', value: (error as Error).message}];
	}
	if (stored && (stored.version !== 1 || stored.id !== expected.id || stored.home !== expected.home || stored.workspace !== expected.workspace || !stored.homeCreatedAt || !stored.workspaceCreatedAt)) {
		return [{name: '持久卷记录', state: 'FAIL', value: '与当前用户不一致'}];
	}
	try {
		const [home, workspace] = await Promise.all([
			docker(['volume', 'inspect', expected.home, '--format', '{{.CreatedAt}}']),
			docker(['volume', 'inspect', expected.workspace, '--format', '{{.CreatedAt}}']),
		]);
		const action = volumeAction(Boolean(stored), home.code === 0, workspace.code === 0);
		if (action === 'create') return [{name: '持久工作区', state: 'INFO', value: '首次准备时创建', detail: `${expected.home}, ${expected.workspace}`}];
		if (action === 'adopt') return [{name: '持久工作区', state: 'WARN', value: '发现已有卷，首次准备时登记', detail: `${expected.home}, ${expected.workspace}`}];
		verifyVolumeIdentity(stored!, {homeCreatedAt: home.stdout.trim(), workspaceCreatedAt: workspace.stdout.trim()});
		return [{name: '持久工作区', state: 'PASS', value: '已保存', detail: `${expected.home}, ${expected.workspace}`}];
	} catch (error) {
		return [{name: '持久工作区', state: 'FAIL', value: (error as Error).message}];
	}
}

export async function ensurePersistentVolumes(): Promise<VolumeRecord> {
	const expected = volumeNames(volumeId());
	const path = volumeRecordPath();
	let stored: Partial<VolumeRecord> | undefined;
	try {
		stored = JSON.parse(await readFile(path, 'utf8')) as Partial<VolumeRecord>;
		if (stored.version !== 1 || stored.id !== expected.id || stored.home !== expected.home || stored.workspace !== expected.workspace) {
			throw new Error('CPM 持久卷记录与当前用户不一致，已停止启动');
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const [home, workspace] = await Promise.all([
		docker(['volume', 'inspect', expected.home, '--format', '{{.CreatedAt}}']),
		docker(['volume', 'inspect', expected.workspace, '--format', '{{.CreatedAt}}']),
	]);
	const action = volumeAction(Boolean(stored), home.code === 0, workspace.code === 0);
	if (action === 'create') {
		for (const name of [expected.home, expected.workspace]) {
			const result = await docker(['volume', 'create', name]);
			if (result.code !== 0) throw new Error(`无法创建持久卷 ${name}：${result.stderr.trim()}`);
		}
	}
	const homeCreatedAt = action === 'create' ? (await docker(['volume', 'inspect', expected.home, '--format', '{{.CreatedAt}}'])).stdout.trim() : home.stdout.trim();
	const workspaceCreatedAt = action === 'create' ? (await docker(['volume', 'inspect', expected.workspace, '--format', '{{.CreatedAt}}'])).stdout.trim() : workspace.stdout.trim();
	if (!homeCreatedAt || !workspaceCreatedAt) throw new Error('无法确认 CPM 持久卷的创建时间');
	const record: VolumeRecord = {...expected, homeCreatedAt, workspaceCreatedAt};
	if (stored) verifyVolumeIdentity(stored as VolumeRecord, record);
	if (action !== 'reuse') {
		await mkdir(join(homedir(), '.local', 'state', 'cpm'), {recursive: true, mode: 0o700});
		const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(record)}\n`, {mode: 0o600});
			await rename(temporary, path);
		} finally { await rm(temporary, {force: true}); }
	}
	return record;
}

export async function ensureContainerImage(config: RuntimeConfig, onOutput?: (line: string) => void): Promise<string> {
	validatedRegion(config);
	const checks = await inspectContainerPrerequisites();
	const failed = checks.find(item => item.state === 'FAIL');
	if (failed) throw new Error(`${failed.name}：${failed.value}。独立容器模式不会回退到宿主文件系统`);
	if (!config.claudeBin) throw new Error('需要先安装官方 Claude CLI 以构建默认沙箱镜像');
	await access(config.claudeBin);
	const binary = selfBinary();
	await access(binary);
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	if (uid === undefined || gid === undefined || uid === 0) throw new Error('独立容器需要普通 Linux 用户');
	const fingerprint = createHash('sha256').update(DOCKERFILE).update(config.timezone).update(config.locale)
		.update(String(uid)).update(String(gid)).update(await hashFile(binary)).update(await hashFile(config.claudeBin)).digest('hex').slice(0, 20);
	const image = `cpm-workspace:${VERSION}-${fingerprint}`;
	const exists = await docker(['image', 'inspect', image]);
	if (exists.code === 0) return image;
	const folder = await mkdtemp(join(tmpdir(), 'cpm-container-build-'));
	try {
		await writeFile(join(folder, 'Dockerfile'), DOCKERFILE);
		await copyFile(binary, join(folder, 'cpm'));
		await copyFile(config.claudeBin, join(folder, 'claude'));
		const proxy = `http://127.0.0.1:${config.httpPort}`;
		if (!onOutput) console.error('CPM：首次构建独立开发容器，安装 Git、Python 和系统工具');
		const built = await docker([
			'build', '--network=host', '--pull=false', '-t', image,
			'--build-arg', `CPM_TZ=${config.timezone}`, '--build-arg', `CPM_LOCALE=${config.locale}`,
			'--build-arg', `CPM_UID=${uid}`, '--build-arg', `CPM_GID=${gid}`,
			'--build-arg', `http_proxy=${proxy}`, '--build-arg', `https_proxy=${proxy}`,
			folder,
		], {inherit: !onOutput, onOutput});
		if (built.code !== 0) throw new Error(`独立容器构建失败，退出码 ${built.code}`);
		return image;
	} finally { await rm(folder, {recursive: true, force: true}); }
}

export type ContainerStart = {
	image: string;
	directory: string;
	name: string;
	volumeId: string;
	uid: number;
	gid: number;
	config: RuntimeConfig;
	executable: string;
	args: string[];
	expectedExitIp: string;
	terminal: boolean;
	term: string;
};

export function containerRunArguments(start: ContainerStart): string[] {
	const proxy = `http://127.0.0.1:${start.config.httpPort}`;
	const env = [
		`CPM_EXPECTED_EXIT_IP=${start.expectedExitIp}`, `CPM_HTTP_PORT=${start.config.httpPort}`,
		`HTTP_PROXY=${proxy}`, `HTTPS_PROXY=${proxy}`, `ALL_PROXY=${proxy}`,
		`http_proxy=${proxy}`, `https_proxy=${proxy}`, `all_proxy=${proxy}`,
		'NO_PROXY=localhost,127.0.0.1,::1', 'no_proxy=localhost,127.0.0.1,::1',
		`TZ=${start.config.timezone}`, `LANG=${start.config.locale}`, `LC_ALL=${start.config.locale}`,
		`LC_CTYPE=${start.config.locale}`, `LC_MESSAGES=${start.config.locale}`,
		`TERM=${start.term}`,
		'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
	];
	return [
		'run', '--rm', '--pull=never', '--init', '--name', start.name, '--network', 'none',
		'--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
		'--security-opt', 'apparmor=docker-default', '--cgroupns', 'private',
		'--user', `${start.uid}:${start.gid}`, '--hostname', 'cpm-dev',
		'--dns', '127.0.0.1', '--pids-limit', '512', '--memory', '8g',
		'--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--tmpfs', '/run:rw,nosuid,nodev,size=64m',
		'--tmpfs', '/sys:ro,nosuid,nodev,noexec',
		'--mount', `type=volume,src=cpm-home-${start.volumeId},dst=/home/node`,
		'--mount', `type=volume,src=cpm-workspace-${start.volumeId},dst=/workspace`,
		'--mount', `type=bind,src=${start.directory},dst=/cpm-egress,readonly`,
		'--workdir', '/workspace',
		...env.flatMap(item => ['--env', item]),
		'-i', ...(start.terminal ? ['-t'] : []),
		start.image, '/usr/local/bin/cpm', '__container-run', start.executable, ...start.args,
	];
}

export async function runIsolatedContainer(config: RuntimeConfig, executable: string, args: string[], expectedExitIp: string): Promise<number> {
	if (!expectedExitIp) throw new Error('没有经过代理验证的出口 IP，停止启动独立容器');
	const volumes = await ensurePersistentVolumes();
	const image = await ensureContainerImage(config);
	const directory = await mkdtemp(join(tmpdir(), 'cpm-egress-'));
	let sidecar: Awaited<ReturnType<typeof startNetworkSidecar>> | undefined;
	try {
		sidecar = await startNetworkSidecar(directory, config);
		const id = volumes.id;
		const options = containerRunArguments({
			image, directory, name: `cpm-run-${id}-${randomBytes(4).toString('hex')}`,
			volumeId: id, uid: process.getuid!(), gid: process.getgid!(), config,
			executable, args, expectedExitIp,
			terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY), term: process.env.TERM || 'xterm-256color',
		});
		const result = await docker(options, {inherit: true});
		return result.code;
	} finally {
		await sidecar?.close();
		await rm(directory, {recursive: true, force: true});
	}
}
