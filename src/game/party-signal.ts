/**
 * Party-room signaling for 《今晚别变回人》.
 * Transport: WebSocket `/ws/party` — room discovery + ICE + optional event relay.
 * Authoritative match state still belongs to the Host client; this server does
 * NOT simulate the match.
 */

export const PARTY_WS_PATH = '/ws/party';

const ROOM_CODE_RE = /^[A-Z0-9]{4}$/;
const MAX_PLAYERS = 4;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

export type PartyPeer = {
  wsId: string;
  playerId: string;
  displayName: string;
  isHost: boolean;
  ready: boolean;
  ws: import('bun').ServerWebSocket<PartyWsData>;
};

export type PartyRoom = {
  code: string;
  hostId: string;
  chapterId: string;
  peers: Map<string, PartyPeer>; // playerId → peer
  createdAt: number;
};

export type PartyWsData = {
  id: string;
  kind: 'party';
  playerId?: string;
  roomCode?: string;
};

type ClientMsg =
  | { type: 'create'; displayName?: string; chapterId?: string }
  | { type: 'join'; roomCode: string; displayName?: string }
  | { type: 'leave' }
  | { type: 'ready'; ready: boolean }
  | { type: 'chapter'; chapterId: string }
  | { type: 'signal'; to: string; payload: unknown }
  | { type: 'relay'; to?: string; event: unknown }
  | { type: 'ping' };

type ServerMsg =
  | {
      type: 'welcome';
      roomCode: string;
      playerId: string;
      isHost: boolean;
      hostId: string;
      chapterId: string;
      roster: RosterRow[];
    }
  | { type: 'roster'; hostId: string; chapterId: string; roster: RosterRow[] }
  | { type: 'signal'; from: string; payload: unknown }
  | { type: 'relay'; from: string; event: unknown }
  | { type: 'error'; message: string }
  | { type: 'pong' };

type RosterRow = {
  id: string;
  displayName: string;
  ready: boolean;
  isHost: boolean;
  connected: boolean;
};

const rooms = new Map<string, PartyRoom>();

function makeCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[(Math.random() * alphabet.length) | 0]!;
  if (rooms.has(out)) return makeCode();
  return out;
}

function makePlayerId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

function rosterOf(room: PartyRoom): RosterRow[] {
  return [...room.peers.values()].map((p) => ({
    id: p.playerId,
    displayName: p.displayName,
    ready: p.ready,
    isHost: p.isHost,
    connected: true,
  }));
}

function send(ws: import('bun').ServerWebSocket<PartyWsData>, msg: ServerMsg): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* peer gone */
  }
}

function broadcastRoster(room: PartyRoom): void {
  const msg: ServerMsg = {
    type: 'roster',
    hostId: room.hostId,
    chapterId: room.chapterId,
    roster: rosterOf(room),
  };
  const raw = JSON.stringify(msg);
  for (const p of room.peers.values()) {
    try {
      p.ws.send(raw);
    } catch {
      /* ignore */
    }
  }
}

function leaveRoom(ws: import('bun').ServerWebSocket<PartyWsData>): void {
  const code = ws.data.roomCode;
  const pid = ws.data.playerId;
  if (!code || !pid) return;
  const room = rooms.get(code);
  if (!room) return;
  room.peers.delete(pid);
  ws.data.roomCode = undefined;
  ws.data.playerId = undefined;
  if (room.peers.size === 0) {
    rooms.delete(code);
    return;
  }
  // Host migration: oldest remaining peer becomes host.
  if (room.hostId === pid) {
    const next = room.peers.values().next().value as PartyPeer | undefined;
    if (next) {
      room.hostId = next.playerId;
      for (const p of room.peers.values()) p.isHost = p.playerId === room.hostId;
    }
  }
  broadcastRoster(room);
}

function gcRooms(): void {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS && room.peers.size === 0) rooms.delete(code);
  }
}

export function isPartyWsData(data: unknown): data is PartyWsData {
  return !!data && typeof data === 'object' && (data as PartyWsData).kind === 'party';
}

export function handlePartyOpen(_ws: import('bun').ServerWebSocket<PartyWsData>): void {
  gcRooms();
}

export function handlePartyClose(ws: import('bun').ServerWebSocket<PartyWsData>): void {
  leaveRoom(ws);
}

