import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

export type GeoProfile = {
	ip: string;
	country: string;
	countryCode: string;
	region: string;
	city: string;
	isp: string;
	asn: string;
	timezone: string;
	languages: string;
	locale: string;
	source: 'ipapi.co' | 'ipwho.is';
	detectedAt: string;
};

type CacheDocument = {fingerprint: string; profile: GeoProfile};
export type JsonRequest = (host: string, path: string) => Promise<unknown>;

function cachePath(): string {
	return process.env.CPM_GEO_CACHE || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'cpm', 'geolocation.json');
}

function text(value: unknown): string {
	const result = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
	return result.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 512);
}

export function localeFromLanguages(languages: string, countryCode: string): string {
	const first = languages.split(',').map(value => value.trim()).find(Boolean) || 'en-US';
	const [language = 'en', region] = first.replace('_', '-').split('-');
	const territory = (region || countryCode || 'US').toUpperCase();
	return `${language.toLowerCase()}_${territory}.UTF-8`;
}

function parseIpapi(value: unknown): GeoProfile {
	const data = value as Record<string, unknown>;
	if (!data || data.error || !text(data.ip) || !text(data.timezone)) throw new Error(text(data?.reason) || text(data?.message) || 'ipapi.co 返回的数据不完整');
	const countryCode = text(data.country_code || data.country);
	const languages = text(data.languages);
	return {
		ip: text(data.ip),
		country: text(data.country_name),
		countryCode,
		region: text(data.region),
		city: text(data.city),
		isp: text(data.org),
		asn: text(data.asn),
		timezone: text(data.timezone),
		languages,
		locale: localeFromLanguages(languages, countryCode),
		source: 'ipapi.co',
		detectedAt: new Date().toISOString(),
	};
}

function parseIpwho(value: unknown): GeoProfile {
	const data = value as Record<string, unknown>;
	if (!data || data.success === false || !text(data.ip)) throw new Error(text(data?.message) || 'ipwho.is 返回的数据不完整');
	const timezone = (data.timezone || {}) as Record<string, unknown>;
	const connection = (data.connection || {}) as Record<string, unknown>;
	const countryCode = text(data.country_code);
	const languages = countryCode === 'US' ? 'en-US' : '';
	const timezoneId = text(timezone.id);
	if (!timezoneId) throw new Error('ipwho.is 没有返回时区');
	return {
		ip: text(data.ip),
		country: text(data.country),
		countryCode,
		region: text(data.region),
		city: text(data.city),
		isp: text(connection.isp || connection.org),
		asn: text(connection.asn || connection.asn_number),
		timezone: timezoneId,
		languages,
		locale: localeFromLanguages(languages, countryCode),
		source: 'ipwho.is',
		detectedAt: new Date().toISOString(),
	};
}

export async function lookupGeoProfile(ip: string, request: JsonRequest): Promise<GeoProfile> {
	const errors: string[] = [];
	try { return parseIpapi(await request('ipapi.co', `/${encodeURIComponent(ip)}/json/`)); }
	catch (error) { errors.push(`ipapi.co: ${(error as Error).message}`); }
	try { return parseIpwho(await request('ipwho.is', `/${encodeURIComponent(ip)}`)); }
	catch (error) { errors.push(`ipwho.is: ${(error as Error).message}`); }
	throw new Error(errors.join('；'));
}

export async function loadCachedGeo(fingerprint: string, maxAgeMs: number): Promise<GeoProfile | undefined> {
	try {
		const document = JSON.parse(await readFile(cachePath(), 'utf8')) as CacheDocument;
		const age = Date.now() - Date.parse(document.profile.detectedAt);
		if (document.fingerprint === fingerprint && age >= 0 && age <= maxAgeMs) return document.profile;
	} catch {}
	return undefined;
}

export async function saveCachedGeo(fingerprint: string, profile: GeoProfile): Promise<void> {
	const path = cachePath();
	await mkdir(dirname(path), {recursive: true, mode: 0o700});
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify({fingerprint, profile}, null, 2)}\n`, {mode: 0o600});
	await rename(temporary, path);
}
