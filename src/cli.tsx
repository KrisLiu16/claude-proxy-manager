#!/usr/bin/env node
import React from 'react';
import {Command} from 'commander';
import {render} from 'ink';
import {App} from './app.js';
import {ProfileStore} from './config.js';
import {SecretStore} from './secrets.js';
import {SSHClient} from './ssh.js';
import type {HostProfile} from './types.js';
import {statusSummary} from './types.js';
import {inspectProxyRuntime, readRuntimeConfig, runBridge, runClaudeProxy, stopBridge} from './proxy-runtime.js';
import {applyRemoteConfig, remoteStatus, toggleRemote} from './remote.js';
import {VERSION} from './version.js';

async function handleRuntimeMode(): Promise<boolean> {
	const command = process.argv[2];
	if (command === 'proxy') {
		process.exitCode = await runClaudeProxy(process.argv.slice(3));
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
	if (command === '__stop-bridge') {
		await stopBridge((await readRuntimeConfig()).httpPort);
		return true;
	}
	if (command === '__remote-check') {
		process.stdout.write(`${JSON.stringify(await remoteStatus())}\n`);
		return true;
	}
	if (command === '__remote-apply-config') {
		await applyRemoteConfig();
		return true;
	}
	if (command === '__remote-toggle') {
		await toggleRemote(process.argv[3] === 'on');
		return true;
	}
	if (command === '__local-check') {
		process.stdout.write(`${JSON.stringify(await inspectProxyRuntime())}\n`);
		return true;
	}
	return false;
}

let handledRuntimeMode = false;
try {
	handledRuntimeMode = await handleRuntimeMode();
} catch (error) {
	console.error(`cpm: ${(error as Error).message}`);
	process.exitCode = 1;
	handledRuntimeMode = true;
}

const program = new Command();
program
	.name('cpm')
	.description('通过 SSH 管理开发机，并内置 Claude 代理运行时')
	.version(VERSION)
	.option('--config <path>', '本地配置文件路径');

async function context(): Promise<{
	store: ProfileStore;
	secrets: SecretStore;
	ssh: SSHClient;
	hosts: HostProfile[];
}> {
	const options = program.opts<{config?: string}>();
	const store = new ProfileStore(options.config);
	return {store, secrets: new SecretStore(), ssh: new SSHClient(), hosts: await store.load()};
}

function findHost(hosts: HostProfile[], name: string): HostProfile {
	const host = hosts.find(item => item.name === name);
	if (!host) throw new Error(`找不到机器配置 ${name}`);
	return host;
}

program.action(async () => {
	const values = await context();
	render(<App initialHosts={values.hosts} store={values.store} secrets={values.secrets} ssh={values.ssh}/>);
});

program.command('list').description('列出机器配置').action(async () => {
	const {hosts} = await context();
	for (const host of hosts) {
		console.log(`${host.name.padEnd(16)} ${host.sshHost.padEnd(24)} ${host.proxyHost}:${host.proxyPort} replace=${host.replaceClaude} no_proxy=${host.noProxy.join(',')}`);
	}
});

program.command('check <name>').description('检查远端状态和代理连通性').action(async name => {
	const {hosts, ssh} = await context();
	console.log(statusSummary(await ssh.check(findHost(hosts, String(name)))));
});

program.command('proxy [args...]').description('使用当前机器配置的代理运行 Claude Code');

program.command('install <name>').description('检查并安装官方 Claude 与 cpm 运行时').action(async name => {
	const {hosts, ssh} = await context();
	await ssh.install(findHost(hosts, String(name)));
	console.log('Claude 与 cpm 运行时已就绪');
});

program.command('setup <name>').description('安装、配置并应用默认替换开关').action(async name => {
	const {hosts, ssh, secrets} = await context();
	const host = findHost(hosts, String(name));
	const password = secrets.get(host.name);
	if (!password) throw new Error('本机机密配置中没有代理密码，请先在 TUI 中编辑该机器');
	console.log(statusSummary(await ssh.setup(host, password)));
});

for (const [command, enabled] of [['enable', true], ['disable', false]] as const) {
	program.command(`${command} <name>`)
		.description(enabled ? '默认把 claude 路由到 cpm proxy' : '关闭默认路由')
		.action(async name => {
			const {hosts, ssh, store} = await context();
			const host = findHost(hosts, String(name));
			const next = {...host, replaceClaude: enabled};
			await ssh.setReplaceClaude(next, enabled);
			await store.save(hosts.map(item => item.name === next.name ? next : item));
			console.log(enabled ? '默认替换已开启' : '默认替换已关闭');
		});
}

if (!handledRuntimeMode) program.parseAsync().catch(error => {
	console.error(`cpm: ${(error as Error).message}`);
	process.exitCode = 1;
});
