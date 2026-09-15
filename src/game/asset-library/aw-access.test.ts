import { afterEach, expect, test } from 'bun:test';
import { parseAssetLibraryAccessResult as parse, resolveAssetLibrarySelection } from './aw-access';
const root = 'https://assets.example.test';
const schemaVersion = 'forgeax.asset3d-access-check/1.0.0';
const failure = (code: string, extra = {}) => ({ status: 1, stdout: JSON.stringify({ schemaVersion, ok: false, error: { code, ...extra } }) });
const success = { status: 0, stdout: JSON.stringify({ schemaVersion, ok: true, value: { authentication: 'sandbox-key', downloadOrigins: ['https://cdn.example.test:443'] } }) };
test('successful access retains validated download origins', () => {
  expect(parse(success, root)).toEqual({ serviceRoot: root, authentication: 'sandbox-key', downloadOrigins: ['https://cdn.example.test:443'] });
});
for (const code of ['search_timeout', 'search_upstream_error', 'asset3d_access_validation_inconclusive']) {
  test(`preserves recognized producer cause ${code} without raw messages`, () => {
    try { parse(failure(code, { message: 'SECRET_SENTINEL' }), root); throw new Error('expected failure'); }
    catch (error) { expect(String(error)).toContain(code); expect(String(error)).not.toContain('SECRET_SENTINEL'); expect(String(error)).not.toContain('asset3d_api_key_invalid'); }
  });
}
test('legacy conflated provider failure does not establish invalid credentials', () => {
  expect(() => parse(failure('asset3d_api_key_invalid_or_unavailable'), root)).toThrow('invalid credentials are not established');
});
test('timeout takes precedence over invalid or partial output', () => {
  expect(() => parse({ ...success, error: Object.assign(new Error('SECRET_SENTINEL'), { code: 'ETIMEDOUT' }) }, root)).toThrow('asset3d_access_check_timeout');
});
test('spawn failures and terminated processes are not authentication failures', () => {
  for (const result of [{ ...success, error: Object.assign(new Error('secret'), { code: 'ENOENT' }) }, { ...success, status: null, signal: 'SIGTERM' }, { ...success, status: 9 }]) {
    expect(() => parse(result, root)).toThrow('asset3d_access_check_process_failed');
  }
});
test('malformed and wrong-schema responses cannot supply trusted error codes', () => {
  for (const stdout of [null, 'not json', 'null', '[]', JSON.stringify({ ok: false, error: { code: 'search_timeout' } })]) {
    expect(() => parse({ status: 1, stdout }, root)).toThrow('asset3d_access_validation_failed');
  }
});
test('unknown and prototype property error codes are not reflected', () => {
  for (const code of ['SECRET_SENTINEL', 'constructor', '__proto__']) {
    try { parse(failure(code), root); throw new Error('expected failure'); }
    catch (error) { expect(String(error)).toContain('without a recognized cause'); expect(String(error)).not.toContain(code); }
  }
});

const originalBaseUrl = process.env.FORGEAX_ASSET_LIBRARY_BASE_URL;
afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.FORGEAX_ASSET_LIBRARY_BASE_URL;
  else process.env.FORGEAX_ASSET_LIBRARY_BASE_URL = originalBaseUrl;
});
for (const library of ['aw', 'ea']) {
  test(`${library} requires a configured service address`, () => {
    delete process.env.FORGEAX_ASSET_LIBRARY_BASE_URL;
    expect(() => resolveAssetLibrarySelection({ library })).toThrow('asset3d_base_url_required');
    process.env.FORGEAX_ASSET_LIBRARY_BASE_URL = '   ';
    expect(() => resolveAssetLibrarySelection({ library })).toThrow('asset3d_base_url_required');
  });
  test(`${library} accepts environment configuration and explicit override`, () => {
    process.env.FORGEAX_ASSET_LIBRARY_BASE_URL = 'https://assets.example.test';
    expect(resolveAssetLibrarySelection({ library })).toEqual({
      library, serviceRoot: 'https://assets.example.test/trpc.oasismetric.omcontentserver.http',
    });
    expect(resolveAssetLibrarySelection({ library, baseUrl: 'https://override.example.test' }).serviceRoot)
      .toBe('https://override.example.test/trpc.oasismetric.omcontentserver.http');
    expect(() => resolveAssetLibrarySelection({ library, baseUrl: 'file:///tmp/assets' })).toThrow('asset3d_base_url_invalid');
  });
}
