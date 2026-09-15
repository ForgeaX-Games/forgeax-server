import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const result = await Bun.build({ entrypoints: [resolve(root, 'src/game/asset-library/host-worker.ts')], target: 'node', outdir: resolve(root, 'assets/asset-library'), naming: 'worker.js' });
if (!result.success) throw new Error(result.logs.join('\n'));