export function handlePartyMessage(
  ws: import('bun').ServerWebSocket<PartyWsData>,
  raw: string | ArrayBuffer | Uint8Array,
): void {
  let msg: ClientMsg;
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    msg = JSON.parse(text) as ClientMsg;
  } catch {
    send(ws, { type: 'error', message: 'invalid json' });
    return;
  }

  switch (msg.type) {
    case 'ping':
      send(ws, { type: 'pong' });
      return;

    case 'create': {
      leaveRoom(ws);
      const code = makeCode();
      const playerId = makePlayerId('host');
      const displayName = (msg.displayName?.trim() || '房主').slice(0, 24);
      const chapterId = msg.chapterId?.trim() || 'chapter_mx';
      const peer: PartyPeer = {
        wsId: ws.data.id,
        playerId,
        displayName,
        isHost: true,
        ready: false,
        ws,
      };
      const room: PartyRoom = {
        code,
        hostId: playerId,
        chapterId,
        peers: new Map([[playerId, peer]]),
        createdAt: Date.now(),
      };
      rooms.set(code, room);
      ws.data.playerId = playerId;
      ws.data.roomCode = code;
      send(ws, {
        type: 'welcome',
        roomCode: code,
        playerId,
        isHost: true,
        hostId: playerId,
        chapterId,
        roster: rosterOf(room),
      });
      return;
    }

    case 'join': {
      leaveRoom(ws);
      const code = String(msg.roomCode ?? '').trim().toUpperCase();
      if (!ROOM_CODE_RE.test(code)) {
        send(ws, { type: 'error', message: '房间码须为 4 位' });
        return;
      }
      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: 'error', message: '房间不存在' });
        return;
      }
      if (room.peers.size >= MAX_PLAYERS) {
        send(ws, { type: 'error', message: '房间已满（最多 4 人）' });
        return;
      }
      const playerId = makePlayerId('p');
      const displayName = (msg.displayName?.trim() || `玩家${room.peers.size + 1}`).slice(0, 24);
      const peer: PartyPeer = {
        wsId: ws.data.id,
        playerId,
        displayName,
        isHost: false,
        ready: false,
        ws,
      };
      room.peers.set(playerId, peer);
      ws.data.playerId = playerId;
      ws.data.roomCode = code;
      send(ws, {
        type: 'welcome',
        roomCode: code,
        playerId,
        isHost: false,
        hostId: room.hostId,
        chapterId: room.chapterId,
        roster: rosterOf(room),
      });
      broadcastRoster(room);
      return;
    }

    case 'leave':
      leaveRoom(ws);
      return;

    case 'ready': {
      const room = ws.data.roomCode ? rooms.get(ws.data.roomCode) : undefined;
      const peer = room && ws.data.playerId ? room.peers.get(ws.data.playerId) : undefined;
      if (!room || !peer) return;
      peer.ready = !!msg.ready;
      broadcastRoster(room);
      return;
    }

    case 'chapter': {
      const room = ws.data.roomCode ? rooms.get(ws.data.roomCode) : undefined;
      const peer = room && ws.data.playerId ? room.peers.get(ws.data.playerId) : undefined;
      if (!room || !peer?.isHost) return;
      room.chapterId = String(msg.chapterId ?? room.chapterId);
      broadcastRoster(room);
      return;
    }

    case 'signal': {
      const room = ws.data.roomCode ? rooms.get(ws.data.roomCode) : undefined;
      const from = ws.data.playerId;
      if (!room || !from) return;
      const target = room.peers.get(msg.to);
      if (!target) return;
      send(target.ws, { type: 'signal', from, payload: msg.payload });
      return;
    }

    case 'relay': {
      const room = ws.data.roomCode ? rooms.get(ws.data.roomCode) : undefined;
      const from = ws.data.playerId;
      if (!room || !from) return;
      const payload: ServerMsg = { type: 'relay', from, event: msg.event };
      const raw = JSON.stringify(payload);
      if (msg.to) {
        const target = room.peers.get(msg.to);
        if (target) {
          try {
            target.ws.send(raw);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      for (const p of room.peers.values()) {
        if (p.playerId === from) continue;
        try {
          p.ws.send(raw);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    default:
      send(ws, { type: 'error', message: 'unknown message' });
  }
}

/** Tiny health endpoint helper — list open room codes (no secrets). */
export function listPartyRooms(): Array<{ code: string; players: number; hostId: string }> {
  return [...rooms.values()].map((r) => ({
    code: r.code,
    players: r.peers.size,
    hostId: r.hostId,
  }));
}
