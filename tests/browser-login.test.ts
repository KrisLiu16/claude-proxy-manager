import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {browserLocale, lastUsedChromeProfile, validateClaudeAuthorizationUrl} from '../src/browser-login.js';

test('Claude login URL requires an official HTTPS host and OAuth protections', () => {
	const valid = validateClaudeAuthorizationUrl('https://claude.com/cai/oauth/authorize?state=abc&code_challenge=xyz');
	assert.equal(valid.hostname, 'claude.com');
	assert.throws(
		() => validateClaudeAuthorizationUrl('https://claude.com.evil.example/oauth?state=abc&code_challenge=xyz'),
		/拒绝打开/,
	);
	assert.throws(
		() => validateClaudeAuthorizationUrl('http://claude.com/oauth?state=abc&code_challenge=xyz'),
		/拒绝打开/,
	);
	assert.throws(
		() => validateClaudeAuthorizationUrl('https://claude.com/oauth?state=abc'),
		/PKCE/,
	);
});

test('POSIX locale is converted to a browser locale', () => {
	assert.equal(browserLocale('en_US.UTF-8'), 'en-US');
	assert.equal(browserLocale('zh_CN.UTF-8'), 'zh-CN');
});

test('Chrome profile selection follows the last-used original profile', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cpm-chrome-source-'));
	await writeFile(join(root, 'Local State'), JSON.stringify({profile: {last_used: 'Profile 2'}}));
	assert.equal(await lastUsedChromeProfile(root), 'Profile 2');
	await writeFile(join(root, 'Local State'), JSON.stringify({profile: {last_used: '../../Other'}}));
	assert.equal(await lastUsedChromeProfile(root), 'Default');
});
