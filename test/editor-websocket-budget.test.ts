import { expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { randomFillSync } from 'node:crypto';
import { EDITOR_WS_MAX_MESSAGE_BYTES, rejectOversizedWebsocketMessage, websocketPayloadLimit } from '../src/editor-websocket-budget';
import { createEditorTransportCarrier, EDITOR_TRANSPORT_WS_SID } from '../src/game/editor-transport-carrier';

const legacyLimit = 2 * 1024 * 1024;
const request = { jsonrpc: '2.0', version: 'editor-transport/v1', id: 'capture-1', correlationId: 'correlation-1',
  scope: 'game:fixture', method: 'gameplay', params: { version: 1, operation: 'capture' } };

function pngFrame(): Buffer {
  // Valid worst-case-style 1080p PNG: noisy RGBA scanlines resist compression.
  const width = 1920, height = 1080;
  const raw = randomFillSync(Buffer.alloc((width * 4 + 1) * height));
  for (let y = 0; y < height; y++) raw[y * (width * 4 + 1)] = 0;
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, bytes: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), bytes]);
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function dispatchFrame(payload: (incoming: typeof request) => string, parserLimit = EDITOR_WS_MAX_MESSAGE_BYTES) {
  const carrier = createEditorTransportCarrier({ timeoutMs: 3000 });
  let registered!: () => void;
  const ready = new Promise<void>(resolve => { registered = resolve; });
  const server = Bun.serve<{ sid: string }>({ hostname: '127.0.0.1', port: 0,
    fetch(req, server) { if (server.upgrade(req, { data: { sid: EDITOR_TRANSPORT_WS_SID } })) return; return new Response('fixture'); },
    websocket: { maxPayloadLength: parserLimit,
      open(ws) { carrier.open(ws); },
      message(ws, message) {
        if (rejectOversizedWebsocketMessage(ws, message, websocketPayloadLimit(true, legacyLimit))) return;
        carrier.message(ws, message);
        if (String(message).includes('editor-transport/ready')) registered();
      },
      close(ws, code, reason) { carrier.close(ws, code, reason); },
    },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  socket.onopen = () => socket.send(JSON.stringify({ type: 'editor-transport/ready', version: 'editor-transport/v1',
    role: 'interactive', scope: request.scope, visibility: 'visible', focused: true, capabilities: { gameplay: true } }));
  socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.type === 'editor-transport/request') socket.send(payload(message.request)); };
  try { await ready; return await carrier.dispatch(request); }
  finally { socket.close(); server.stop(true); }
}

function response(data: unknown): string {
  return JSON.stringify({ type: 'editor-transport/response', response: { jsonrpc: request.jsonrpc, version: request.version,
    id: request.id, correlationId: request.correlationId, result: data } });
}

test('actual 1080p PNG envelope survives real WS and preserves correlation; old parser disconnects it', async () => {
  const png = pngFrame();
  const wire = response({ version: 1, operation: 'capture', ok: true, data: { dataUrl: `data:image/png;base64,${png.toString('base64')}`, bytes: png.length,
    provenance: { runtimeId: 'fixture', canvasIdentity: 'canvas-fixture', rendererGeneration: 1, pageIdentity: 'fixture', scope: { projectId: 'fixture', gameId: 'fixture' } } } });
  expect(Buffer.byteLength(wire)).toBeGreaterThan(legacyLimit);
  expect(Buffer.byteLength(wire)).toBeLessThan(EDITOR_WS_MAX_MESSAGE_BYTES);
  const previous = await dispatchFrame(() => wire, legacyLimit);
  expect(previous).toMatchObject({ error: { code: 'editor-carrier-unavailable', observed: { candidates: 0, close: { code: expect.any(Number), reason: expect.stringContaining('big message') } } } });
  const current = await dispatchFrame(() => wire);
  expect(current).toMatchObject({ id: request.id, correlationId: request.correlationId, result: { ok: true, data: { bytes: png.length } } });
  console.log(JSON.stringify({ pngBytes: png.length, serializedBytes: Buffer.byteLength(wire), editorLimit: EDITOR_WS_MAX_MESSAGE_BYTES }));
}, 15000);

test('small response succeeds; one byte over Editor ceiling closes with diagnostic', async () => {
  expect(await dispatchFrame(() => response({ ok: true }))).toMatchObject({ result: { ok: true } });
  const empty = response({ padding: '' });
  const boundary = response({ padding: 'x'.repeat(EDITOR_WS_MAX_MESSAGE_BYTES - Buffer.byteLength(empty)) });
  expect(Buffer.byteLength(boundary)).toBe(EDITOR_WS_MAX_MESSAGE_BYTES);
  expect(await dispatchFrame(() => boundary)).toMatchObject({ id: request.id, correlationId: request.correlationId });
  const result = await dispatchFrame(() => 'x'.repeat(EDITOR_WS_MAX_MESSAGE_BYTES + 1));
  expect(result).toMatchObject({ error: { code: 'editor-carrier-unavailable', observed: { close: { code: expect.any(Number), reason: expect.stringContaining('big message') } } } });
});

test('non-Editor channel keeps its previous exact wire limit under shared larger parser', async () => {
  const limit = websocketPayloadLimit(false, legacyLimit);
  expect(limit).toBe(legacyLimit);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response('fixture'); },
    websocket: { maxPayloadLength: EDITOR_WS_MAX_MESSAGE_BYTES, message(ws, message) {
      if (!rejectOversizedWebsocketMessage(ws, message, limit)) ws.send('accepted');
    } },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  try {
    const result = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      socket.onerror = () => reject(new Error('fixture socket failed'));
      socket.onopen = () => socket.send('x'.repeat(legacyLimit));
      socket.onmessage = event => { expect(String(event.data)).toBe('accepted'); socket.send('x'.repeat(legacyLimit + 1)); };
      socket.onclose = event => resolve({ code: event.code, reason: event.reason });
    });
    expect(result).toEqual({ code: 1009, reason: `WebSocket message exceeds ${legacyLimit} byte limit` });
  } finally { socket.close(); server.stop(true); }
});
