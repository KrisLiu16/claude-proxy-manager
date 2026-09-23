import React, {useEffect, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import TextInput from 'ink-text-input';
import {checkLocal, prepareLocal, readLocalSettings, saveLocalSettings, setReplaceClaude, type LocalSettings, type Progress} from './local-setup.js';
import {findClaude} from './local-setup.js';
import {inspectContainerPrerequisites, inspectPersistentVolumes} from './isolated-sandbox.js';
import type {CheckItem} from './types.js';
import {VERSION} from './version.js';

type Initial = Awaited<ReturnType<typeof readLocalSettings>>;
type Mode = 'home' | 'edit' | 'audit' | 'help';
export type LaunchTarget = 'enter' | 'claude' | 'codex';
type Snapshot = {docker: string; claude: string; volumes: string};
type Field = 'proxySpec' | 'noProxy' | 'timezone' | 'locale' | 'httpPort';
const fields: Field[] = ['proxySpec', 'noProxy', 'timezone', 'locale', 'httpPort'];
const labels: Record<Field, string> = {
	proxySpec: '代理 HOST:PORT:USER:PASSWORD',
	noProxy: '直连白名单（域名/IP/CIDR，逗号分隔）',
	timezone: '时区（auto 或 IANA 名称）',
	locale: '语言（auto 或 en_US.UTF-8）',
	httpPort: '本地 bridge 端口',
};

function color(state: CheckItem['state']): 'green' | 'red' | 'yellow' | 'cyan' | 'gray' {
	return state === 'PASS' ? 'green' : state === 'FAIL' ? 'red' : state === 'WARN' ? 'yellow' : state === 'INFO' ? 'cyan' : 'gray';
}

function short(value: string, max = 74): string {
	return [...value].length > max ? `${[...value].slice(0, max - 1).join('')}…` : value;
}

function bar(percent: number): string {
	const done = Math.round(Math.max(0, Math.min(100, percent)) / 5);
	return `${'█'.repeat(done)}${'░'.repeat(20 - done)}`;
}

export function App({initial, platform = process.platform, onLaunch}: {initial: Initial; platform?: NodeJS.Platform; onLaunch?: (target: LaunchTarget) => void}): React.JSX.Element {
	const {exit} = useApp();
	const [current, setCurrent] = useState(initial);
	const [form, setForm] = useState<LocalSettings>(initial.settings);
	const [mode, setMode] = useState<Mode>('home');
	const [focus, setFocus] = useState(0);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<Progress>();
	const [seconds, setSeconds] = useState(0);
	const [message, setMessage] = useState(initial.configured ? '按 s 准备工作区，按 c 逐项检查' : '先按 e 填写代理，然后按 s 准备工作区');
	const [messageColor, setMessageColor] = useState<'green' | 'red' | 'white'>('white');
	const [checks, setChecks] = useState<CheckItem[]>([]);
	const [rowIndex, setRowIndex] = useState(0);
	const [snapshot, setSnapshot] = useState<Snapshot>({docker: '读取中', claude: '读取中', volumes: '读取中'});
	const [prepared, setPrepared] = useState(false);

	async function refresh(): Promise<void> {
		const [next, claude, docker] = await Promise.all([readLocalSettings(), findClaude(), inspectContainerPrerequisites()]);
		const volumes = docker.some(item => item.state === 'FAIL') ? [] : await inspectPersistentVolumes();
		setCurrent(next);
		setSnapshot({
			claude: claude ? '已安装' : '未安装，准备时自动下载',
			docker: docker.some(item => item.state === 'FAIL') ? '未就绪' : '可用 · seccomp · AppArmor',
			volumes: volumes[0]?.state === 'PASS' ? '已登记并保留' : volumes[0]?.state === 'FAIL' ? '异常，查看检查结果' : '尚未创建',
		});
	}

	useEffect(() => { void refresh().catch(() => {}); }, []);
	useEffect(() => {
		if (!busy) { setSeconds(0); return; }
		const started = Date.now();
		const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
		return () => clearInterval(timer);
	}, [busy]);

	async function operation(label: string, action: (report: (progress: Progress) => void) => Promise<string>): Promise<void> {
		setBusy(true);
		setMessage(label);
		setMessageColor('white');
		setProgress({percent: 0, label});
		try {
			const result = await action(update => { setProgress(update); setMessage(update.label); });
			setMessage(result);
			setMessageColor('green');
			await refresh();
		} catch (error) {
			setMessage((error as Error).message);
			setMessageColor('red');
		} finally {
			setBusy(false);
			setProgress(undefined);
		}
	}

	function openEditor(): void {
		setForm({...current.settings, proxySpec: ''});
		setFocus(0);
		setMode('edit');
		setMessage('保存后会更新当前开发机的代理与默认路由');
		setMessageColor('white');
	}

	async function save(): Promise<void> {
		await operation('保存本机配置', async () => {
			await saveLocalSettings(form);
			setMode('home');
			setPrepared(false);
			return '配置已保存；按 s 准备或更新容器镜像';
		});
	}

	async function audit(): Promise<void> {
		setMode('audit');
		setChecks([]);
		setRowIndex(0);
		let nextIndex = 0;
		await operation('逐项检查代理与隔离环境', async report => {
			await checkLocal(report, item => {
				setChecks(value => [...value, item]);
				setRowIndex(nextIndex++);
			});
			return '逐项检查完成；↑/↓ 查看全部结果';
		});
	}

	useInput((input, key) => {
		if (busy) return;
		if (mode === 'edit') {
			if (key.escape) { setMode('home'); setMessage('已取消编辑'); return; }
			if (key.tab || key.downArrow) { setFocus(value => (value + 1) % fields.length); return; }
			if (key.upArrow || key.shift && key.tab) { setFocus(value => (value - 1 + fields.length) % fields.length); return; }
			if (key.ctrl && input === 't') { setForm(value => ({...value, replaceClaude: !value.replaceClaude})); return; }
			if (key.ctrl && input === 's') { void save(); return; }
			return;
		}
		if (mode === 'audit') {
			if (key.escape || input === 'b') { setMode('home'); return; }
			if (key.upArrow || input === 'k') { setRowIndex(value => Math.max(0, value - 1)); return; }
			if (key.downArrow || input === 'j') { setRowIndex(value => Math.min(checks.length - 1, value + 1)); return; }
			if (input === 'c' || input === 'r') { void audit(); return; }
		}
		if (mode === 'help' && (key.escape || input === 'b')) { setMode('home'); return; }
		if (input === 'q' || key.ctrl && input === 'c') { exit(); return; }
		if (mode !== 'home') return;
		if (input === 'e') openEditor();
		else if (input === 's') {
			setMode('audit');
			setChecks([]);
			setRowIndex(0);
			let nextIndex = 0;
			void operation('准备本机隔离工作区', async report => {
				const image = await prepareLocal(report, item => {
					setChecks(value => [...value, item]);
					setRowIndex(nextIndex++);
				});
				setPrepared(true);
				return `工作区已就绪 · ${image}`;
			});
		}
		else if (input === 'c') void audit();
		else if (input === 't') void operation('切换默认路由', async () => {
			const enabled = !current.settings.replaceClaude;
			await setReplaceClaude(enabled);
			return `claude 默认路由已${enabled ? '开启' : '关闭'}；新 shell 生效`;
		});
		else if (input === 'r') void operation('刷新本机状态', async () => '状态已刷新');
		else if (input === '1' || input === '2' || input === '3') {
			if (!current.configured) { setMessage('先按 e 填写代理并保存'); setMessageColor('red'); return; }
			onLaunch?.(input === '1' ? 'enter' : input === '2' ? 'claude' : 'codex');
			exit();
		}
		else if (input === 'h' || input === '?') setMode('help');
	});

	const counts = {pass: checks.filter(row => row.state === 'PASS').length, fail: checks.filter(row => row.state === 'FAIL').length, warn: checks.filter(row => row.state === 'WARN').length};
	const pageSize = Math.max(6, Math.min(14, (process.stdout.rows || 25) - 12));
	const first = Math.max(0, Math.min(rowIndex - Math.floor(pageSize / 2), Math.max(0, checks.length - pageSize)));
	const currentRow = checks[rowIndex];
	const rowValueWidth = Math.max(12, Math.min(52, (process.stdout.columns || 80) - 44));

	return <Box flexDirection="column">
		<Box><Text bold color="cyan">CPM</Text><Text dimColor>  {VERSION}  /  当前开发机  /  {platform === 'linux' ? 'Linux' : `${platform} · 隔离容器不可用`}</Text></Box>
		{mode === 'home' && <>
			<Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginTop={1}>
				<Text bold>配置与准备</Text>
				<Text>代理出口节点  <Text color={current.configured ? 'green' : 'yellow'}>{short(current.endpoint, 36)}</Text>  ·  密码仅存在本机 0600 配置</Text>
				<Text>直连白名单    {short(current.settings.noProxy || '无；只允许经代理访问', 56)}</Text>
				<Text>时区 / 语言   {current.settings.timezone} / {current.settings.locale}  ·  bridge {current.settings.httpPort}</Text>
				<Text>Claude        {snapshot.claude}  ·  默认路由 <Text color={current.settings.replaceClaude ? 'green' : 'yellow'}>{current.settings.replaceClaude ? '开启' : '关闭'}</Text></Text>
				<Text>Docker        {snapshot.docker}</Text>
				<Text>资源          CPM 不设 CPU / 内存 / 进程数上限</Text>
			</Box>
			<Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={1} marginTop={1}>
				<Text bold>共享工作区  <Text color={prepared ? 'green' : 'yellow'}>{prepared ? '本次已准备' : snapshot.volumes}</Text></Text>
				<Text>/home/node   持久卷 · CLI 登录、用户工具与配置</Text>
				<Text>/workspace  持久卷 · 仓库、代码与虚拟环境</Text>
				<Text>每条命令启动新容器；后台进程、/tmp 与根文件系统不会延续。</Text>
				<Text dimColor>宿主 HOME/项目不挂载；容器无直接外网，网络经受控 sidecar。</Text>
			</Box>
			<Box marginTop={1}><Text dimColor>流程  e 编辑代理  →  s 准备镜像  →  c 逐项检查  →  1/2/3 开始工作</Text></Box>
			<Box><Text>1 进入  2 Claude  3 Codex  e 编辑  s 准备  c 检查  t 路由  h 帮助  q 退出</Text></Box>
		</>}
		{mode === 'edit' && <>
			<Box marginTop={1}><Text bold color="cyan">编辑当前开发机</Text></Box>
			<Text dimColor>已保存代理：{current.endpoint}。密码输入框留空表示沿用原代理；新配置需填完整四段。</Text>
			<Box flexDirection="column" marginTop={1}>
				{fields.map((field, index) => <Box key={field}>
					<Text color={focus === index ? 'cyan' : 'gray'}>{focus === index ? '❯ ' : '  '}{labels[field]}: </Text>
					<TextInput value={form[field]} onChange={value => setForm(valueForm => ({...valueForm, [field]: value}))}
						onSubmit={() => setFocus(value => (value + 1) % fields.length)} focus={focus === index}
						{...(field === 'proxySpec' ? {mask: '*'} : {})}/>
				</Box>)}
			</Box>
			<Box marginTop={1}><Text>Ctrl+T  claude 默认进入 CPM：<Text color={form.replaceClaude ? 'green' : 'yellow'}>{form.replaceClaude ? '开启' : '关闭'}</Text></Text></Box>
			<Text dimColor>白名单示例：naiveai-dev.com,.naiveai-dev.com,10.0.0.0/8</Text>
			<Text dimColor>Tab/↑/↓ 切换  Ctrl+S 保存  Esc 取消</Text>
		</>}
		{mode === 'audit' && <>
			<Box marginTop={1}><Text bold>逐项检查  </Text><Text color="green">{counts.pass} OK  </Text><Text color="yellow">{counts.warn} WARN  </Text><Text color="red">{counts.fail} FAIL</Text></Box>
			<Box flexDirection="column" borderStyle="round" borderColor={counts.fail ? 'red' : 'green'} paddingX={1}>
				{checks.slice(first, first + pageSize).map((row, offset) => <Text key={`${first + offset}-${row.name}`} color={rowIndex === first + offset ? 'white' : color(row.state)} inverse={rowIndex === first + offset}>
					{rowIndex === first + offset ? '❯' : ' '} {row.state.padEnd(4)}  {short(row.name, 24).padEnd(24)} {short(row.value, rowValueWidth)}
				</Text>)}
			</Box>
			<Text dimColor>{checks.length ? `${rowIndex + 1}/${checks.length}` : '无检查项'}  ↑/↓ 逐项查看  c 重查  Esc 返回</Text>
			{currentRow && <Text>详情：{currentRow.detail || currentRow.value}</Text>}
		</>}
		{mode === 'help' && <>
			<Box marginTop={1}><Text bold color="cyan">使用方法</Text></Box>
			<Text>cpm               打开此面板，设置本机代理、白名单和路由</Text>
			<Text>cpm setup         安装缺失的 Claude，准备 Docker、镜像与持久卷</Text>
			<Text>cpm check         检查配置、代理出口、时区、Docker 和持久卷</Text>
			<Text>cpm enter         在共享 /workspace 中打开交互式 bash</Text>
			<Text>cpm exec -- git status   在共享 /workspace 执行单条命令</Text>
			<Text>cpm proxy         启动 Claude；cpm proxy codex 启动 Codex</Text>
			<Text>Codex 首次登录使用设备码；在浏览器中由你完成验证</Text>
			<Text>Codex 默认由 CPM 外层隔离；内层 user namespace 在此容器中不可用</Text>
			<Text>TUI 快捷键 1 / 2 / 3 可直接进入、启动 Claude 或 Codex</Text>
			<Text>cpm sandbox -- python3 -V   在同一工作区运行其他程序</Text>
			<Box marginTop={1}><Text dimColor>HOME 和 /workspace 持久；每条命令是新容器，后台进程不会延续。</Text></Box>
			<Text dimColor>仅 Linux 支持隔离容器。容器隔离仍依赖宿主内核和 Docker 安全性。</Text>
			<Text dimColor>Esc 返回  q 退出；完整帮助运行 cpm help。</Text>
		</>}
		<Box borderStyle="round" borderColor={messageColor} paddingX={1} marginTop={1}>
			<Text color={messageColor}>{busy && progress ? `${bar(progress.percent)} ${String(progress.percent).padStart(3)}%  ${message}  ${seconds}s` : message}</Text>
		</Box>
	</Box>;
}
