import {spawn, type ChildProcess} from 'node:child_process';
import {createConnection, createServer, type Server, type Socket} from 'node:net';
import {createSocket, type Socket as DatagramSocket} from 'node:dgram';
import {randomBytes} from 'node:crypto';
import {access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {homedir, hostname, tmpdir} from 'node:os';
import {lookup} from 'node:dns/promises';
import {basename, join, resolve, sep} from 'node:path';
import {httpsRequest, proxyEnvironment, type RuntimeConfig} from './proxy-runtime.js';
import {startNetworkSidecar} from './network-sidecar.js';
import {statusSummary, type CheckItem} from './types.js';

const HOSTNAME = 'cpm-dev';
const DNS_PORT = 5353;
const TRANSPARENT_PORT = 17892;
const SOCKS_PORT = 17893;

function selfCommand(mode: string, args: string[] = []): {binary: string; args: string[]} {
	const binary = process.execPath;
	return ['node', 'nodejs', 'bun'].includes(basename(binary))
		? {binary, args: [process.argv[1]!, mode, ...args]}
		: {binary, args: [mode, ...args]};
}

async function run(binary: string, args: string[], options: {cwd?: string; env?: NodeJS.ProcessEnv} = {}): Promise<string> {
	return await new Promise((resolveOutput, reject) => {
		const child = spawn(binary, args, {stdio: ['ignore', 'pipe', 'pipe'], ...options});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
		child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
		child.once('error', reject);
		child.once('close', code => code === 0
			? resolveOutput(Buffer.concat(stdout).toString('utf8'))
			: reject(new Error(`${binary} ${args.slice(0, 2).join(' ')}: ${Buffer.concat(stderr).toString('utf8').trim() || `退出码 ${code}`}`)));
	});
}

async function executable(path: string): Promise<boolean> {
	try { await access(path, fsConstants.X_OK); return true; } catch { return false; }
}

function dependencyDir(): string { return join(homedir(), '.local', 'share', 'cpm', 'native'); }

async function locateRedsocks(): Promise<string> {
	for (const path of ['/usr/sbin/redsocks', '/usr/bin/redsocks', join(dependencyDir(), 'usr', 'sbin', 'redsocks')]) {
		if (await executable(path)) return path;
	}
	return '';
}

export async function inspectSandboxPrerequisites(): Promise<CheckItem[]> {
	if (process.platform !== 'linux') return [{name: '进程沙箱', state: 'FAIL', value: '仅支持 Linux 开发机'}];
	const redsocks = await locateRedsocks();
	const checks: CheckItem[] = [{name: '透明转发组件', state: redsocks ? 'PASS' : 'FAIL', value: redsocks || 'redsocks 未准备'}];
	try {
		await run('sudo', ['-n', 'unshare', '--net', '--mount', '--uts', '--pid', '--ipc', '--fork', '--kill-child',
			'/bin/sh', '-c', 'ip link add cpm-doctor type dummy && nft add table ip cpm_doctor']);
		checks.push({name: '命名空间权限', state: 'PASS', value: 'sudo / ip / nft 可用'});
	} catch (error) {
		checks.push({name: '命名空间权限', state: 'FAIL', value: '不可用', detail: (error as Error).message});
	}
	return checks;
}

export async function prepareLinuxSandbox(): Promise<string> {
	if (process.platform !== 'linux') throw new Error('进程沙箱目前只支持 Linux 开发机');
	for (const binary of ['sudo', 'unshare', 'mount', 'umount', 'ip', 'nft', 'setpriv', 'hostname']) {
		await run('/bin/sh', ['-c', `command -v ${binary} >/dev/null`]).catch(() => { throw new Error(`缺少沙箱依赖 ${binary}`); });
	}
	await run('sudo', ['-n', 'unshare', '--net', '--mount', '--uts', '--pid', '--ipc', '--fork', '--kill-child', 'true'])
		.catch(error => { throw new Error(`无法创建强制隔离沙箱；开发机需要免密 sudo 和 namespace 权限：${(error as Error).message}`); });
	const installed = await locateRedsocks();
	if (installed) return installed;
	for (const binary of ['apt-get', 'dpkg-deb']) {
		await run('/bin/sh', ['-c', `command -v ${binary} >/dev/null`]).catch(() => { throw new Error(`缺少 ${binary}，请安装 redsocks`); });
	}
	const folder = dependencyDir();
	await mkdir(folder, {recursive: true, mode: 0o700});
	const staging = await mkdtemp(join(folder, '.download-'));
	try {
		await run('apt-get', ['download', 'redsocks'], {cwd: staging});
		const deb = (await readdir(staging)).find(name => name.startsWith('redsocks_') && name.endsWith('.deb'));
		if (!deb) throw new Error('apt 没有返回 redsocks 包');
		await run('dpkg-deb', ['-x', join(staging, deb), folder]);
	} finally { await rm(staging, {recursive: true, force: true}); }
	const path = await locateRedsocks();
	if (!path) throw new Error('redsocks 解包后未找到可执行文件');
	await run(path, ['-v']);
	return path;
}

type Session = {
	uid: number;
	gid: number;
	groups: number[];
	cwd: string;
	claudeBin: string;
	claudeArgs: string[];
	env: NodeJS.ProcessEnv;
	timezone: string;
	redsocks: string;
	httpPort: number;
	expectedExitIp: string;
};

async function mount(args: string[]): Promise<void> { await run('mount', args); }

async function configureNetwork(): Promise<void> {
	await run('ip', ['link', 'set', 'lo', 'up']);
	await run('ip', ['link', 'add', 'cpm0', 'type', 'dummy']);
	await run('ip', ['addr', 'add', '100.64.0.2/32', 'dev', 'cpm0']);
	await run('ip', ['link', 'set', 'cpm0', 'up']);
	await run('ip', ['route', 'add', 'default', 'dev', 'cpm0']);
	await run('nft', ['add', 'table', 'ip', 'cpm']);
	await run('nft', ['add', 'chain', 'ip', 'cpm', 'out', '{ type nat hook output priority dstnat; policy accept; }']);
	for (const rule of [
		['udp', 'dport', '53', 'redirect', 'to', `:${DNS_PORT}`],
		['tcp', 'dport', '53', 'redirect', 'to', `:${DNS_PORT}`],
		['ip', 'daddr', '127.0.0.0/8', 'return'],
		['meta', 'l4proto', 'tcp', 'redirect', 'to', `:${TRANSPARENT_PORT}`],
	]) await run('nft', ['add', 'rule', 'ip', 'cpm', 'out', ...rule]);
}

async function coverEtc(directory: string, timezone: string): Promise<void> {
	const zoneRoot = '/usr/share/zoneinfo';
	const zone = resolve(zoneRoot, timezone);
	if (!zone.startsWith(`${zoneRoot}${sep}`)) throw new Error('时区路径无效');
	await access(zone);
	const original = join(directory, 'host-etc');
	await mkdir(original);
	await mount(['--bind', '/etc', original]);
	await mount(['-t', 'tmpfs', '-o', 'mode=0755', 'tmpfs', '/etc']);
	const exceptions = new Set(['localtime', 'timezone', 'hostname', 'hosts', 'resolv.conf', 'machine-id']);
	for (const name of await readdir(original)) {
		if (exceptions.has(name)) continue;
		const from = join(original, name);
		const to = join('/etc', name);
		const info = await lstat(from);
		if (info.isSymbolicLink()) {
			await symlink(await readlink(from), to);
		} else if (info.isDirectory()) {
			await mkdir(to);
			await mount(['--rbind', from, to]);
		} else if (info.isFile()) {
			await writeFile(to, '');
			await mount(['--bind', from, to]);
		}
	}
	await copyFile(zone, '/etc/localtime');
	await writeFile('/etc/timezone', `${timezone}\n`);
	await writeFile('/etc/hostname', `${HOSTNAME}\n`);
	await writeFile('/etc/hosts', `127.0.0.1 localhost\n127.0.1.1 ${HOSTNAME}\n::1 localhost ip6-localhost\n`);
	await writeFile('/etc/resolv.conf', 'nameserver 127.0.0.1\noptions timeout:1 attempts:2\n');
	await writeFile('/etc/machine-id', `${randomBytes(16).toString('hex')}\n`);
	await run('umount', [original]);
}

async function maskHostFiles(): Promise<void> {
	for (const path of ['/run', '/var/lib/cloud', '/sys/devices/virtual/dmi', '/sys/firmware/dmi']) {
		try {
			if (!(await lstat(path)).isDirectory()) continue;
			await mount(['-t', 'tmpfs', '-o', 'mode=0755', 'tmpfs', path]);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
}

export async function sandboxInit(directory: string): Promise<number> {
	if (process.getuid?.() !== 0) throw new Error('sandbox-init 需要 root 创建命名空间');
	const session = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')) as Session;
	await mount(['--make-rprivate', '/']);
	await configureNetwork();
	await coverEtc(directory, session.timezone);
	await maskHostFiles();
	await mount(['-t', 'proc', 'proc', '/proc']);
	await run('hostname', [HOSTNAME]);
	const self = selfCommand('__sandbox-child', [directory]);
	const groups = session.groups.length ? session.groups.join(',') : String(session.gid);
	return await new Promise<number>((resolveExit, reject) => {
		const child = spawn('setpriv', [
			'--reuid', String(session.uid), '--regid', String(session.gid), '--groups', groups,
			'--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs',
			self.binary, ...self.args,
		], {stdio: 'inherit', cwd: session.cwd});
		child.once('error', reject);
		child.once('exit', code => resolveExit(code ?? 1));
	});
}

async function relay(client: Socket, path: string): Promise<void> {
	const upstream = createConnection(path);
	client.once('close', () => upstream.destroy());
	upstream.once('close', () => client.destroy());
	upstream.once('error', () => client.destroy());
	client.pipe(upstream).pipe(client);
}

async function dnsQuery(packet: Buffer, directory: string): Promise<Buffer> {
	return await new Promise<Buffer>((resolveAnswer, reject) => {
		const socket = createConnection(join(directory, 'dns.sock'));
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => socket.destroy(new Error('DNS sidecar 超时')), 5_000);
		socket.once('connect', () => socket.end(packet));
		socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
		socket.once('error', error => { clearTimeout(timer); reject(error); });
		socket.once('end', () => { clearTimeout(timer); resolveAnswer(Buffer.concat(chunks)); });
	});
}

async function listenTcp(port: number, listener: (socket: Socket) => void): Promise<Server> {
	const server = createServer(listener);
	await new Promise<void>((resolveReady, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolveReady);
	});
	return server;
}

async function listenDns(directory: string): Promise<{udp: DatagramSocket; tcp: Server}> {
	const udp = createSocket('udp4');
	udp.on('message', (message, sender) => {
		void dnsQuery(message, directory).then(answer => udp.send(answer, sender.port, sender.address)).catch(() => {});
	});
	await new Promise<void>((resolveReady, reject) => {
		udp.once('error', reject);
		udp.bind(DNS_PORT, '127.0.0.1', resolveReady);
	});
	const tcp = await listenTcp(DNS_PORT, socket => {
		let buffer = Buffer.alloc(0);
		socket.on('data', data => {
			buffer = Buffer.concat([buffer, data]);
			if (buffer.length < 2 || buffer.length < buffer.readUInt16BE(0) + 2) return;
			const packet = buffer.subarray(2, 2 + buffer.readUInt16BE(0));
			socket.pause();
			void dnsQuery(packet, directory).then(answer => {
				const length = Buffer.alloc(2);
				length.writeUInt16BE(answer.length);
				socket.end(Buffer.concat([length, answer]));
			}).catch(() => socket.destroy());
		});
	});
	return {udp, tcp};
}

async function waitHealthy(port: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
	while (Date.now() < deadline) {
		try {
			const table = await readFile('/proc/net/tcp', 'utf8');
			if (table.split('\n').some(line => line.includes(`0100007F:${hexPort}`) && /\s0A\s/.test(line))) return;
		} catch { await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
		await new Promise(resolveWait => setTimeout(resolveWait, 100));
	}
	throw new Error('透明 TCP 转发进程没有启动');
}

export async function sandboxChild(directory: string): Promise<number> {
	const session = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')) as Session;
	await rm(join(directory, 'session.json'), {force: true});
	const servers: Server[] = [];
	let dns: {udp: DatagramSocket; tcp: Server} | undefined;
	let redsocks: ChildProcess | undefined;
	try {
		servers.push(await listenTcp(SOCKS_PORT, socket => { void relay(socket, join(directory, 'socks.sock')); }));
		servers.push(await listenTcp(session.httpPort, socket => { void relay(socket, join(directory, 'http.sock')); }));
		dns = await listenDns(directory);
		const conf = join(directory, 'redsocks.conf');
		await writeFile(conf, `base { log_debug = off; log_info = off; log = "stderr"; daemon = off; redirector = iptables; }\nredsocks { local_ip = 127.0.0.1; local_port = ${TRANSPARENT_PORT}; ip = 127.0.0.1; port = ${SOCKS_PORT}; type = socks5; }\n`, {mode: 0o600});
		redsocks = spawn(session.redsocks, ['-c', conf], {stdio: ['ignore', 'ignore', 'inherit']});
		await waitHealthy(TRANSPARENT_PORT);
		const checks: CheckItem[] = [];
		checks.push({name: '沙箱主机名', state: hostname() === HOSTNAME ? 'PASS' : 'FAIL', value: hostname()});
		const actualTimezone = (await readFile('/etc/timezone', 'utf8')).trim();
		checks.push({name: '沙箱时区', state: actualTimezone === session.timezone ? 'PASS' : 'FAIL', value: actualTimezone});
		const zone = resolve('/usr/share/zoneinfo', session.timezone);
		const zoneMatches = (await readFile('/etc/localtime')).equals(await readFile(zone));
		checks.push({name: '/etc/localtime', state: zoneMatches ? 'PASS' : 'FAIL', value: zoneMatches ? session.timezone : '与配置不一致'});
		const route = (await run('ip', ['route', 'get', '1.1.1.1'])).trim();
		checks.push({name: '隔离网络路由', state: route.includes('dev cpm0') ? 'PASS' : 'FAIL', value: route.replaceAll(/\s+/g, ' ')});
		const address = (await lookup('api.ipify.org', {family: 4})).address;
		checks.push({name: '隔离 DNS', state: address.startsWith('198.18.') || address.startsWith('198.19.') ? 'PASS' : 'FAIL', value: address});
		if (session.expectedExitIp) {
			let actualExitIp = '';
			try {
				const result = await httpsRequest('api.ipify.org', '/');
				actualExitIp = result.status === 200 ? result.body : `HTTP ${result.status}`;
			} catch (error) { actualExitIp = (error as Error).message; }
			checks.push({name: '沙箱实际出口', state: actualExitIp === session.expectedExitIp ? 'PASS' : 'FAIL', value: actualExitIp, detail: `预期 ${session.expectedExitIp}`});
		}
		console.error(`CPM 沙箱启动检查\n${statusSummary({connected: true, checks})}\n`);
		if (checks.some(item => item.state === 'FAIL')) return 3;
		const child = spawn(session.claudeBin, ['--no-chrome', ...session.claudeArgs], {cwd: session.cwd, env: session.env, stdio: 'inherit'});
		return await new Promise<number>((resolveExit, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) => {
				if (signal) process.kill(process.pid, signal);
				resolveExit(code ?? 1);
			});
		});
	} finally {
		redsocks?.kill('SIGTERM');
		dns?.udp.close();
		dns?.tcp.close();
		for (const server of servers) server.close();
	}
}

