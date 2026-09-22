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

const program = new Command();
program
	.name('cpm')
	.description('通过 SSH 管理远端开发机的 claude-proxy')
	.version('0.1.3')
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

program.command('install <name>').description('安装或更新远端启动器').action(async name => {
	const {hosts, ssh} = await context();
	await ssh.install(findHost(hosts, String(name)));
	console.log('启动器安装完成');
});

program.command('setup <name>').description('安装、配置并应用默认替换开关').action(async name => {
	const {hosts, ssh, secrets} = await context();
	const host = findHost(hosts, String(name));
	const password = secrets.get(host.name);
	if (!password) throw new Error('系统钥匙串中没有代理密码，请先在 TUI 中编辑该机器');
	console.log(statusSummary(await ssh.setup(host, password)));
});

for (const [command, enabled] of [['enable', true], ['disable', false]] as const) {
	program.command(`${command} <name>`)
		.description(enabled ? '默认把 claude 路由到 claude-proxy' : '关闭默认路由')
		.action(async name => {
			const {hosts, ssh, store} = await context();
			const host = findHost(hosts, String(name));
			const next = {...host, replaceClaude: enabled};
			await ssh.setReplaceClaude(next, enabled);
			await store.save(hosts.map(item => item.name === next.name ? next : item));
			console.log(enabled ? '默认替换已开启' : '默认替换已关闭');
		});
}

program.parseAsync().catch(error => {
	console.error(`cpm: ${(error as Error).message}`);
	process.exitCode = 1;
});
