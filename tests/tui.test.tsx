import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToString} from 'ink';
import {App} from '../src/app.js';

test('TUI explains persistent volumes and fresh containers on the current machine', () => {
	const output = renderToString(<App initial={{
		configured: true,
		endpoint: 'proxy.example:8022',
		settings: {proxySpec: '', noProxy: 'naiveai-dev.com,.naiveai-dev.com', timezone: 'auto', locale: 'auto', httpPort: '17891', replaceClaude: true},
	}}/>);
	assert.match(output, /当前开发机/);
	assert.match(output, /proxy\.example:8022/);
	assert.match(output, /\/home\/node/);
	assert.match(output, /\/workspace/);
	assert.match(output, /每条命令启动新容器/);
	assert.doesNotMatch(output, /SSH|选择机器|远端/);
});
