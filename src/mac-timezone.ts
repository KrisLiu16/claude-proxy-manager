import {spawn} from 'node:child_process';

export type MacTimezoneLease = {
	original: string;
	target: string;
	changed: boolean;
	restore: () => Promise<void>;
};

function validTimezone(value: string): boolean {
	try { new Intl.DateTimeFormat('en-US', {timeZone: value}).format(); return !/[\r\n\0]/.test(value); }
	catch { return false; }
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function privilegedSetTimezone(timezone: string): Promise<void> {
	if (!validTimezone(timezone)) throw new Error(`无效的 macOS 时区：${timezone}`);
	const script = 'on run argv\n  do shell script (item 1 of argv) with administrator privileges\nend run';
	const command = `/usr/sbin/systemsetup -settimezone ${shellQuote(timezone)} >/dev/null`;
	const result = await new Promise<{code: number; stderr: string}>(resolve => {
		const child = spawn('/usr/bin/osascript', ['-e', script, command], {stdio: ['ignore', 'ignore', 'pipe']});
		const stderr: Buffer[] = [];
		child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
		child.once('error', error => resolve({code: 1, stderr: error.message}));
		child.once('close', code => resolve({code: code ?? 1, stderr: Buffer.concat(stderr).toString('utf8').trim()}));
	});
	if (result.code !== 0) throw new Error(result.stderr || 'macOS 管理员授权被取消或时区修改失败');
}

export async function acquireMacTimezone(target: string): Promise<MacTimezoneLease> {
	if (process.platform !== 'darwin') throw new Error('macOS 时区切换只能在 macOS 上执行');
	if (!validTimezone(target)) throw new Error(`无效的 macOS 时区：${target}`);
	const original = Intl.DateTimeFormat().resolvedOptions().timeZone;
	if (original === target) return {original, target, changed: false, restore: async () => {}};
	await privilegedSetTimezone(target);
	let restored = false;
	return {
		original,
		target,
		changed: true,
		restore: async () => {
			if (restored) return;
			restored = true;
			await privilegedSetTimezone(original);
		},
	};
}
