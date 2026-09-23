import assert from 'node:assert/strict';
import test from 'node:test';
import {CheckStream} from '../src/check-stream.js';

test('completed checks are written in arrival order with a final count', () => {
	const lines: string[] = [];
	const stream = new CheckStream('CPM 流式检查', line => lines.push(line));
	stream.row({name: '代理网关 TCP', state: 'PASS', value: '已连接'});
	assert.match(lines.at(-1) || '', /代理网关 TCP.*OK.*已连接/);
	stream.row({name: 'SOCKS5 认证', state: 'FAIL', value: '超时'});
	assert.match(lines.at(-1) || '', /SOCKS5 认证.*FAIL.*超时/);
	stream.finish();
	assert.match(lines.at(-1) || '', /2 项，1 FAIL/);
});
