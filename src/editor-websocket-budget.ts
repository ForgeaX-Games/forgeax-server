// A bounded 1920x1080 RGBA PNG can approach 8 MiB before base64 encoding.
// Reserve 16 MiB for its JSON response envelope; other channels keep their
// previous wire limit and their existing, stricter per-protocol validation.
export const EDITOR_WS_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export function websocketPayloadLimit(isEditor: boolean, otherChannelsLimit: number): number {
  return isEditor ? EDITOR_WS_MAX_MESSAGE_BYTES : otherChannelsLimit;
}

export function rejectOversizedWebsocketMessage(
  socket: { close(code: number, reason: string): unknown },
  message: string | ArrayBuffer | ArrayBufferView,
  limit: number,
): boolean {
  const bytes = typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength;
  if (bytes <= limit) return false;
  socket.close(1009, `WebSocket message exceeds ${limit} byte limit`);
  return true;
}
