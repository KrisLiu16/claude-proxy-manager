import {constants as fsConstants} from 'node:fs';
import {spawn} from 'node:child_process';
import {isIP} from 'node:net';
import {access, chmod, copyFile, mkdir, readFile, rename} from 'node:fs/promises';
import {homedir, arch, platform} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {downloadOfficialClaude, type ClaudePlatform} from './official-claude.js';
import {ensureContainerImage, ensurePersistentVolumes, inspectContainerPrerequisites, inspectCurrentImageCompatibility, inspectImageCompatibility, inspectPersistentVolumes, prepareDockerEngine} from './isolated-sandbox.js';
import {imageRecipeForHost, machineFacts} from './host-baseline.js';
import {inspectProxyRuntime, readRuntimeConfig, resolveAutomaticEnvironment, stopBridge, type RuntimeConfig} from './proxy-runtime.js';
import {normalizeNoProxy, parseProxySpec, type CheckItem} from './types.js';

const START = '# >>> cpm >>>';
const END = '# <<< cpm <<<';

export type Progress = {percent: number; label: string};
export type ProgressReporter = (progress: Progress) => void;
export type LocalSettings = {proxySpec: string; noProxy: string; timezone: string; locale: string; httpPort: string; replaceClaude: boolean};

export function localConfigPath(): string {
	return process.env.CPM_PROXY_CONFIG || join(homedir(), '.config', 'cpm', 'proxy.env');
}

async function executable(path: string): Promise<boolean> {
	try { await access(path, fsConstants.X_OK); return true; } catch { return false; }
}

