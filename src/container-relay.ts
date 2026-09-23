import {spawn} from 'node:child_process';
import {createSocket, type Socket as DatagramSocket} from 'node:dgram';
import {lookup} from 'node:dns/promises';
import {readFile, readdir, access} from 'node:fs/promises';
import {createConnection, createServer, type Server, type Socket} from 'node:net';
import {hostname, networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {bridgedHttps} from './proxy-runtime.js';
import type {CheckItem} from './types.js';
import {CheckStream} from './check-stream.js';
import {TerminalProgress} from './progress-display.js';
import {pipeSockets} from './socket-pair.js';

const EGRESS_DIR = '/cpm-egress';
const SOCKS_PORT = 17_893;
const DNS_PORT = 53;

function relay(client: Socket, destination: string): void {
	const upstream = createConnection(destination);
	pipeSockets(client, upstream);
}

async function listenTcp(port: number, listener: (client: Socket) => void): Promise<Server> {
	const server = createServer(listener);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	return server;
}

async function queryDns(packet: Buffer): Promise<Buffer> {
	return await new Promise((resolve, reject) => {
		const socket = createConnection(join(EGRESS_DIR, 'dns.sock'));
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => socket.destroy(new Error('sidecar DNS 超时')), 5_000);
		socket.once('connect', () => socket.end(packet));
		socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
		socket.once('error', error => { clearTimeout(timer); reject(error); });
		socket.once('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
	});
}

async function listenDns(): Promise<{udp: DatagramSocket; tcp: Server}> {
	const udp = createSocket('udp4');
	udp.on('message', (packet, sender) => {
		void queryDns(packet).then(answer => udp.send(answer, sender.port, sender.address)).catch(() => {});
	});
	await new Promise<void>((resolve, reject) => {
		udp.once('error', reject);
		udp.bind(DNS_PORT, '127.0.0.1', resolve);
	});
	try {
		const tcp = await listenTcp(DNS_PORT, client => {
			let data = Buffer.alloc(0);
			client.on('data', chunk => {
				data = Buffer.concat([data, chunk]);
				if (data.length < 2 || data.length < data.readUInt16BE(0) + 2) return;
				const packet = data.subarray(2, 2 + data.readUInt16BE(0));
				client.pause();
				void queryDns(packet).then(answer => {
					const size = Buffer.alloc(2);
					size.writeUInt16BE(answer.length);
					client.end(Buffer.concat([size, answer]));
				}).catch(() => client.destroy());
			});
		});
		return {udp, tcp};
	} catch (error) {
		udp.close();
		throw error;
	}
}

async function externalTcpBlocked(host: string): Promise<boolean> {
	return await new Promise(resolve => {
		const socket = createConnection({host, port: 443});
		const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2_000);
		socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
		socket.once('error', () => { clearTimeout(timer); resolve(true); });
	});
}

async function inheritedCommand(command: string, args: string[]): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const child = spawn(command, args, {stdio: 'inherit'});
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (signal) process.kill(process.pid, signal);
			resolve(code ?? 1);
		});
	});
}

async function codexLoggedIn(binary: string): Promise<boolean> {
	return await new Promise<boolean>(resolve => {
		const child = spawn(binary, ['login', 'status'], {stdio: 'ignore'});
		child.once('error', () => resolve(false));
		child.once('exit', code => resolve(code === 0));
	});
}

export function codexLaunchArgs(args: string[]): string[] {
	if (['login', 'help', '--help', '-h', '--version', '-V'].includes(args[0] || '')) return args;
	if (args.some(item => item === '--sandbox' || item === '-s' || item.startsWith('--sandbox='))) return args;
	return ['--sandbox', 'danger-full-access', ...args];
}

async function runCommand(command: string, args: string[]): Promise<number> {
	if (command === 'codex') {
		const binary = '/home/node/.local/node_modules/.bin/codex';
		try { await (await import('node:fs/promises')).access(binary); }
		catch {
			console.error('CPM：正在把 Codex 安装到沙箱 HOME');
			const started = Date.now();
			const progress = setInterval(() => console.error(`CPM：Codex 安装中 ${Math.round((Date.now() - started) / 1_000)}s`), 10_000);
			progress.unref();
			let installed: number;
			try {
				installed = await new Promise<number>((resolve, reject) => {
					const child = spawn('npm', ['install', '--prefix', '/home/node/.local', '@openai/codex'], {stdio: 'inherit'});
					child.once('error', reject);
					child.once('exit', code => resolve(code ?? 1));
				});
			} finally { clearInterval(progress); }
			if (installed !== 0) return installed;
		}
		if (!args.length && !await codexLoggedIn(binary)) {
			console.error('CPM：隔离容器无法接收浏览器的 localhost OAuth 回调；首次使用 Codex 将启动设备码登录。');
			console.error('CPM：如提示设备码未启用，请在 ChatGPT 账户或工作区设置中启用，再重试。');
			const login = await inheritedCommand(binary, ['login', '--device-auth']);
			if (login !== 0) return login;
		}
	}
	const launchArgs = command === 'claude' ? ['--no-chrome', ...args]
		: command === 'codex' ? codexLaunchArgs(args) : args;
	return inheritedCommand(command, launchArgs);
}

