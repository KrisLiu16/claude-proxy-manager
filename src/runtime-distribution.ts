import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {chmod, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {ByteProgress, ClaudePlatform} from './official-claude.js';
import {RELEASE_REPOSITORY, VERSION} from './version.js';

export type RuntimeDownload = {binaryPath: string; cleanup: () => Promise<void>};

function runtimeAsset(platform: ClaudePlatform): string {
	if (platform.endsWith('-musl')) throw new Error(`cpm 单文件暂不支持 musl 开发机：${platform}`);
	const normalized = platform;
	if (!['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].includes(normalized)) throw new Error(`cpm 不支持远端平台 ${platform}`);
	return `cpm-${normalized}`;
}

function localPlatform(): string {
	const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform;
	const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
	return `${os}-${arch}`;
}

function compiledExecutable(): boolean {
	return !['node', 'nodejs', 'bun'].includes(basename(process.execPath));
}

async function sha256(path: string): Promise<string> {
	return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function fetchFile(url: string, path: string, progress?: ByteProgress): Promise<void> {
	const response = await fetch(url, {redirect: 'follow'});
	if (!response.ok || !response.body) throw new Error(`下载 cpm 运行时失败：HTTP ${response.status}`);
	const total = Number(response.headers.get('content-length') || 0);
	let received = 0;
	const source = Readable.fromWeb(response.body as never);
	source.on('data', chunk => {
		received += Buffer.byteLength(chunk);
		progress?.(received, total);
	});
	await pipeline(source, createWriteStream(path, {mode: 0o755}));
}

export async function runtimeForRemote(platform: ClaudePlatform, progress?: ByteProgress): Promise<RuntimeDownload> {
	const asset = runtimeAsset(platform);
	const requested = asset.slice(4);
	const override = process.env.CPM_SELF_BINARY;
	if (override) return {binaryPath: override, cleanup: async () => {}};
	if (requested === localPlatform() && compiledExecutable()) {
		return {binaryPath: process.execPath, cleanup: async () => {}};
	}
	const folder = await mkdtemp(join(tmpdir(), 'cpm-runtime-'));
	const binaryPath = join(folder, asset);
	try {
		const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${VERSION}`;
		const checksumsResponse = await fetch(`${base}/checksums.txt`, {redirect: 'follow'});
		if (!checksumsResponse.ok) throw new Error(`下载 cpm 校验文件失败：HTTP ${checksumsResponse.status}`);
		const checksums = await checksumsResponse.text();
		const expected = checksums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts.at(-1) === asset)?.[0];
		if (!expected) throw new Error(`发布校验文件中没有 ${asset}`);
		await fetchFile(`${base}/${asset}`, binaryPath, progress);
		const actual = await sha256(binaryPath);
		if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`cpm 运行时 SHA-256 校验失败：${asset}`);
		await chmod(binaryPath, 0o755);
		return {binaryPath, cleanup: () => rm(folder, {recursive: true, force: true})};
	} catch (error) {
		await rm(folder, {recursive: true, force: true});
		throw error;
	}
}
