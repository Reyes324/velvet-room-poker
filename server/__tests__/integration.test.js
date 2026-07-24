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

describe('集成测试 — 房间管理', () => {
  it('创建房间后收到 room:joined 和 6位房间码', async () => {
    const c = await connect();
    const joined = waitFor(c, 'room:joined');
    c.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
    const data = await joined;
    expect(data.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(data.playerId).toBe('p1');
  });

  it('两个玩家加入同一房间，双方都收到 room:state', async () => {
    const [c1, c2] = await Promise.all([connect(), connect()]);

    const joined1 = waitFor(c1, 'room:joined');
    c1.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
    const { code } = await joined1;

    const state2 = waitFor(c2, 'room:state');
    c2.emit('room:join', { code, playerId: 'p2', playerName: 'Bob' });
    const state = await state2;

    expect(state.players).toHaveLength(2);
    expect(state.players.map(p => p.id)).toContain('p1');
    expect(state.players.map(p => p.id)).toContain('p2');
  });

  it('加入不存在的房间 → 收到 game:error（关键回归测试）', async () => {
    const c = await connect();
    const errMsg = waitFor(c, 'game:error');
    c.emit('room:join', { code: 'XXXXXX', playerId: 'p1', playerName: 'Alice' });
    const msg = await errMsg;
    expect(msg).toBe('房间不存在');
  });

  it('同一 playerId 重复加入 → 收到 game:error', async () => {
    const [c1, c2] = await Promise.all([connect(), connect()]);

    const joined = waitFor(c1, 'room:joined');
    c1.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
    const { code } = await joined;

    const errMsg = waitFor(c2, 'game:error');
    c2.emit('room:join', { code, playerId: 'p1', playerName: 'Alice' });
    const msg = await errMsg;
    expect(msg).toBe('已在房间内');
  });

  it('玩家主动退出后，用同一 playerId 重新 room:join 同一房间 → 成功恢复身份（不是新玩家）', async () => {
    const [c1, c2] = await Promise.all([connect(), connect()]);

    const joined1 = waitFor(c1, 'room:joined');
    c1.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
    const { code } = await joined1;

    // Wait for BOTH sides' copy of the join broadcast to land — c1 is also
    // in this socket.io room and gets its own copy, and if it's still
    // in flight when the next `waitFor(c1, 'room:state')` attaches below,
    // that .once() listener catches this stale join event instead of the
    // leave event we actually want (confirmed via a real repro, not
    // guessed — c1 received two room:state events in quick succession:
    // { left:false } from the join, then { left:true } from the leave).
    const state1FromJoin = waitFor(c1, 'room:state');
    const state2 = waitFor(c2, 'room:state');
    c2.emit('room:join', { code, playerId: 'p2', playerName: 'Bob' });
    await Promise.all([state1FromJoin, state2]);

    const leftState = waitFor(c1, 'room:state');
    c2.emit('player:leave-room', { playerId: 'p2' });
    const afterLeave = await leftState;
    expect(afterLeave.players.find(p => p.id === 'p2').left).toBe(true);

    // Same playerId, reconnecting with a fresh socket (c3), rejoins the
    // same room code.
    const c3 = await connect();
    const rejoinedState = waitFor(c1, 'room:state');
    const rejoined = waitFor(c3, 'room:joined');
    c3.emit('room:join', { code, playerId: 'p2', playerName: 'Bob' });
    const [joinedAck, state] = await Promise.all([rejoined, rejoinedState]);

    expect(joinedAck.playerId).toBe('p2');
    expect(state.players).toHaveLength(2); // still 2 rows, not 3
    expect(state.players.find(p => p.id === 'p2').left).toBe(false);
  });

  it('设备断线（未显式退出）后，另一个 playerId + 同昵称加入同房间号 → 按昵称继承原身份', async () => {
    // Simulates the WeChat-in-app-browser vs. phone's own browser case: two
    // completely separate localStorage stores (so two different generated
    // playerIds) for what's actually the same person, same room code, same
    // typed name — the first one just disconnected (closed the WeChat tab),
    // never sent an explicit player:leave-room.
    const [c1, c2] = await Promise.all([connect(), connect()]);

    const joined1 = waitFor(c1, 'room:joined');
    c1.emit('room:create', { playerId: 'host', playerName: 'Alice' });
    const { code } = await joined1;

    const state1FromJoin = waitFor(c1, 'room:state');
    const state2 = waitFor(c2, 'room:state');
    c2.emit('room:join', { code, playerId: 'bob-wechat', playerName: 'Bob' });
    await Promise.all([state1FromJoin, state2]);

    // c2 disconnects without leaving — same as closing the WeChat browser.
    const disconnectedState = waitFor(c1, 'room:state');
    c2.disconnect();
    const afterDisconnect = await disconnectedState;
    expect(afterDisconnect.players.find(p => p.id === 'bob-wechat').connected).toBe(false);
    expect(afterDisconnect.players.find(p => p.id === 'bob-wechat').left).toBe(false); // NOT a leave

    // A totally different playerId (Bob's own phone browser) joins the
    // same room with the same name.
    const c4 = await connect();
    const rejoinedState = waitFor(c1, 'room:state');
    const rejoined = waitFor(c4, 'room:joined');
    c4.emit('room:join', { code, playerId: 'bob-safari', playerName: 'Bob' });
    const [joinedAck, state] = await Promise.all([rejoined, rejoinedState]);

    // Server assigns back the OLD identity, not the freshly-generated one.
    expect(joinedAck.playerId).toBe('bob-wechat');
    expect(state.players).toHaveLength(2); // still 2 rows — reclaimed, not a 3rd new player
    expect(state.players.find(p => p.id === 'bob-wechat').connected).toBe(true);
  });
});

describe('集成测试 — 游戏流程', () => {
  async function setupRoom() {
    const [c1, c2] = await Promise.all([connect(), connect()]);
    const joined1 = waitFor(c1, 'room:joined');
    c1.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
    const { code } = await joined1;
    const roomReady = waitFor(c2, 'room:state');
    c2.emit('room:join', { code, playerId: 'p2', playerName: 'Bob' });
    await roomReady;
    return { c1, c2, code };
  }

  it('非房主开始游戏 → 收到 game:error', async () => {
    const { c2 } = await setupRoom();
    const errMsg = waitFor(c2, 'game:error');
    c2.emit('room:start', { playerId: 'p2' });
    const msg = await errMsg;
    expect(msg).toBe('只有房主可以开始游戏');
  });

  it('房主开始游戏后双方收到 game:state', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    const gs2 = waitFor(c2, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    const [state1, state2] = await Promise.all([gs1, gs2]);
    expect(state1.phase).toBe('preflop');
    expect(state2.phase).toBe('preflop');
    const myCards = state1.players.find(p => p.id === 'p1').holeCards;
    const oppCards = state1.players.find(p => p.id === 'p2').holeCards;
    expect(myCards[0]).not.toBeNull();
    expect(oppCards[0]).toBeNull();
  });

  it('房主发送 room:restart → 双方收到 status=waiting 的 room:state', async () => {
    const { c1, c2 } = await setupRoom();
    const rs1 = waitFor(c1, 'room:state');
    const rs2 = waitFor(c2, 'room:state');
    c1.emit('room:restart', { playerId: 'p1' });
    const [state1] = await Promise.all([rs1, rs2]);
    expect(state1.status).toBe('waiting');
    expect(state1.players.every(p => p.chips === 1000)).toBe(true);
  });

  it('非房主发送 room:restart → 收到 game:error', async () => {
    const { c2 } = await setupRoom();
    const errMsg = waitFor(c2, 'game:error');
    c2.emit('room:restart', { playerId: 'p2' });
    const msg = await errMsg;
    expect(msg).toBeDefined();
  });

  it('房主发送 room:end-game → 双方收到 hostEnded 的 game:ended，且筹码不清零（跟 restart 区分）', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    const gs2 = waitFor(c2, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    await Promise.all([gs1, gs2]);

    const ended1 = waitFor(c1, 'game:ended');
    const ended2 = waitFor(c2, 'game:ended');
    const rs1 = waitFor(c1, 'room:state');
    c1.emit('room:end-game', { playerId: 'p1' });
    const [end1, end2, state1] = await Promise.all([ended1, ended2, rs1]);

    expect(end1.hostEnded).toBe(true);
    expect(end2.hostEnded).toBe(true);
    expect(state1.status).toBe('waiting');
    // Blinds were already posted this hand — chips reflect the in-progress
    // hand's state (via syncChipsFromGame), not reset to the 1000 starting
    // amount the way room:restart does.
    expect(state1.players.every(p => p.chips === 1000)).toBe(false);
  });

  it('非房主发送 room:end-game → 收到 game:error', async () => {
    const { c2 } = await setupRoom();
    const errMsg = waitFor(c2, 'game:error');
    c2.emit('room:end-game', { playerId: 'p2' });
    const msg = await errMsg;
    expect(msg).toBeDefined();
  });

  it('弃牌获胜一手结束后，room:get-hand-history 能拿到结果摘要；亮牌炫耀后该手记录补上赢家手牌', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    const gs2 = waitFor(c2, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    const [state1] = await Promise.all([gs1, gs2]);

    const actor = state1.actionPlayerId === 'p1' ? c1 : c2;
    const actorId = state1.actionPlayerId;
    const winnerId = actorId === 'p1' ? 'p2' : 'p1';
    const winnerClient = actorId === 'p1' ? c2 : c1;

    const settled = waitFor(actor === c1 ? c2 : c1, 'game:showdown');
    actor.emit('game:action', { playerId: actorId, action: 'fold' });
    await settled;

    // Before the winner opts into 亮牌炫耀: the FOLDER should see their own
    // cards (dealt into the hand, just folded) but NOT the winner's — the
    // winner never had to prove their hand.
    const folderHistoryResp = waitFor(actor, 'room:hand-history');
    actor.emit('room:get-hand-history', { playerId: actorId });
    const folderHistory = await folderHistoryResp;
    expect(folderHistory).toHaveLength(1);
    expect(folderHistory[0].handNumber).toBe(1);
    expect(folderHistory[0].foldWin).toBe(true);
    expect(folderHistory[0].winners[0].id).toBe(winnerId);
    expect(folderHistory[0].reveals).toHaveLength(1);
    expect(folderHistory[0].reveals[0].id).toBe(actorId); // only their own
    // Every player's net for the hand is present, winner and folder alike.
    expect(folderHistory[0].settle.map(s => s.id).sort()).toEqual(['p1', 'p2']);

    // The winner, from their own view, sees their own cards too (even
    // though they haven't publicly revealed) — same "own cards always
    // visible" rule, just privately per-viewer instead of broadcast.
    const winnerHistoryResp = waitFor(winnerClient, 'room:hand-history');
    winnerClient.emit('room:get-hand-history', { playerId: winnerId });
    const winnerHistory = await winnerHistoryResp;
    expect(winnerHistory[0].reveals).toHaveLength(1);
    expect(winnerHistory[0].reveals[0].id).toBe(winnerId);

    const revealed = waitFor(winnerClient, 'game:cards-revealed');
    winnerClient.emit('game:reveal-cards', { playerId: winnerId });
    await revealed;

    // After the winner publicly reveals, the folder's next fetch should now
    // see BOTH their own cards and the winner's (2 entries total).
    const folderHistoryResp2 = waitFor(actor, 'room:hand-history');
    actor.emit('room:get-hand-history', { playerId: actorId });
    const folderHistory2 = await folderHistoryResp2;
    expect(folderHistory2[0].reveals.map(r => r.id).sort()).toEqual([actorId, winnerId].sort());
    const winnerReveal = folderHistory2[0].reveals.find(r => r.id === winnerId);
    expect(winnerReveal.holeCards).toHaveLength(2);
  });

  it('房主踢人 → 目标玩家收到 room:kicked，且被标记 left（账本仍保留这一行）', async () => {
    const { c1, c2 } = await setupRoom();
    const kicked = waitFor(c2, 'room:kicked');
    c1.emit('room:kick', { hostId: 'p1', targetId: 'p2' });
    await kicked;
    // room:kicked 先于 room:state 广播发出（见 index.js room:kick 处理顺序），
    // 用 room:sync 主动拉取最新状态，避免与广播事件产生竞态断言。
    const stateCheck = waitFor(c1, 'room:state');
    c1.emit('room:sync', { playerId: 'p1' });
    const state = await stateCheck;
    expect(state.players).toHaveLength(2);
    const p2 = state.players.find(p => p.id === 'p2');
    expect(p2).toBeDefined();
    expect(p2.left).toBe(true);
  });

  it('非房主发送 room:kick → 房间人数不变（被静默忽略）', async () => {
    const { c1, c2 } = await setupRoom();
    c2.emit('room:kick', { hostId: 'p2', targetId: 'p1' });
    // 给服务端一点时间处理（若错误地生效会广播 room:state 变化）
    await new Promise(r => setTimeout(r, 200));
    const stateCheck = waitFor(c1, 'room:state');
    c1.emit('room:sync', { playerId: 'p1' });
    const state = await stateCheck;
    expect(state.players).toHaveLength(2);
  });

  it('不是自己回合时行动 → 收到 game:error', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    const gameState = await gs1;

    const notActingId = gameState.actionPlayerId === 'p1' ? 'p2' : 'p1';
    const notActing = notActingId === 'p2' ? c2 : c1;

    const errMsg = waitFor(notActing, 'game:error');
    notActing.emit('game:action', { playerId: notActingId, action: 'check' });
    const msg = await errMsg;
    expect(msg).toBeDefined();
  });

  it('筹码归零后，房间暂停在当前牌桌等待决策，而不是立即弹回大厅（曾经的行为，用户反馈改掉了）', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    const state1 = await gs1;
    expect(state1.actionPlayerId).toBe('p1');

    // 直接模拟 p1（本局先手弃牌的那位）已经输光（不依赖具体牌局随机结果）——
    // 必须是弃牌的那位，赢牌的一方结算时会把底池加回筹码，手动设的 0 会被覆盖掉。
    const room = rooms.getRoomByPlayer('p1');
    room.game.players.find(p => p.id === 'p1').chips = 0;

    const showdown = waitFor(c1, 'game:showdown');
    c1.emit('game:action', { playerId: 'p1', action: 'fold' });
    await showdown;

    // 双方都确认结算后，房间应该暂停等待 p1 决策——不是 game:ended，room.status
    // 仍是 'playing'，room:state 里能看到 p1 chips=0 且 awaitingBustResolution=true。
    const stateAfterAck = waitFor(c1, 'room:state');
    c1.emit('game:ready-next', { playerId: 'p1' });
    c2.emit('game:ready-next', { playerId: 'p2' });
    const paused = await stateAfterAck;
    expect(paused.status).toBe('playing');
    expect(paused.awaitingBustResolution).toBe(true);
    expect(paused.players.find(p => p.id === 'p1').chips).toBe(0);
    expect(paused.players.find(p => p.id === 'p1').left).toBe(false);
  });

  it('筹码归零后选择离开 → 标记 left（账本保留），单挑桌活跃人数不足 2 人，游戏结束回到大厅', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    await gs1;

    const room = rooms.getRoomByPlayer('p1');
    room.game.players.find(p => p.id === 'p1').chips = 0;

    const showdown = waitFor(c1, 'game:showdown');
    c1.emit('game:action', { playerId: 'p1', action: 'fold' });
    await showdown;

    c1.emit('game:ready-next', { playerId: 'p1' });
    c2.emit('game:ready-next', { playerId: 'p2' });
    await new Promise((r) => setTimeout(r, 150)); // 让暂停状态的 room:state 先落地

    // p1 选择"退出对局"
    const ended = waitFor(c2, 'game:ended', 3000);
    c1.emit('player:leave-room', { playerId: 'p1' });
    const endedResult = await ended;
    expect(endedResult.ended).toBe(true);

    expect(room.status).toBe('waiting');
    expect(room.awaitingBustResolution).toBe(false);
    const p1 = room.players.find(p => p.id === 'p1');
    expect(p1).toBeDefined(); // 账本保留这一行
    expect(p1.left).toBe(true);
  });

  it('筹码归零后选择再借一底 → 房间清除暂停状态并直接发下一手（不用先回大厅再手动开局）', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    await gs1;

    const room = rooms.getRoomByPlayer('p1');
    room.game.players.find(p => p.id === 'p1').chips = 0;

    const showdown = waitFor(c1, 'game:showdown');
    c1.emit('game:action', { playerId: 'p1', action: 'fold' });
    await showdown;

    c1.emit('game:ready-next', { playerId: 'p1' });
    c2.emit('game:ready-next', { playerId: 'p2' });
    await new Promise((r) => setTimeout(r, 150));
    expect(room.awaitingBustResolution).toBe(true);

    // Inspect server state directly rather than racing a fresh game:state
    // listener against the still-in-flight "hold" broadcast from the
    // ready-next handling just above (both fire on the same socket).
    c1.emit('player:rebuy', { playerId: 'p1' });
    await new Promise((r) => setTimeout(r, 150));
    expect(room.game.phase).toBe('preflop');
    expect(room.status).toBe('playing');
    expect(room.awaitingBustResolution).toBe(false);
    expect(room.players.find(p => p.id === 'p1').chips).toBe(1000);
  });

  it('房主可以帮不响应的筹码归零玩家（非房主本人）"退出对局"，解除暂停', async () => {
    const { c1, c2 } = await setupRoom(); // p1 = 房主
    const gs1 = waitFor(c1, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    await gs1;

    // 手动设 0 筹码要设在最终"弃牌"的那位身上——赢牌一方结算时筹码会被赢的底池
    // 覆盖掉。让 p1（庄+小盲，本局先手）先跟注把回合交给 p2，再让 p2（非房主）
    // 弃牌本局输光，这样 p1 赢下这一手、p2 维持 0 筹码。
    const room = rooms.getRoomByPlayer('p1');
    const p2Turn = waitFor(c1, 'game:state');
    c1.emit('game:action', { playerId: 'p1', action: 'call' });
    await p2Turn;
    room.game.players.find(p => p.id === 'p2').chips = 0;

    const showdown = waitFor(c1, 'game:showdown');
    c2.emit('game:action', { playerId: 'p2', action: 'fold' });
    await showdown;

    c1.emit('game:ready-next', { playerId: 'p1' });
    c2.emit('game:ready-next', { playerId: 'p2' });
    await new Promise((r) => setTimeout(r, 150));
    expect(room.awaitingBustResolution).toBe(true);

    const ended = waitFor(c1, 'game:ended', 3000);
    c1.emit('room:leave-for', { hostId: 'p1', targetId: 'p2' });
    const endedResult = await ended;
    expect(endedResult.ended).toBe(true);
    expect(room.players.find(p => p.id === 'p2').left).toBe(true);
  });

  it('非房主发 room:leave-for → 被忽略，暂停状态不变', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    await gs1;

    const room = rooms.getRoomByPlayer('p1');
    room.game.players.find(p => p.id === 'p1').chips = 0;

    const showdown = waitFor(c1, 'game:showdown');
    c1.emit('game:action', { playerId: 'p1', action: 'fold' });
    await showdown;

    c1.emit('game:ready-next', { playerId: 'p1' });
    c2.emit('game:ready-next', { playerId: 'p2' });
    await new Promise((r) => setTimeout(r, 150));
    expect(room.awaitingBustResolution).toBe(true);

    c2.emit('room:leave-for', { hostId: 'p2', targetId: 'p1' }); // p2 不是房主
    await new Promise((r) => setTimeout(r, 150));
    expect(room.awaitingBustResolution).toBe(true);
    expect(room.players.find(p => p.id === 'p1').left).toBe(false);
  });

  it('结算后必须所有在线玩家都发 game:ready-next，才会推进到下一局', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    await gs1;

    // 让当前行动方直接弃牌，快速制造一次 showdown
    const actingId = (await new Promise((resolve) => {
      c1.once('game:state', (s) => resolve(s.actionPlayerId));
      c1.emit('room:sync', { playerId: 'p1' });
    }));
    const actingSocket = actingId === 'p1' ? c1 : c2;

    const showdown = waitFor(c1, 'game:showdown');
    actingSocket.emit('game:action', { playerId: actingId, action: 'fold' });
    await showdown;

    // 只有 p1 确认，还不该收到下一局的 game:state
    let gotNextHand = false;
    const nextHandListener = () => { gotNextHand = true; };
    c1.on('game:state', nextHandListener);
    c1.emit('game:ready-next', { playerId: 'p1' });
    await new Promise((r) => setTimeout(r, 800));
    expect(gotNextHand).toBe(false);
    c1.off('game:state', nextHandListener);

    // p2 也确认后，应该很快收到下一局 game:state（不用等 4 秒/15 秒兜底）
    const nextHand = waitFor(c1, 'game:state', 3000);
    c2.emit('game:ready-next', { playerId: 'p2' });
    const state = await nextHand;
    expect(state.phase).toBe('preflop');
  });

  it('结算等待期内断线 → 不再自动推进，掉线玩家仍在待确认列表中（回归：actionIndex 未推进导致弃牌者断线时重复弃牌 + Bug3 修复验证）', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    await gs1;

    // 首手 dealerIndex=0，单挑：p1 是庄+小盲、翻牌前先手（见上文用例说明）。
    // 让 p1 直接弃牌结束本局 —— 此时 GameEngine.actionIndex 仍停留在 p1（fold/_advance/_endHand
    // 都不会推进 actionIndex），为下面的断线重入场景创造前提条件。
    const showdown1 = waitFor(c1, 'game:showdown');
    const showdown2 = waitFor(c2, 'game:showdown');
    c1.emit('game:action', { playerId: 'p1', action: 'fold' });
    await Promise.all([showdown1, showdown2]);

    // 结算等待期开始后，持续监听存活玩家 c2 是否再收到第二次 game:showdown
    // （若 bug 未修复：p1 断线会被误判为"轮到 p1 时弃牌"，重新执行一次 fold →
    // _advance → _endHand，广播一个 pot=0 的伪造 showdown）。
    let extraShowdowns = 0;
    c2.on('game:showdown', () => { extraShowdowns += 1; });

    // 正是刚才那个让本局结束的弃牌者（p1）此时断线
    c1.disconnect();

    // 给服务端一点时间处理断线逻辑
    await new Promise((r) => setTimeout(r, 400));
    expect(extraShowdowns).toBe(0);

    // p1 断线后不再立即 drop 出 eligiblePlayerIds（Bug3 修复），
    // p2 单独确认不应推进
    const room = rooms.getRoomByPlayer('p2');
    expect(room.isAwaitingSettlementAck()).toBe(true);
    expect(room.ackReady('p2')).toBe(false);

    // 模拟结算超时：手动 drop 掉线的 p1
    // dropFromSettlementWait 返回 true 表示剩余待确认者（只有 p2）都已确认
    expect(room.dropFromSettlementWait('p1')).toBe(true);
    expect(room.isAwaitingSettlementAck()).toBe(true); // advanceRoom 还没被调用

    // 模拟 advanceRoom 的剩余逻辑
    room.clearSettlementWait();
    const nr = room.nextRound();
    expect(nr.ended).toBe(true);
    expect(room.status).toBe('waiting');
    expect(room.players).toHaveLength(2);
    const p1 = room.players.find((p) => p.id === 'p1');
    expect(p1).toBeDefined();
    expect(p1.connected).toBe(false);
  });
});