export async function findClaude(): Promise<string> {
	try {
		const configured = (await readRuntimeConfig()).claudeBin;
		if (configured && await executable(configured)) return configured;
	} catch {}
	for (const candidate of [join(homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/usr/bin/claude']) {
		if (await executable(candidate)) return candidate;
	}
	for (const folder of (process.env.PATH || '').split(':')) {
		const candidate = resolve(folder || '.', 'claude');
		if (candidate.includes('/.local/share/cpm/shim-bin/')) continue;
		if (await executable(candidate)) return candidate;
	}
	return '';
}

function configLine(value: string, name: string): string {
	if (/[\r\n\0]/.test(value)) throw new Error(`${name} 不能包含换行或 NUL`);
	return value;
}

function validateSettings(input: LocalSettings, existingProxy = ''): {proxyUrl: string; noProxy: string; timezone: string; locale: string; httpPort: number} {
	let proxyUrl = existingProxy;
	if (input.proxySpec.trim()) {
		const parsed = parseProxySpec(input.proxySpec);
		const address = parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host;
		proxyUrl = `socks5h://${encodeURIComponent(parsed.user)}:${encodeURIComponent(parsed.password)}@${address}:${parsed.port}`;
	}
	if (!proxyUrl) throw new Error('请填写代理 HOST:PORT:USER:PASSWORD');
	const noProxy = normalizeNoProxy(configLine(input.noProxy, '白名单')).join(',');
	for (const item of normalizeNoProxy(noProxy)) {
		const [network = '', bitsText = ''] = item.split('/');
		const family = isIP(network);
		const bits = Number(bitsText);
		const cidr = item.split('/').length === 2 && family > 0 && Number.isInteger(bits) && bits >= 0 && bits <= (family === 4 ? 32 : 128);
		const domain = /^\.?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/.test(item);
		if (!cidr && !domain && !isIP(item)) throw new Error(`无效的白名单项：${item}；仅支持域名、IP 或 CIDR，不带协议和路径`);
	}
	const timezone = configLine(input.timezone.trim() || 'auto', '时区');
	const locale = configLine(input.locale.trim() || 'auto', '语言');
	if (timezone !== 'auto' && (!/^[A-Za-z0-9_+\-/]+$/.test(timezone) || timezone.includes('..'))) throw new Error('时区需填写 IANA 名称或 auto');
	if (locale !== 'auto' && !/^(?:[A-Za-z]{2,3}_[A-Za-z]{2,3}|C)\.UTF-8$/.test(locale)) throw new Error('语言需填写 en_US.UTF-8 等格式或 auto');
	const httpPort = Number(input.httpPort);
	if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65_535) throw new Error('本地 bridge 端口必须在 1-65535');
	return {proxyUrl, noProxy, timezone, locale, httpPort};
}

function proxyEndpoint(url: string): string {
	try { const parsed = new URL(url); return `${parsed.hostname}:${parsed.port}`; } catch { return '未配置'; }
}

export async function readLocalSettings(): Promise<{settings: LocalSettings; endpoint: string; configured: boolean}> {
	const config = await readRuntimeConfig();
	let replaceClaude = true;
	try { replaceClaude = !/^REPLACE_CLAUDE=0$/m.test(await readFile(localConfigPath(), 'utf8')); } catch {}
	return {
		settings: {proxySpec: '', noProxy: config.noProxy, timezone: config.timezone, locale: config.locale, httpPort: String(config.httpPort), replaceClaude},
		endpoint: proxyEndpoint(config.proxyUrl), configured: Boolean(config.proxyUrl),
	};
}

export async function saveLocalSettings(input: LocalSettings): Promise<void> {
	const previous = await readRuntimeConfig();
	const next = validateSettings(input, previous.proxyUrl);
	const claudeBin = await findClaude();
	const path = localConfigPath();
	await mkdir(dirname(path), {recursive: true, mode: 0o700});
	const temporary = `${path}.${process.pid}.tmp`;
	const content = [
		`SOCKS5_PROXY=${next.proxyUrl}`, `NO_PROXY=${next.noProxy}`,
		`TZ=${next.timezone}`, `LANG=${next.locale}`, `HTTP_PORT=${next.httpPort}`,
		`CLAUDE_BIN=${configLine(claudeBin, 'Claude 路径')}`,
		`REPLACE_CLAUDE=${input.replaceClaude ? 1 : 0}`,
	].join('\n');
	await (await import('node:fs/promises')).writeFile(temporary, `${content}\n`, {mode: 0o600});
	await chmod(temporary, 0o600);
	await rename(temporary, path);
	if (previous.httpPort !== next.httpPort) await stopBridge(previous.httpPort);
	await stopBridge(next.httpPort);
	await toggleClaude(input.replaceClaude);
}

export async function setReplaceClaude(enabled: boolean): Promise<void> {
	const current = await readLocalSettings();
	if (!current.configured) throw new Error('先运行 cpm 配置代理');
	await saveLocalSettings({...current.settings, replaceClaude: enabled});
}

function removeBlock(text: string): string {
	while (text.includes(START)) {
		const before = text.slice(0, text.indexOf(START));
		const remainder = text.slice(text.indexOf(START) + START.length);
		const end = remainder.indexOf(END);
		text = end < 0 ? before : `${before.trimEnd()}\n${remainder.slice(end + END.length).trimStart()}`;
	}
	return text.trimEnd();
}

export async function toggleClaude(enabled: boolean): Promise<void> {
	const shimDir = join(homedir(), '.local', 'share', 'cpm', 'shim-bin');
	await mkdir(shimDir, {recursive: true, mode: 0o700});
	const shim = join(shimDir, 'claude');
	await (await import('node:fs/promises')).writeFile(shim, '#!/bin/sh\nexec "$HOME/.local/bin/cpm" proxy "$@"\n', {mode: 0o755});
	await chmod(shim, 0o755);
	const block = `${START}\ncpm_shim_dir="$HOME/.local/share/cpm/shim-bin"\ncase "$PATH" in\n  "$cpm_shim_dir"|"$cpm_shim_dir":*) ;;\n  *) export PATH="$cpm_shim_dir:$PATH" ;;\nesac\nunalias claude 2>/dev/null || true\nunset -f claude 2>/dev/null || true\nclaude() { "$HOME/.local/bin/cpm" proxy "$@"; }\nhash -r 2>/dev/null || true\nunset cpm_shim_dir\n${END}`;
	const names = ['.profile', '.bashrc', '.zshrc'];
	for (const optional of ['.bash_profile', '.bash_login']) {
		try { await access(join(homedir(), optional)); names.push(optional); } catch {}
	}
	for (const name of names) {
		const path = join(homedir(), name);
		let source = '';
		try { source = await readFile(path, 'utf8'); } catch {}
		const cleaned = removeBlock(source);
		await (await import('node:fs/promises')).writeFile(path, `${enabled ? `${cleaned}\n\n${block}`.trimStart() : cleaned}\n`);
	}
}

async function claudeResolution(): Promise<string> {
	const shell = process.env.SHELL || '/bin/sh';
	if (!shell.startsWith('/') || /[\r\n\0]/.test(shell)) return '';
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		return await new Promise(resolve => {
			const child = spawn(shell, ['-lic', 'command -V claude'], {stdio: ['ignore', 'pipe', 'ignore'], signal: controller.signal});
			const output: Buffer[] = [];
			child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
			child.once('error', () => resolve(''));
			child.once('close', code => resolve(code === 0 ? Buffer.concat(output).toString('utf8').trim() : ''));
		});
	} finally { clearTimeout(timer); }
}