export async function runInLinuxSandbox(config: RuntimeConfig, args: string[], expectedExitIp: string): Promise<number> {
	if (process.platform !== 'linux') throw new Error('强制隔离代理目前只支持 Linux 开发机');
	if (process.getuid?.() === 0) throw new Error('强制隔离代理要求以普通用户运行 Claude');
	if ([DNS_PORT, TRANSPARENT_PORT, SOCKS_PORT].includes(config.httpPort)) throw new Error(`HTTP_PORT ${config.httpPort} 与沙箱保留端口冲突`);
	const redsocks = await prepareLinuxSandbox();
	const directory = await mkdtemp(join(tmpdir(), 'cpm-sandbox-'));
	await chmod(directory, 0o700);
	const env = proxyEnvironment(config);
	for (const name of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CPM_SOCKS5_PROXY', 'SOCKS5_PROXY', 'CPM_PROXY_CONFIG']) delete env[name];
	const session: Session = {
		uid: process.getuid!(), gid: process.getgid!(), groups: process.getgroups!(),
		cwd: process.cwd(), claudeBin: config.claudeBin, claudeArgs: args,
		env, timezone: config.timezone, redsocks, httpPort: config.httpPort, expectedExitIp,
	};
	const path = join(directory, 'session.json');
	await writeFile(path, JSON.stringify(session), {mode: 0o600});
	let sidecar: Awaited<ReturnType<typeof startNetworkSidecar>> | undefined;
	try {
		sidecar = await startNetworkSidecar(directory, config);
		const self = selfCommand('__sandbox-init', [directory]);
		return await new Promise<number>((resolveExit, reject) => {
			const child = spawn('sudo', ['-n', 'unshare', '--net', '--mount', '--uts', '--pid', '--ipc', '--fork', '--kill-child', self.binary, ...self.args], {stdio: 'inherit'});
			child.once('error', reject);
			child.once('exit', code => resolveExit(code ?? 1));
		});
	} finally {
		await sidecar?.close();
		await rm(directory, {recursive: true, force: true});
	}
}
