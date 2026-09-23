import assert from 'node:assert/strict';
import test from 'node:test';
import {TerminalProgress} from '../src/progress-display.js';

test('non-interactive progress reports each stage once', () => {
	const output: string[] = [];
	const stream = {isTTY: false, write(value: string) { output.push(value); return true; }} as unknown as NodeJS.WriteStream;
	const progress = new TerminalProgress('CPM 检查', stream);
	progress.update({percent: 5, label: '代理认证'});
	progress.update({percent: 5, label: '代理认证'});
	progress.update({percent: 50, label: '出口 IP'});
	progress.finish();
	assert.equal(output.length, 2);
	assert.match(output[0] || '', /5%.*代理认证/);
	assert.match(output[1] || '', /50%.*出口 IP/);
});
