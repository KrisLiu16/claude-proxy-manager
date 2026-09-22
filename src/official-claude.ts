import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, open, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

export type ClaudePlatform =
	| 'linux-x64'
	| 'linux-x64-musl'
	| 'linux-arm64'
	| 'linux-arm64-musl'
	| 'darwin-x64'
	| 'darwin-arm64';

type NpmDocument = {
	version?: string;
	optionalDependencies?: Record<string, string>;
	dist?: {tarball?: string; integrity?: string};
};

export type DownloadedClaude = {
	version: string;
	packageName: string;
	binaryPath: string;
	cleanup: () => Promise<void>;
};
export type ByteProgress = (received: number, total: number) => void;

const mainPackage = '@anthropic-ai/claude-code';

export function platformPackage(platform: ClaudePlatform): string {
	return `@anthropic-ai/claude-code-${platform}`;
}

function registryPath(packageName: string): string {
	return packageName.replace('/', '%2F');
}

async function npmDocument(registry: string, packageName: string, suffix: string): Promise<NpmDocument> {
	const url = `${registry.replace(/\/$/, '')}/${registryPath(packageName)}/${encodeURIComponent(suffix)}`;
	const response = await fetch(url, {
		headers: {accept: 'application/json'},
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`npm 注册表返回 HTTP ${response.status}: ${packageName}@${suffix}`);
	return await response.json() as NpmDocument;
}

function dependency(key: string, value: string): {packageName: string; version: string} {
	if (value.startsWith('npm:')) {
		const index = value.lastIndexOf('@');
		if (index <= 4) throw new Error(`无效的 npm alias: ${value}`);
		return {packageName: value.slice(4, index), version: value.slice(index + 1)};
	}
	return {packageName: key, version: value};
}

function sha512Integrity(value: string): string {
	const found = value.split(/\s+/).find(item => item.startsWith('sha512-'));
	if (!found) throw new Error('Claude 平台包没有 sha512 integrity');
	return found.slice('sha512-'.length);
}

async function downloadAndVerify(url: string, destination: string, expected: string, progress?: ByteProgress): Promise<void> {
	const response = await fetch(url, {signal: AbortSignal.timeout(10 * 60_000)});
	if (!response.ok || !response.body) throw new Error(`下载 Claude Code 失败: HTTP ${response.status}`);
	const total = Number(response.headers.get('content-length') || 0);
	let received = 0;
	const file = await open(destination, 'w', 0o600);
	const hash = createHash('sha512');
	try {
		const reader = response.body.getReader();
		while (true) {
			const {done, value} = await reader.read();
			if (done) break;
			received += value.length;
			progress?.(received, total);
			hash.update(value);
			let offset = 0;
			while (offset < value.length) {
				const {bytesWritten} = await file.write(value, offset, value.length - offset, null);
				offset += bytesWritten;
			}
		}
	} finally {
		await file.close();
	}
	const actual = hash.digest('base64');
	if (actual !== expected) throw new Error('Claude Code 平台包的 SHA-512 integrity 校验失败');
}

async function run(command: string, args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
		const stderr: Buffer[] = [];
		child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
		child.on('error', reject);
		child.on('close', code => {
			if (code === 0) resolve();
			else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `${command} 退出码 ${code}`));
		});
	});
}

export async function downloadOfficialClaude(
	platform: ClaudePlatform,
	registry = 'https://registry.npmjs.org',
	progress?: ByteProgress,
): Promise<DownloadedClaude> {
	const work = await mkdtemp(join(tmpdir(), 'cpm-claude-'));
	try {
		const main = await npmDocument(registry, mainPackage, 'latest');
		if (!main.version) throw new Error('Claude Code 主包没有版本号');
		const key = platformPackage(platform);
		const declared = main.optionalDependencies?.[key];
		if (!declared) throw new Error(`${mainPackage}@${main.version} 没有平台包 ${key}`);
		const selected = dependency(key, declared);
		const platformDocument = await npmDocument(registry, selected.packageName, selected.version);
		const tarball = platformDocument.dist?.tarball;
		const integrity = platformDocument.dist?.integrity;
		if (!tarball || !integrity) throw new Error(`${selected.packageName}@${selected.version} 缺少 tarball 或 integrity`);
		const archive = join(work, 'package.tgz');
		await downloadAndVerify(tarball, archive, sha512Integrity(integrity), progress);
		const tree = join(work, 'tree');
		await mkdir(tree);
		await run('tar', ['-xzf', archive, '-C', tree, '--strip-components=1', 'package/claude']);
		const binaryPath = join(tree, 'claude');
		const info = await stat(binaryPath);
		if (!info.isFile() || info.size === 0) throw new Error('Claude Code 平台包里没有 package/claude');
		return {
			version: selected.version,
			packageName: selected.packageName,
			binaryPath,
			cleanup: async () => rm(work, {recursive: true, force: true}),
		};
	} catch (error) {
		await rm(work, {recursive: true, force: true});
		throw error;
	}
}
