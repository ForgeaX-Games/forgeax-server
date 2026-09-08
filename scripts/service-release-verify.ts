import { readFile } from 'node:fs/promises';

type ServiceRecord = {
  serviceId: string;
  version: string;
  variant: string;
  artifact: string;
  digest: string;
  healthProtocol: string;
};

const lock = JSON.parse(await readFile(new URL('../release/services.lock.json', import.meta.url), 'utf8')) as { source: string; services: ServiceRecord[] };
const manifest = JSON.parse(await readFile(new URL('../release/service-manifest.json', import.meta.url), 'utf8')) as { sourceCommit: string; services: ServiceRecord[] };
if (lock.source !== 'main' || manifest.sourceCommit !== 'main') throw new Error('service release must originate from main');
if (lock.services.length === 0 || lock.services.length !== manifest.services.length) throw new Error('service release has no complete service set');
for (const [index, entry] of lock.services.entries()) {
  const manifestEntry = manifest.services[index];
  for (const key of ['serviceId', 'version', 'variant', 'artifact', 'digest', 'healthProtocol'] as const) {
    if (entry[key] !== manifestEntry[key] || !entry[key]) throw new Error(`service lock mismatch: ${key}`);
  }
  if (entry.healthProtocol !== 'ServiceHealthV1' || !/^sha256:[a-f0-9]{64}$/.test(entry.digest)) throw new Error(`invalid immutable service entry: ${entry.serviceId}`);
}
console.log(`verified ${lock.services.length} ServiceHealthV1 service artifact(s)`);