export async function checkLocal(report?: ProgressReporter, onRow?: (item: CheckItem) => void): Promise<CheckItem[]> {
	const update = (percent: number, label: string) => report?.({percent, label});
	update(2, '读取代理配置与本机运行时');
	let checks: CheckItem[] = [];
	const add = (item: CheckItem) => { checks.push(item); onRow?.(item); };
	const observed: CheckItem[] = [];
	try { checks = await inspectProxyRuntime('generic', progress => update(Math.max(2, Math.round(progress.percent * 0.7)), progress.label), item => { observed.push(item); onRow?.(item); }); }
	catch (error) { checks = observed; add({name: '代理运行时', state: 'FAIL', value: (error as Error).message}); }
	update(74, '读取宿主系统与开发工具');
	const host = await machineFacts();
	const recipe = imageRecipeForHost(host.os);
	add({name: '宿主发行版', state: recipe.note ? 'WARN' : 'PASS', value: host.os.prettyName || `${host.os.id} ${host.os.versionId}`, detail: recipe.note || `基础镜像 ${recipe.baseImage.split('@')[0]}`});
	update(81, '检查 Docker 安全能力');
	const docker = await inspectContainerPrerequisites();
	for (const item of docker) add(item);
	update(87, '核对持久工作区卷');
	if (!docker.some(row => row.state === 'FAIL')) for (const item of await inspectPersistentVolumes()) add(item);
	if (!docker.some(row => row.state === 'FAIL')) {
		update(93, '逐项对照宿主与当前镜像');
		try {
			const config = await readRuntimeConfig();
			if (config.proxyUrl && config.claudeBin) {
				const resolution = await resolveAutomaticEnvironment(config, false);
				if (resolution.geo || config.timezone !== 'auto' && config.locale !== 'auto') for (const item of await inspectCurrentImageCompatibility(resolution.config)) add(item);
			}
		} catch (error) { add({name: '宿主镜像对照', state: 'INFO', value: (error as Error).message}); }
	}
	const {settings} = await readLocalSettings();
	update(97, '确认 claude 默认路由');
	add({name: 'claude 默认路由', state: settings.replaceClaude ? 'PASS' : 'INFO', value: settings.replaceClaude ? '开启，新 shell 生效' : '关闭'});
	if (settings.replaceClaude) {
		const resolution = await claudeResolution();
		const routed = /is a (?:shell )?function|\.local\/share\/cpm\/shim-bin\/claude|\.local\/bin\/cpm["']? proxy/.test(resolution);
		add({name: 'claude 命令解析', state: routed ? 'PASS' : 'FAIL', value: routed ? 'cpm proxy' : '仍指向原生 Claude', detail: resolution.replaceAll(/\s+/g, ' ').slice(0, 240) || '登录 shell 中找不到 claude'});
	}
	add({name: '容器生命周期', state: 'INFO', value: '每条命令新容器；HOME 与工作区卷持久'});
	add({name: 'CPM 资源配置', state: 'INFO', value: '无额外 CPU/内存/cgroup 进程/连接上限；继承宿主 ulimit'});
	add({name: '容器内验证', state: 'INFO', value: '执行目标命令前再检查直连、权限、DNS 与出口'});
	update(100, '本机逐项检查完成');
	return checks;
}

export async function prepareLocal(report?: ProgressReporter, onRow?: (item: CheckItem) => void): Promise<string> {
	const update = (percent: number, label: string) => report?.({percent, label});
	if (platform() !== 'linux') throw new Error('隔离容器目前只支持 Linux 开发机');
	const settings = await readLocalSettings();
	if (!settings.configured) throw new Error('先运行 cpm，在配置页填写代理并保存');
	update(5, '检查 Docker Engine、seccomp 和 AppArmor');
	await prepareDockerEngine(line => { if (line) update(8, `准备 Docker：${line.slice(0, 65)}`); });
	let claude = await findClaude();
	if (!claude) {
		const architecture = arch();
		if (architecture !== 'x64' && architecture !== 'arm64') throw new Error(`Claude 平台不支持 ${architecture}`);
		const flavor = (await access('/etc/alpine-release').then(() => '-musl').catch(() => ''));
		const target = `linux-${architecture}${flavor}` as ClaudePlatform;
		update(15, `下载并校验官方 Claude Code (${target})`);
		const downloaded = await downloadOfficialClaude(target, 'https://registry.npmjs.org', (received, total) => {
			const ratio = total ? Math.round(received / total * 25) : 0;
			update(15 + ratio, `下载 Claude Code ${(received / 1_048_576).toFixed(1)}${total ? ` / ${(total / 1_048_576).toFixed(1)}` : ''} MiB`);
		});
		try {
			claude = join(homedir(), '.local', 'bin', 'claude');
			await mkdir(dirname(claude), {recursive: true, mode: 0o700});
			const temporary = `${claude}.${process.pid}.tmp`;
			await copyFile(downloaded.binaryPath, temporary);
			await chmod(temporary, 0o755);
			await rename(temporary, claude);
		} finally { await downloaded.cleanup(); }
	}
	update(42, '保存本机 Claude 路径和默认命令路由');
	await saveLocalSettings(settings.settings);
	const config = await readRuntimeConfig();
	update(48, '逐项验证代理、出口 IP 与区域信息');
	const checks = await checkLocal(progress => update(48 + Math.round(progress.percent * 0.20), progress.label), onRow);
	const failed = checks.find(item => item.state === 'FAIL');
	if (failed) throw new Error(`${failed.name}：${failed.value}${failed.detail ? ` (${failed.detail})` : ''}`);
	update(70, '创建或核对持久 HOME 与 /workspace 卷');
	await ensurePersistentVolumes();
	const resolution = await resolveAutomaticEnvironment(config, false);
	if (resolution.error && (config.timezone === 'auto' || config.locale === 'auto') && !resolution.geo) throw new Error(`区域信息探测失败且没有缓存：${resolution.error}`);
	update(78, '准备独立容器镜像；首次构建可能需要几分钟');
	const image = await ensureContainerImage({...config, ...resolution.config}, line => {
		if (/^Step \d+\/\d+|^Fetched|^Successfully/.test(line)) update(82, `构建镜像：${line.slice(0, 65)}`);
	});
	update(95, '逐项对照宿主系统与新镜像');
	const comparison = await inspectImageCompatibility(image);
	for (const item of comparison) onRow?.(item);
	const mismatch = comparison.find(item => item.state === 'FAIL');
	if (mismatch) throw new Error(`${mismatch.name}：${mismatch.value}`);
	update(100, '独立工作区已就绪');
	return image;
}
