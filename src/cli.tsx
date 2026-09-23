#!/usr/bin/env node
import React from 'react';
import {Command} from 'commander';
import {render} from 'ink';
import {App, type LaunchTarget} from './app.js';
import {checkLocal, prepareLocal, readLocalSettings, setReplaceClaude} from './local-setup.js';
import {readRuntimeConfig, resolvedRuntimeEnvironment, runBridge, runClaudeProxy, runGenericSandbox, stopBridge} from './proxy-runtime.js';
import {ensureContainerImage, ensurePersistentVolumes, prepareDockerEngine} from './isolated-sandbox.js';
import {runContainerCommand} from './container-relay.js';
import {VERSION} from './version.js';
import {machineFacts} from './host-baseline.js';
import {TerminalProgress} from './progress-display.js';
import {CheckStream} from './check-stream.js';

async function runtimeMode(): Promise<boolean> {
	const command = process.argv[2];
	if (command === 'proxy') { process.exitCode = await runClaudeProxy(process.argv.slice(3)); return true; }
	if (command === 'sandbox') { process.exitCode = await runGenericSandbox(process.argv.slice(3)); return true; }
	if (command === 'enter') {
		const raw = process.argv.slice(3);
		const args = raw[0] === '--' ? raw.slice(1) : raw;
		process.exitCode = await runGenericSandbox(args.length ? args : ['bash']);
		return true;
	}
	if (command === 'exec') {
		const raw = process.argv.slice(3);
		const args = raw[0] === '--' ? raw.slice(1) : raw;
		if (!args.length) throw new Error('cpm exec 后需要指定命令；例如 cpm exec -- git status');
		process.exitCode = await runGenericSandbox(args);
		return true;
	}
	if (command === '__container-run') {
		if (!process.argv[3]) throw new Error('独立容器缺少启动命令');
		process.exitCode = await runContainerCommand(process.argv[3], process.argv.slice(4));
		return true;
	}
	if (command === '__container-facts') { process.stdout.write(`${JSON.stringify(await machineFacts())}\n`); return true; }
	if (command === '__container-prepare') {
		await prepareDockerEngine();
		const resolved = await resolvedRuntimeEnvironment();
		const config = await readRuntimeConfig();
		await ensurePersistentVolumes();
		process.stdout.write(`${await ensureContainerImage({...config, ...resolved})}\n`);
		return true;
	}
	if (command === '__proxy-bridge') {
		const configIndex = process.argv.indexOf('--config');
		const portIndex = process.argv.indexOf('--port');
		const tokenIndex = process.argv.indexOf('--health-token');
		if (configIndex < 0 || portIndex < 0 || tokenIndex < 0) throw new Error('bridge 参数缺失');
		await runBridge(process.argv[configIndex + 1]!, Number(process.argv[portIndex + 1]), process.argv[tokenIndex + 1]!);
		return true;
	}
	if (command === '__stop-bridge') { await stopBridge((await readRuntimeConfig()).httpPort); return true; }
	return false;
}

let handled = false;
try { handled = await runtimeMode(); }
catch (error) { console.error(`cpm: ${(error as Error).message}`); process.exitCode = 1; handled = true; }

const program = new Command();
program.name('cpm')
	.description('在当前 Linux 开发机创建持久、隔离的容器工作区，并经指定 SOCKS5 代理运行命令')
	.version(VERSION)
	.addHelpText('after', `
快速开始：
  curl -fsSL https://raw.githubusercontent.com/KrisLiu16/claude-proxy-manager/refs/heads/main/install.sh | sh
  cpm                         打开本机设置面板，填写代理和白名单
  cpm setup                   安装缺失的 Claude、准备 Docker 与持久工作区
  cpm check                   逐项验证代理、区域、Docker 与持久卷
  cpm enter                   进入共享的 /workspace，打开 bash
  cpm exec -- git status      在共享工作区执行一条命令
  cpm proxy                   在新容器中运行 Claude
  cpm proxy codex             在新容器中运行 Codex

TUI 快捷键：e 配置，s 准备，c 检查，1 进入，2 Claude，3 Codex，h 帮助。

每次命令会启动新容器；/home/node 与 /workspace 使用同一组具名卷持久保存。
CPM 不设置 CPU、内存或进程数上限。Codex 首次登录使用设备码流程。
每次启动会自动对照宿主发行版、内核、架构和常用工具版本；Codex 默认由 CPM 外层容器隔离。
容器外的宿主代码不会自动出现，请在 /workspace 中克隆仓库。
隔离降低环境暴露风险，但不能保证抵御内核漏洞或宿主 Docker 管理员。`);

program.action(async () => {
	const initial = await readLocalSettings();
	let target: LaunchTarget | undefined;
	const tui = render(<App initial={initial} onLaunch={selected => { target = selected; }}/>);
	await tui.waitUntilExit();
	if (target === 'enter') process.exitCode = await runGenericSandbox(['bash']);
	else if (target === 'claude') process.exitCode = await runClaudeProxy([]);
	else if (target === 'codex') process.exitCode = await runClaudeProxy(['codex']);
});

program.command('help [command]').description('查看 CPM 或某个命令的用法').action((name?: string) => {
	if (!name) { program.outputHelp(); return; }
	const selected = program.commands.find(command => command.name() === name);
	if (!selected) throw new Error(`未知命令：${name}`);
	selected.outputHelp();
});

program.command('setup').description('在本机准备 Claude、Docker 镜像与持久工作区').action(async () => {
	const started = Date.now();
	const progress = new TerminalProgress('CPM 本机准备');
	const stream = new CheckStream('CPM 本机设置检查', line => progress.line(line));
	let rowsShown = false;
	let image: string;
	try { image = await prepareLocal(update => progress.update(update), item => { rowsShown = true; stream.row(item); }); }
	finally { progress.finish(); if (rowsShown) stream.finish(); }
	console.log(`就绪：${image}（${Math.round((Date.now() - started) / 1000)} 秒）`);
});

program.command('check').description('在本机逐项实时输出代理、容器隔离前提与持久卷结果').action(async () => {
	const progress = new TerminalProgress('CPM 逐项检查');
	const stream = new CheckStream('CPM 本机逐项检查', line => {
		if (process.stdout.isTTY && process.stderr.isTTY) progress.line(line);
		else process.stdout.write(`${line}\n`);
	});
	stream.start();
	let rows: Awaited<ReturnType<typeof checkLocal>>;
	try { rows = await checkLocal(update => progress.update(update), item => stream.row(item)); }
	catch (error) { stream.row({name: '本机检查异常', state: 'FAIL', value: (error as Error).message}); throw error; }
	finally { progress.finish(); stream.finish(); }
	if (rows.some(item => item.state === 'FAIL')) process.exitCode = 3;
});

for (const [name, enabled] of [['enable', true], ['disable', false]] as const) {
	program.command(name).description(enabled ? '默认将 claude 命令路由到 cpm proxy' : '关闭 claude 默认路由')
		.action(async () => { await setReplaceClaude(enabled); console.log(`默认路由已${enabled ? '开启' : '关闭'}；新开 shell 后生效`); });
}

program.command('proxy [args...]').description('在新容器中运行 Claude；也可运行 Codex');
program.command('sandbox [args...]').description('在新容器中运行任意命令，默认 Claude');
program.command('enter [args...]').description('进入持久工作区，默认打开 bash');
program.command('exec [args...]').description('在持久工作区执行一条命令');

if (!handled) program.parseAsync().catch(error => {
	console.error(`cpm: ${(error as Error).message}`);
	process.exitCode = 1;
});
