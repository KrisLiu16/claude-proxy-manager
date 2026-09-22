import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {applyChromeProfileLanguage, browserLocale, chromeNetworkArguments, lastUsedChromeProfile, validateClaudeAuthorizationUrl} from '../src/browser-login.js';

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

test('Chrome login arguments force HTTP proxy and block common direct paths', () => {
	const args = chromeNetworkArguments(43210, 'en-US', '/tmp/empty-cache');
	assert.ok(args.includes('--proxy-server=http://127.0.0.1:43210'));
	assert.ok(args.includes('--proxy-bypass-list=<-loopback>'));
	assert.ok(args.includes('--disable-extensions'));
	assert.ok(args.includes('--disable-sync'));
	assert.ok(args.includes('--disable-quic'));
	assert.ok(args.includes('--dns-prefetch-disable'));
	assert.ok(args.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp'));
	assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
	assert.ok(args.includes('--disk-cache-dir=/tmp/empty-cache'));
});

test('Chrome profile language is applied temporarily and restored without losing later changes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cpm-chrome-language-'));
	const profile = join(root, 'Default');
	const path = join(profile, 'Preferences');
	await mkdir(profile);
	await writeFile(path, JSON.stringify({intl: {accept_languages: 'zh-CN,zh', selected_languages: 'zh-CN,zh'}, existing: true}));
	const lease = await applyChromeProfileLanguage(root, 'Default', 'en-US');
	const applied = JSON.parse(await readFile(path, 'utf8')) as any;
	assert.equal(applied.intl.accept_languages, 'en-US,en');
	assert.equal(applied.intl.selected_languages, 'en-US,en');
	applied.changedDuringLogin = true;
	await writeFile(path, JSON.stringify(applied));
	await lease.restore();
	const restored = JSON.parse(await readFile(path, 'utf8')) as any;
	assert.equal(restored.intl.accept_languages, 'zh-CN,zh');
	assert.equal(restored.intl.selected_languages, 'zh-CN,zh');
	assert.equal(restored.changedDuringLogin, true);
});
