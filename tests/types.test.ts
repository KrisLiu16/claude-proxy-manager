import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeNoProxy, parseProxySpec} from '../src/types.js';

test('parseProxySpec preserves colons inside the password', () => {
	assert.deepEqual(parseProxySpec('proxy.example:8022:alice:p:a:ss'), {
		host: 'proxy.example',
		port: 8022,
		user: 'alice',
		password: 'p:a:ss',
	});
});

test('parseProxySpec rejects malformed values', () => {
	for (const value of ['', 'host:port:user:pass', 'host:70000:user:pass', 'host:80:user', 'host@evil:80:user:pass']) {
		assert.throws(() => parseProxySpec(value));
	}
});

test('normalizeNoProxy trims and deduplicates entries', () => {
	assert.deepEqual(normalizeNoProxy('example.com, .example.com,example.com,10.0.0.1'), [
		'example.com',
		'.example.com',
		'10.0.0.1',
	]);
});
