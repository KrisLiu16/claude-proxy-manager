import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {release as kernelRelease} from 'node:os';
import type {CheckItem} from './types.js';

export type OsRelease = {id: string; versionId: string; prettyName: string; idLike: string; ubuntuVersionId: string};
export type ImageRecipe = {baseImage: string; family: 'apt'; note?: string};
export type MachineFacts = {os: OsRelease; arch: string; kernel: string; uid: number; gid: number; node: string; python: string; git: string; bubblewrap: string; bubblewrapReady: boolean};

const UBUNTU_2404 = 'ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3';

export function parseOsRelease(raw: string): OsRelease {
	const values = new Map<string, string>();
	for (const line of raw.split('\n')) {
		const found = line.match(/^([A-Z_]+)=(.*)$/);
		if (!found) continue;
		let value = found[2] || '';
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		values.set(found[1]!, value);
	}
	return {
		id: values.get('ID') || '', versionId: values.get('VERSION_ID') || '',
		prettyName: values.get('PRETTY_NAME') || '', idLike: values.get('ID_LIKE') || '',
		ubuntuVersionId: values.get('UBUNTU_VERSION_ID') || '',
	};
}

export function imageRecipeForHost(host: OsRelease): ImageRecipe {
	const valid = (value: string) => /^[0-9][A-Za-z0-9._-]*$/.test(value);
	if (host.id === 'ubuntu' && valid(host.versionId)) {
		return {baseImage: host.versionId === '24.04' ? UBUNTU_2404 : `ubuntu:${host.versionId}`, family: 'apt'};
	}
	if (host.id === 'debian' && valid(host.versionId)) return {baseImage: `debian:${host.versionId}-slim`, family: 'apt'};
	if (host.idLike.split(/\s+/).includes('ubuntu') && valid(host.ubuntuVersionId)) {
		return {baseImage: host.ubuntuVersionId === '24.04' ? UBUNTU_2404 : `ubuntu:${host.ubuntuVersionId}`, family: 'apt', note: `宿主 ${host.prettyName} 基于 Ubuntu ${host.ubuntuVersionId}`};
	}
	return {baseImage: UBUNTU_2404, family: 'apt', note: `无法直接映射 ${host.prettyName || host.id || '未知宿主发行版'}，使用 Ubuntu 24.04 并逐项显示差异`};
}

async function versionOf(program: string, args: string[]): Promise<string> {
	return await new Promise(resolve => {
		const output: Buffer[] = [];
		const child = spawn(program, args, {stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000});
		child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
		child.once('error', () => resolve(''));
		child.once('close', code => resolve(code === 0 ? Buffer.concat(output).toString('utf8').trim().split('\n')[0] || '' : ''));
	});
}

async function commandWorks(program: string, args: string[]): Promise<boolean> {
	return await new Promise(resolve => {
		const child = spawn(program, args, {stdio: 'ignore', timeout: 5_000});
		child.once('error', () => resolve(false));
		child.once('close', code => resolve(code === 0));
	});
}

export async function machineFacts(): Promise<MachineFacts> {
	const [os, node, python, git, bubblewrap, bubblewrapReady] = await Promise.all([
		readFile('/etc/os-release', 'utf8').then(parseOsRelease),
		versionOf('node', ['--version']), versionOf('python3', ['--version']),
		versionOf('git', ['--version']), versionOf('bwrap', ['--version']),
		commandWorks('bwrap', ['--unshare-user', '--ro-bind', '/', '/', 'true']),
	]);
	return {os, arch: process.arch, kernel: kernelRelease(), uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1, node, python, git, bubblewrap, bubblewrapReady};
}

export function compareMachineFacts(host: MachineFacts, image: MachineFacts): CheckItem[] {
	const row = (name: string, state: CheckItem['state'], local: string, sandbox: string): CheckItem => ({name, state, value: `宿主 ${local} / 容器 ${sandbox}`});
	const version = (facts: MachineFacts) => `${facts.os.id} ${facts.os.versionId}`.trim();
	const checks: CheckItem[] = [
		row('发行版', version(host) === version(image) ? 'PASS' : 'WARN', version(host), version(image)),
		row('发行版补丁', host.os.prettyName === image.os.prettyName ? 'PASS' : 'WARN', host.os.prettyName, image.os.prettyName),
		row('CPU 架构', host.arch === image.arch ? 'PASS' : 'FAIL', host.arch, image.arch),
		row('Linux 内核', host.kernel === image.kernel ? 'PASS' : 'FAIL', host.kernel, image.kernel),
		row('UID/GID', host.uid === image.uid && host.gid === image.gid ? 'PASS' : 'FAIL', `${host.uid}:${host.gid}`, `${image.uid}:${image.gid}`),
	];
	for (const [label, key] of [['Node', 'node'], ['Python', 'python'], ['Git', 'git']] as const) {
		const local = host[key] || '未安装';
		const sandbox = image[key] || '未安装';
		checks.push(row(label, !image[key] ? 'FAIL' : !host[key] ? 'INFO' : local === sandbox ? 'PASS' : 'WARN', local, sandbox));
	}
	checks.push({name: 'bubblewrap', state: image.bubblewrap ? 'PASS' : 'WARN', value: image.bubblewrap || '容器未安装'});
	checks.push({name: '内层用户命名空间', state: image.bubblewrapReady ? 'PASS' : 'WARN', value: image.bubblewrapReady ? '可创建' : 'Docker/AppArmor 阻止；Codex 默认使用 CPM 外层隔离'});
	return checks;
}
