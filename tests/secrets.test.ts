import assert from 'node:assert/strict';
import {mkdtemp, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {SecretStore} from '../src/secrets.js';

test('secret store persists separately with mode 0600', async () => {
	const folder = await mkdtemp(join(tmpdir(), 'cpm-secrets-'));
	const path = join(folder, 'private', 'secrets.json');
	const store = new SecretStore(path);
	store.set('dev', 'secret-value');
	assert.equal(store.get('dev'), 'secret-value');
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	store.delete('dev');
	assert.equal(store.get('dev'), undefined);
});

