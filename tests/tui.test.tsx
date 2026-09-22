import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToString} from 'ink';
import {App} from '../src/app.js';
import {ProfileStore} from '../src/config.js';
import {SecretStore} from '../src/secrets.js';
import {SSHClient} from '../src/ssh.js';

test('TUI host list renders without a terminal', () => {
	const output = renderToString(<App
		initialHosts={[{
			name: 'dev',
			sshHost: 'cpu',
			proxyHost: 'proxy.example',
			proxyPort: 8022,
			proxyUser: 'alice',
			noProxy: ['.internal'],
			replaceClaude: true,
			timezone: 'America/Los_Angeles',
			locale: 'en_US.UTF-8',
			claudeConfigDir: '',
		}]}
		store={new ProfileStore('/tmp/not-used-cpm-test.json')}
		secrets={new SecretStore()}
		ssh={new SSHClient()}
	/>);
	assert.match(output, /^CPM/m);
	assert.match(output, /dev/);
	assert.match(output, /claude→proxy=on/);
});
