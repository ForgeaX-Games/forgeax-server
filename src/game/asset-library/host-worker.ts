import { parentPort, workerData } from 'node:worker_threads';
import { searchLibrarySources } from './host';

try { parentPort!.postMessage({ value: await searchLibrarySources(workerData) }); }
catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : 'asset_library_failed' }); }
