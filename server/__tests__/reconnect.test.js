import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createServer } = require('../index');
const { io: Client } = require('socket.io-client');

let server;
let url;
let rooms;
const clients = [];

function connect() {
  return new Promise((resolve, reject) => {
    const socket = Client(url, { forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    clients.push(socket);
  });
}

function waitFor(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeout);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

beforeEach(async () => {
  const created = createServer();
  server = created.server;
  rooms = created.rooms;
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  url = `http://localhost:${port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

async function setupPlayingRoom() {
  const [c1, c2] = await Promise.all([connect(), connect()]);
  const joined1 = waitFor(c1, 'room:joined');
  c1.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
  const { code } = await joined1;
  const roomReady = waitFor(c2, 'room:state');
  c2.emit('room:join', { code, playerId: 'p2', playerName: 'Bob' });
  await roomReady;
  const gs1 = waitFor(c1, 'game:state');
  c1.emit('room:start', { playerId: 'p1' });
  const state1 = await gs1;
  return { c1, c2, code, actingId: state1.actionPlayerId };
}

describe('打牌中断线：暂停而不是自动弃牌/踢出', () => {
  it('非行动方断线 → 仍留在 room.players 里，且被标记 connected:false', async () => {
    const { c1, c2, actingId } = await setupPlayingRoom();
    const notActingSocket = actingId === 'p1' ? c2 : c1;
    const notActingId = actingId === 'p1' ? 'p2' : 'p1';

    notActingSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    const room = rooms.getRoomByPlayer(actingId);
    const player = room.players.find(p => p.id === notActingId);
    expect(player).toBeDefined();
    expect(player.connected).toBe(false);
  });

  it('行动方断线 → 牌局不推进（对方看到的行动人始终未变），人仍在房间里', async () => {
    // Note: this deliberately does NOT assert "opponent receives zero
    // game:state events". broadcastRoom (called from the disconnect handler
    // to reflect the connected:false flag, and the intended future hook
    // point for Task 7's safety-timeout) unconditionally pings every
    // connected player with a fresh game:state on every call — so a status
    // ping is expected and correct. What must NOT happen is the hand
    // actually advancing: every game:state the opponent receives must still
    // show the disconnected player as the one action is waiting on.
    const { c1, c2, actingId } = await setupPlayingRoom();
    const actingSocket = actingId === 'p1' ? c1 : c2;
    const otherSocket = actingId === 'p1' ? c2 : c1;

    const receivedStates = [];
    const listener = (data) => { receivedStates.push(data); };
    otherSocket.on('game:state', listener);

    actingSocket.disconnect();
    await new Promise((r) => setTimeout(r, 500));

    otherSocket.off('game:state', listener);
    for (const state of receivedStates) {
      expect(state.actionPlayerId).toBe(actingId);
    }

    const room = rooms.getRoomByPlayer(actingId === 'p1' ? 'p2' : 'p1');
    expect(room.players.map(p => p.id)).toContain(actingId);
    expect(room.getActionPlayerId()).toBe(actingId);
  });
});
