import React, {useMemo, useRef, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import TextInput from 'ink-text-input';
import type {ProfileStore} from './config.js';
import type {SecretStore} from './secrets.js';
import type {HostProfile} from './types.js';
import {DEFAULT_LOCALE, DEFAULT_TIMEZONE, normalizeNoProxy, parseProxySpec, statusSummary, validateHost} from './types.js';
import type {SSHClient} from './ssh.js';

type Props = {
	initialHosts: HostProfile[];
	store: ProfileStore;
	secrets: SecretStore;
	ssh: SSHClient;
};

type FormState = {
	name: string;
	sshHost: string;
	proxySpec: string;
	proxyHost: string;
	proxyPort: string;
	proxyUser: string;
	password: string;
	noProxy: string;
	timezone: string;
	locale: string;
	claudeConfigDir: string;
	replaceClaude: boolean;
};

const fieldNames = ['name', 'sshHost', 'proxySpec', 'proxyHost', 'proxyPort', 'proxyUser', 'password', 'noProxy', 'timezone', 'locale', 'claudeConfigDir'] as const;
type FieldName = (typeof fieldNames)[number];

const labels: Record<FieldName, string> = {
	name: '配置名称',
	sshHost: 'SSH alias/user@host',
	proxySpec: '快速导入 HOST:PORT:USER:PASSWORD（可选）',
	proxyHost: '代理主机',
	proxyPort: '代理端口',
	proxyUser: '代理用户',
	password: '代理密码',
	noProxy: 'NO_PROXY（逗号分隔）',
	timezone: 'Claude 进程时区（auto 自动）',
	locale: 'Claude 进程 locale（auto 自动）',
	claudeConfigDir: 'CLAUDE_CONFIG_DIR（可选）',
};

function emptyForm(): FormState {
	return {
		name: '',
		sshHost: '',
		proxySpec: '',
		proxyHost: '',
		proxyPort: '',
		proxyUser: '',
		password: '',
		noProxy: '',
		timezone: DEFAULT_TIMEZONE,
		locale: DEFAULT_LOCALE,
		claudeConfigDir: '',
		replaceClaude: true,
	};
}

export function App({initialHosts, store, secrets, ssh}: Props): React.JSX.Element {
	const {exit} = useApp();
	const [hosts, setHosts] = useState(initialHosts);
	const [cursor, setCursor] = useState(0);
	const [mode, setMode] = useState<'list' | 'edit'>('list');
	const [form, setForm] = useState<FormState>(emptyForm);
	const [focus, setFocus] = useState(0);
	const [originalName, setOriginalName] = useState('');
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState('选择机器后按 s 一键安装和应用配置');
	const [statusColor, setStatusColor] = useState<'white' | 'green' | 'red'>('white');
	const [pendingDelete, setPendingDelete] = useState('');
	const sessionPasswords = useRef(new Map<string, string>());

	const selected = hosts[cursor];
	const orderedHosts = useMemo(() => hosts, [hosts]);

	function passwordFor(name: string): string | undefined {
		const inMemory = sessionPasswords.current.get(name);
		if (inMemory) return inMemory;
		try {
			const password = secrets.get(name);
			if (password) sessionPasswords.current.set(name, password);
			return password;
		} catch {
			return undefined;
		}
	}

	function openEditor(host?: HostProfile): void {
		setOriginalName(host?.name ?? '');
		setForm(host ? {
			name: host.name,
			sshHost: host.sshHost,
			proxySpec: '',
			proxyHost: host.proxyHost,
			proxyPort: host.proxyPort ? String(host.proxyPort) : '',
			proxyUser: host.proxyUser,
			password: passwordFor(host.name) ?? '',
			noProxy: host.noProxy.join(','),
			timezone: host.timezone,
			locale: host.locale,
			claudeConfigDir: host.claudeConfigDir,
			replaceClaude: host.replaceClaude,
		} : emptyForm());
		setFocus(0);
		setMode('edit');
		setPendingDelete('');
		setStatus('填写配置后按 Ctrl+S 保存');
		setStatusColor('white');
	}

	async function saveEditor(): Promise<void> {
		let proxyHost = form.proxyHost.trim();
		let proxyPort = Number(form.proxyPort);
		let proxyUser = form.proxyUser.trim();
		let password = form.password;
		if (form.proxySpec.trim()) {
			try {
				const parsed = parseProxySpec(form.proxySpec);
				proxyHost = parsed.host;
				proxyPort = parsed.port;
				proxyUser = parsed.user;
				password = parsed.password;
			} catch (error) {
				setStatus((error as Error).message);
				setStatusColor('red');
				return;
			}
		}
		const host: HostProfile = {
			name: form.name.trim(),
			sshHost: form.sshHost.trim(),
			proxyHost,
			proxyPort,
			proxyUser,
			noProxy: normalizeNoProxy(form.noProxy),
			replaceClaude: form.replaceClaude,
			timezone: form.timezone.trim(),
			locale: form.locale.trim(),
			claudeConfigDir: form.claudeConfigDir.trim(),
		};
		try {
			validateHost(host, true);
			if (hosts.some(item => item.name === host.name && item.name !== originalName)) {
				throw new Error('配置名称已存在');
			}
			const next = originalName
				? hosts.map(item => item.name === originalName ? host : item)
				: [...hosts, host];
			next.sort((left, right) => left.name.localeCompare(right.name));
			await store.save(next);
			let warning = '';
			if (password) {
				sessionPasswords.current.set(host.name, password);
				try {
					secrets.set(host.name, password);
				} catch {
					warning = '；本地机密文件写入失败，密码仅保留到本次退出';
				}
			}
			if (originalName && originalName !== host.name) {
				try { secrets.delete(originalName); } catch {}
				sessionPasswords.current.delete(originalName);
			}
			setHosts(next);
			setCursor(Math.max(0, next.findIndex(item => item.name === host.name)));
			setMode('list');
			setStatus(`配置已保存${warning}；按 s 应用到远端`);
			setStatusColor('green');
		} catch (error) {
			setStatus((error as Error).message);
			setStatusColor('red');
		}
	}

	async function runOperation(label: string, operation: () => Promise<string>): Promise<void> {
		setBusy(true);
		setStatus(label);
		setStatusColor('white');
		try {
			setStatus(await operation());
			setStatusColor('green');
		} catch (error) {
			setStatus((error as Error).message);
			setStatusColor('red');
		} finally {
			setBusy(false);
		}
	}

	useInput((input, key) => {
		if (busy) return;
		if (mode === 'edit') {
			if (key.escape) {
				setMode('list');
				setStatus('已取消编辑');
				return;
			}
			if (key.tab || key.downArrow) {
				setFocus(value => (value + 1) % fieldNames.length);
				return;
			}
			if (key.shift && key.tab || key.upArrow) {
				setFocus(value => (value - 1 + fieldNames.length) % fieldNames.length);
				return;
			}
			if (key.ctrl && input === 't') {
				setForm(value => ({...value, replaceClaude: !value.replaceClaude}));
				return;
			}
			if (key.ctrl && input === 's') {
				void saveEditor();
			}
			return;
		}

		if (input !== 'd') setPendingDelete('');
		if (input === 'q' || (key.ctrl && input === 'c')) exit();
		else if (key.upArrow || input === 'k') setCursor(value => Math.max(0, value - 1));
		else if (key.downArrow || input === 'j') setCursor(value => Math.min(hosts.length - 1, value + 1));
		else if (input === 'a') openEditor();
		else if ((input === 'e' || key.return) && selected) openEditor(selected);
		else if (input === 'c' && selected) {
			void runOperation(`正在检查 ${selected.name}`, async () => {
				const result = await ssh.check(selected);
				return `检查完成\n${statusSummary(result)}`;
			});
		} else if (input === 'i' && selected) {
			void runOperation(`正在检查并安装 Claude/cpm 到 ${selected.name}`, async () => {
				await ssh.install(selected);
				return 'Claude 与 cpm 运行时已就绪';
			});
		} else if (input === 's' && selected) {
			const password = passwordFor(selected.name);
			if (!password) {
				setStatus('没有可用的代理密码；按 e 编辑并输入密码');
				setStatusColor('red');
				return;
			}
			void runOperation(`正在安装并配置 ${selected.name}`, async () => {
				const result = await ssh.setup(selected, password);
				return `远端配置完成\n${statusSummary(result)}`;
			});
		} else if (input === 't' && selected) {
			const nextHost = {...selected, replaceClaude: !selected.replaceClaude};
			void runOperation('正在切换默认 claude', async () => {
				await ssh.setReplaceClaude(nextHost, nextHost.replaceClaude);
				const next = hosts.map(item => item.name === nextHost.name ? nextHost : item);
				await store.save(next);
				setHosts(next);
				return '默认替换已更新；重新登录 shell 后生效';
			});
		} else if (input === 'd' && selected) {
			if (pendingDelete !== selected.name) {
				setPendingDelete(selected.name);
				setStatus(`再次按 d 删除 ${selected.name} 的本地配置；远端文件不会删除`);
				setStatusColor('red');
				return;
			}
			void (async () => {
				const next = hosts.filter(item => item.name !== selected.name);
				await store.save(next);
				try { secrets.delete(selected.name); } catch {}
				sessionPasswords.current.delete(selected.name);
				setHosts(next);
				setCursor(value => Math.max(0, Math.min(value, next.length - 1)));
				setPendingDelete('');
				setStatus('本地配置已删除；远端文件保持不变');
				setStatusColor('green');
			})();
		}
	});

	if (mode === 'edit') {
		return <Box flexDirection="column">
			<Text bold color="cyan">编辑机器配置</Text>
			<Text dimColor>密码保存在独立的 0600 机密文件中，不写入主机配置</Text>
			<Box flexDirection="column" marginTop={1}>
				{fieldNames.map((name, index) => <Box key={name}>
					<Text color={focus === index ? 'cyan' : 'white'}>{focus === index ? '> ' : '  '}{labels[name]}: </Text>
					<TextInput
						value={form[name]}
						onChange={value => setForm(current => ({...current, [name]: value}))}
						onSubmit={() => setFocus(value => (value + 1) % fieldNames.length)}
						focus={focus === index}
						{...(name === 'password' || name === 'proxySpec' ? {mask: '*'} : {})}
					/>
				</Box>)}
			</Box>
			<Box marginTop={1}><Text>Ctrl+T 默认将 claude 路由到 cpm proxy: <Text color={form.replaceClaude ? 'green' : 'yellow'}>{form.replaceClaude ? '开启' : '关闭'}</Text></Text></Box>
			<Box marginTop={1}><Text color={statusColor}>{status}</Text></Box>
			<Box marginTop={1}><Text dimColor>Tab/Shift+Tab 切换字段  Ctrl+T 开关替换  Ctrl+S 保存  Esc 取消</Text></Box>
		</Box>;
	}

	return <Box flexDirection="column">
		<Text bold color="cyan">CPM</Text>
		<Text dimColor>每台开发机独立配置；cpm 通过 SSH 分发自身并运行内置代理</Text>
		<Box flexDirection="column" marginTop={1}>
			{orderedHosts.length === 0 && <Text>  暂无机器，按 a 添加</Text>}
			{orderedHosts.map((host, index) => <Text key={host.name} inverse={index === cursor}>
				{index === cursor ? '>' : ' '} {host.name.padEnd(16)} {host.sshHost.padEnd(24)} proxy={host.proxyHost}:{host.proxyPort} whitelist={host.noProxy.length} claude→proxy={host.replaceClaude ? 'on' : 'off'}
			</Text>)}
		</Box>
		<Box borderStyle="round" borderColor={statusColor} paddingX={1} marginTop={1}>
			<Text color={statusColor}>{busy ? '… ' : ''}{status}</Text>
		</Box>
		<Box marginTop={1}><Text dimColor>↑/↓ 选择  a 添加  e 编辑  c 逐项检查  i 安装 Claude/cpm  s 一键设置  t 切换默认替换  d 删除  q 退出</Text></Box>
	</Box>;
}