export async function runContainerCommand(command: string, args: string[]): Promise<number> {
	const httpPort = Number(process.env.CPM_HTTP_PORT || 17_891);
	if (!Number.isInteger(httpPort) || httpPort < 1024 || httpPort > 65_535 || [SOCKS_PORT, DNS_PORT].includes(httpPort)) throw new Error('沙箱 HTTP_PORT 无效');
	const servers: Server[] = [];
	const progress = new TerminalProgress('CPM 容器检查');
	const stream = new CheckStream('CPM 独立容器启动检查', line => progress.line(line));
	let dns: {udp: DatagramSocket; tcp: Server} | undefined;
	try {
		servers.push(await listenTcp(httpPort, client => relay(client, join(EGRESS_DIR, 'http.sock'))));
		servers.push(await listenTcp(SOCKS_PORT, client => relay(client, join(EGRESS_DIR, 'socks.sock'))));
		dns = await listenDns();
		const checks: CheckItem[] = [];
		const add = (item: CheckItem) => { checks.push(item); stream.row(item); };
		stream.start();
		const uid = process.getuid?.();
		add({name: '容器普通用户', state: uid !== undefined && uid !== 0 ? 'PASS' : 'FAIL', value: String(uid ?? '<未知>')});
		add({name: '独立主机名', state: hostname() === 'cpm-dev' ? 'PASS' : 'FAIL', value: hostname()});
		const interfaces = Object.values(networkInterfaces()).flat().filter((item): item is NonNullable<typeof item> => Boolean(item));
		add({name: '网络接口', state: interfaces.every(item => item.internal) ? 'PASS' : 'FAIL', value: interfaces.map(item => item.address).join(',')});
		progress.update({percent: 20, label: '验证公网直连已阻断'});
		add({name: '直连公网', state: await externalTcpBlocked('1.1.1.1') ? 'PASS' : 'FAIL', value: '不可达'});
		add({name: '云元数据直连', state: await externalTcpBlocked('169.254.169.254') ? 'PASS' : 'FAIL', value: '不可达'});
		const status = await readFile('/proc/self/status', 'utf8');
		const field = (name: string) => status.match(new RegExp(`^${name}:\\s*(\\S+)`, 'm'))?.[1] || '';
		add({name: '进程 capability', state: /^0+$/.test(field('CapEff')) ? 'PASS' : 'FAIL', value: field('CapEff')});
		add({name: 'no-new-privileges', state: field('NoNewPrivs') === '1' ? 'PASS' : 'FAIL', value: field('NoNewPrivs')});
		add({name: 'seccomp', state: field('Seccomp') === '2' ? 'PASS' : 'FAIL', value: field('Seccomp')});
		add({name: 'CPM 资源配置', state: 'INFO', value: '无额外 CPU/内存/cgroup 进程上限；继承宿主 ulimit'});
		if (command === 'codex' && codexLaunchArgs(args) !== args) add({name: 'Codex 内层隔离', state: 'INFO', value: '默认由 CPM 容器隔离；Codex 可操作整个容器工作区'});
		const mounts = await readFile('/proc/self/mountinfo', 'utf8');
		const rootMount = mounts.split('\n').find(line => line.split(' ')[4] === '/')?.split(' ')[5] || '';
		add({name: '只读根文件系统', state: rootMount.split(',').includes('ro') ? 'PASS' : 'FAIL', value: rootMount});
		add({name: '宿主设备信息', state: (await readdir('/sys')).length === 0 ? 'PASS' : 'FAIL', value: '已遮蔽 /sys'});
		let dockerSocketVisible = false;
		try { await access('/var/run/docker.sock'); dockerSocketVisible = true; } catch {}
		add({name: 'Docker 控制口', state: dockerSocketVisible ? 'FAIL' : 'PASS', value: dockerSocketVisible ? '可访问' : '不可访问'});
		add({name: '代理凭据环境', state: !process.env.SOCKS5_PROXY && !process.env.CPM_PROXY_CONFIG ? 'PASS' : 'FAIL', value: '未注入'});
		const resolver = await readFile('/etc/resolv.conf', 'utf8');
		add({name: 'DNS 配置', state: /^nameserver 127\.0\.0\.1$/m.test(resolver) ? 'PASS' : 'FAIL', value: '127.0.0.1'});
		progress.update({percent: 60, label: '验证隔离 DNS'});
		const address = (await lookup('api.ipify.org', {family: 4})).address;
		add({name: '隔离 DNS', state: /^198\.(18|19)\./.test(address) ? 'PASS' : 'FAIL', value: address});
		const timezone = (await readFile('/etc/timezone', 'utf8')).trim();
		add({name: '系统时区', state: timezone === process.env.TZ ? 'PASS' : 'FAIL', value: timezone});
		let exitIp = '';
		progress.update({percent: 82, label: '经 sidecar 查询容器实际出口 IP'});
		try {
			const response = await bridgedHttps(httpPort, 'api.ipify.org', '/');
			exitIp = response.status === 200 ? response.body : `HTTP ${response.status}`;
		} catch (error) { exitIp = (error as Error).message; }
		add({name: '沙箱实际出口', state: exitIp === process.env.CPM_EXPECTED_EXIT_IP ? 'PASS' : 'FAIL', value: exitIp, detail: `预期 ${process.env.CPM_EXPECTED_EXIT_IP || '<无>'}`});
		progress.update({percent: 100, label: '容器隔离检查完成'});
		progress.finish();
		stream.finish();
		if (checks.some(item => item.state === 'FAIL')) return 3;
		return await runCommand(command, args);
	} finally {
		progress.finish();
		dns?.udp.close();
		dns?.tcp.close();
		for (const server of servers) server.close();
	}
}
