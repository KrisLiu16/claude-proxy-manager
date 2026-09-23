import {createServer, isIP, BlockList, Socket, type Server} from 'node:net';
import {mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {lookup} from 'node:dns/promises';
import {handleSidecarHttp, socksConnect, type RuntimeConfig} from './proxy-runtime.js';

const SYNTHETIC_BASE = 0xc6120000; // 198.18.0.0/15, reserved for network testing.
const SYNTHETIC_LIMIT = 131_070;
const METADATA_NAMES = new Set(['metadata.google.internal', 'instance-data', 'metadata', 'metadata.tencentyun.com']);
const METADATA_IPS = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200', '168.63.129.16']);

function normalizeHost(host: string): string {
	return host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

export function forbiddenDestination(host: string): boolean {
	const value = normalizeHost(host);
	const mappedIpv4 = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
	if (mappedIpv4) return forbiddenDestination(mappedIpv4);
	if (METADATA_NAMES.has(value) || METADATA_IPS.has(value)) return true;
	if (value.startsWith('169.254.') || value.startsWith('fe80:')) return true;
	if (value === 'localhost' || value === '::1' || value === '0.0.0.0' || value === '::' || value.startsWith('127.')) return true;
	return false;
}

export function directDestination(host: string, noProxy: string): boolean {
	const value = normalizeHost(host);
	if (forbiddenDestination(value)) return false;
	for (const raw of noProxy.split(',')) {
		const item = normalizeHost(raw.trim());
		if (!item || item === '*') continue;
		if (item.includes('/')) {
			const [network = '', bitsText = ''] = item.split('/');
			const family = isIP(network);
			const bits = Number(bitsText);
			if (family && family === isIP(value) && Number.isInteger(bits) && bits >= 0 && bits <= (family === 4 ? 32 : 128)) {
				const block = new BlockList();
				block.addSubnet(network, bits, family === 4 ? 'ipv4' : 'ipv6');
				if (block.check(value, family === 4 ? 'ipv4' : 'ipv6')) return true;
			}
			continue;
		}
		const domain = item.startsWith('.') ? item.slice(1) : item;
		if (value === domain || value.endsWith(`.${domain}`)) return true;
	}
	return false;
}

function syntheticAddress(index: number): string {
	const value = SYNTHETIC_BASE + index;
	return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

export class SyntheticDns {
	private next = 1;
	private readonly byName = new Map<string, string>();
	private readonly byAddress = new Map<string, string>();

	public lookup(address: string): string | undefined {
		return this.byAddress.get(address);
	}

	public answer(packet: Buffer): Buffer {
		if (packet.length < 17 || packet.readUInt16BE(4) !== 1) throw new Error('DNS 查询格式无效');
		let offset = 12;
		const labels: string[] = [];
		while (offset < packet.length) {
			const length = packet[offset++]!;
			if (length === 0) break;
			if (length > 63 || offset + length > packet.length) throw new Error('DNS 名称无效');
			labels.push(packet.subarray(offset, offset + length).toString('ascii'));
			offset += length;
		}
		if (offset + 4 > packet.length) throw new Error('DNS 问题不完整');
		const name = normalizeHost(labels.join('.'));
		const type = packet.readUInt16BE(offset);
		const dnsClass = packet.readUInt16BE(offset + 2);
		const questionEnd = offset + 4;
		const answerA = type === 1 && dnsClass === 1 && Boolean(name) && !isIP(name);
		const header = Buffer.from(packet.subarray(0, 12));
		header.writeUInt16BE(0x8180, 2);
		header.writeUInt16BE(answerA ? 1 : 0, 6);
		header.writeUInt16BE(0, 8);
		header.writeUInt16BE(0, 10);
		if (!answerA) return Buffer.concat([header, packet.subarray(12, questionEnd)]);
		let address = this.byName.get(name);
		if (!address) {
			if (this.next > SYNTHETIC_LIMIT) throw new Error('DNS 合成地址已耗尽');
			address = syntheticAddress(this.next++);
			this.byName.set(name, address);
			this.byAddress.set(address, name);
		}
		const answer = Buffer.alloc(16);
		answer.writeUInt16BE(0xc00c, 0);
		answer.writeUInt16BE(1, 2);
		answer.writeUInt16BE(1, 4);
		answer.writeUInt32BE(60, 6);
		answer.writeUInt16BE(4, 10);
		for (const [index, octet] of address.split('.').entries()) answer[12 + index] = Number(octet);
		return Buffer.concat([header, packet.subarray(12, questionEnd), answer]);
	}
}

class Reader {
	private pending = Buffer.alloc(0);
	private wake: (() => void) | undefined;
	private error: Error | undefined;
	public constructor(private readonly socket: Socket) {
		socket.on('data', this.onData);
		socket.on('error', this.onError);
		socket.on('end', this.onEnd);
	}
	private readonly onData = (data: Buffer) => {
		if (this.pending.length + data.length > 1_048_576) {
			this.socket.destroy(new Error('SOCKS 握手数据过大'));
			return;
		}
		this.pending = Buffer.concat([this.pending, data]);
		this.wake?.();
	};
	private readonly onError = (error: Error) => { this.error = error; this.wake?.(); };
	private readonly onEnd = () => { this.error = new Error('SOCKS 客户端提前断开'); this.wake?.(); };
	public async read(length: number): Promise<Buffer> {
		while (this.pending.length < length) {
			if (this.error) throw this.error;
			await new Promise<void>(resolve => { this.wake = resolve; });
			this.wake = undefined;
		}
		const data = this.pending.subarray(0, length);
		this.pending = this.pending.subarray(length);
		return data;
	}
	public release(): Buffer {
		this.socket.pause();
		this.socket.off('data', this.onData);
		this.socket.off('error', this.onError);
		this.socket.off('end', this.onEnd);
		return this.pending;
	}
}

async function directTcp(host: string, port: number): Promise<Socket> {
	const resolved = isIP(host) ? [host] : (await lookup(host, {all: true})).map(item => item.address);
	if (!resolved.length || resolved.some(forbiddenDestination)) throw new Error('白名单目标解析到受限地址');
	return await new Promise((resolve, reject) => {
		const socket = new Socket();
		const timer = setTimeout(() => socket.destroy(new Error('内网白名单连接超时')), 10_000);
		socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
		socket.once('error', error => { clearTimeout(timer); reject(error); });
		socket.connect(port, resolved[0]!);
	});
}

async function handleSocks(client: Socket, config: RuntimeConfig, dns: SyntheticDns): Promise<void> {
	const reader = new Reader(client);
	client.setTimeout(20_000, () => client.destroy(new Error('SOCKS 握手超时')));
	let upstream: Socket | undefined;
	try {
		const hello = await reader.read(2);
		if (hello[0] !== 5) throw new Error('仅支持 SOCKS5');
		await reader.read(hello[1]!);
		client.write(Buffer.from([5, 0]));
		const request = await reader.read(4);
		if (request[0] !== 5 || request[1] !== 1) throw new Error('仅支持 SOCKS5 CONNECT');
		let host = '';
		if (request[3] === 1) host = [...await reader.read(4)].join('.');
		else if (request[3] === 4) {
			const raw = await reader.read(16);
			host = Array.from({length: 8}, (_, index) => raw.readUInt16BE(index * 2).toString(16)).join(':');
		} else if (request[3] === 3) host = (await reader.read((await reader.read(1))[0]!)).toString('utf8');
		else throw new Error('SOCKS 地址类型无效');
		const port = (await reader.read(2)).readUInt16BE(0);
		const destination = dns.lookup(host) || host;
		if (isIP(host) && (host.startsWith('198.18.') || host.startsWith('198.19.')) && !dns.lookup(host)) throw new Error('未知合成 DNS 地址');
		if (forbiddenDestination(destination)) throw new Error('禁止访问云元数据');
		upstream = directDestination(destination, config.noProxy)
			? await directTcp(destination, port)
			: await socksConnect(config.proxyUrl, destination, port);
		client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
		const pending = reader.release();
		client.setTimeout(0);
		if (pending.length) upstream.write(pending);
		client.pipe(upstream).pipe(client);
		client.once('close', () => upstream?.destroy());
		upstream.once('close', () => client.destroy());
	} catch {
		if (!client.destroyed) client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
		upstream?.destroy();
	}
}

async function bindServer(path: string, listener: (socket: Socket) => void): Promise<Server> {
	const server = createServer({allowHalfOpen: true}, listener);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(path, resolve);
	});
	return server;
}

export type NetworkSidecar = {close: () => Promise<void>; dns: SyntheticDns};

export async function startNetworkSidecar(directory: string, config: RuntimeConfig): Promise<NetworkSidecar> {
	await mkdir(directory, {recursive: true, mode: 0o700});
	const dns = new SyntheticDns();
	const sockets = new Set<Socket>();
	const track = (socket: Socket) => {
		if (sockets.size >= 512) { socket.destroy(); return false; }
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
		return true;
	};
	const servers: Server[] = [];
	try {
		servers.push(await bindServer(join(directory, 'socks.sock'), socket => { if (track(socket)) void handleSocks(socket, config, dns); }));
		servers.push(await bindServer(join(directory, 'http.sock'), socket => {
			if (!track(socket)) return;
			socket.setTimeout(20_000, () => socket.destroy());
			void handleSidecarHttp(socket, config.proxyUrl, async (host, port) => {
				const destination = dns.lookup(host) || host;
				if (forbiddenDestination(destination)) throw new Error('禁止访问云元数据');
				return directDestination(destination, config.noProxy) ? directTcp(destination, port) : socksConnect(config.proxyUrl, destination, port);
			}).finally(() => socket.setTimeout(0));
		}));
		servers.push(await bindServer(join(directory, 'dns.sock'), socket => {
			if (!track(socket)) return;
			socket.setTimeout(5_000, () => socket.destroy());
			const chunks: Buffer[] = [];
			socket.on('data', chunk => { if (chunks.reduce((size, part) => size + part.length, 0) < 4096) chunks.push(Buffer.from(chunk)); });
			socket.on('end', () => {
				try { socket.end(dns.answer(Buffer.concat(chunks))); } catch { socket.destroy(); }
			});
		}));
	} catch (error) {
		for (const server of servers) server.close();
		throw error;
	}
	return {dns, close: async () => {
		for (const socket of sockets) socket.destroy();
		await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
		await Promise.all(['socks.sock', 'http.sock', 'dns.sock'].map(name => rm(join(directory, name), {force: true})));
	}};
}
