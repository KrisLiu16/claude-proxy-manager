import assert from 'node:assert/strict';
import {mkdtemp, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {loadCachedGeo, localeFromLanguages, lookupGeoProfile, saveCachedGeo, type GeoProfile} from '../src/geolocation.js';

test('locale is derived from the first API language and country', () => {
	assert.equal(localeFromLanguages('en-US,es-US,haw,fr', 'US'), 'en_US.UTF-8');
	assert.equal(localeFromLanguages('de,en', 'DE'), 'de_DE.UTF-8');
	assert.equal(localeFromLanguages('', 'JP'), 'en_US.UTF-8');
});

test('geolocation uses ipapi fields and falls back to ipwho', async () => {
	const primary = await lookupGeoProfile('203.0.113.1', async host => {
		assert.equal(host, 'ipapi.co');
		return {ip: '203.0.113.1', city: 'Columbus', region: 'Ohio', country_code: 'US', country_name: 'United States', timezone: 'America/New_York', languages: 'en-US,es-US', org: 'Example ISP', asn: 'AS64500'};
	});
	assert.equal(primary.timezone, 'America/New_York');
	assert.equal(primary.locale, 'en_US.UTF-8');
	assert.equal(primary.isp, 'Example ISP');
	assert.equal(primary.asn, 'AS64500');

	const fallback = await lookupGeoProfile('203.0.113.2', async host => {
		if (host === 'ipapi.co') throw new Error('rate limited');
		return {success: true, ip: '203.0.113.2', city: 'Paris', region: 'Ile-de-France', country: 'France', country_code: 'FR', timezone: {id: 'Europe/Paris'}, connection: {isp: 'Fallback ISP'}};
	});
	assert.equal(fallback.source, 'ipwho.is');
	assert.equal(fallback.timezone, 'Europe/Paris');
});

test('geolocation cache is private and scoped to the proxy fingerprint', async () => {
	const folder = await mkdtemp(join(tmpdir(), 'cpm-geo-'));
	const path = join(folder, 'geo.json');
	const previous = process.env.CPM_GEO_CACHE;
	process.env.CPM_GEO_CACHE = path;
	const profile: GeoProfile = {ip: '203.0.113.3', country: 'United States', countryCode: 'US', region: 'Ohio', city: 'Columbus', isp: 'Example ISP', asn: 'AS64500', timezone: 'America/New_York', languages: 'en-US', locale: 'en_US.UTF-8', source: 'ipapi.co', detectedAt: new Date().toISOString()};
	try {
		await saveCachedGeo('fingerprint-a', profile);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await loadCachedGeo('fingerprint-a', 60_000))?.city, 'Columbus');
		assert.equal(await loadCachedGeo('fingerprint-b', 60_000), undefined);
	} finally {
		if (previous === undefined) delete process.env.CPM_GEO_CACHE; else process.env.CPM_GEO_CACHE = previous;
	}
});
