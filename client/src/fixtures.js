// Fixed game states for self-verification — renders the REAL GameTable component.
const SUIT_RAW = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' };
// `raw` mirrors the server's internal notation (e.g. 'Qs') so the showdown
// highlight fixture below can match community/hole cards against a winner's
// `bestCards` exactly like the real game:showdown payload does.
const c = (rank, suit) => ({ rank, suit, color: (suit === '♥' || suit === '♦') ? 'red' : 'black', raw: `${rank === '10' ? 'T' : rank}${SUIT_RAW[suit]}` });

const base = [
  { id: 'wang', name: '王建国', isDealer: true },
  { id: 'chen', name: '陈美玲', isSB: true },
  { id: 'zhang', name: '张伟' },
  { id: 'li', name: '李大明', isBB: true },
  { id: 'zhao', name: '赵军' },
  { id: 'me', name: 'Augustine' },
];
const P = (over) => base.map(b => ({ chips: 1000, bet: 0, status: 'active', holeCards: [null, null], ...b, ...(over[b.id] || {}) }));

export const STATES = [
  {
    name: '翻牌前 · 对手思考', myId: 'me', roomCode: '4827',
    gameState: {
      phase: 'preflop', pot: 30, currentBet: 20, actionPlayerId: 'wang',
      communityCards: [null, null, null, null, null],
      players: P({
        wang: { chips: 1000 }, chen: { chips: 15989, bet: 10 }, zhang: { status: 'folded' },
        li: { chips: 480, bet: 20 }, zhao: { status: 'folded' },
        me: { chips: 12549, holeCards: [c('8', '♠'), c('J', '♥')] },
      }),
    },
  },
  {
    name: '轮到我 · 行动栏', myId: 'me', roomCode: '4827',
    gameState: {
      phase: 'preflop', pot: 230, currentBet: 100, actionPlayerId: 'me',
      communityCards: [null, null, null, null, null],
      players: P({
        wang: { chips: 900, bet: 100 }, chen: { chips: 15889, bet: 100 }, zhang: { status: 'folded' },
        li: { status: 'folded' }, zhao: { status: 'folded' },
        me: { chips: 12549, holeCards: [c('8', '♠'), c('J', '♥')] },
      }),
    },
  },
  {
    name: '翻牌 · 对手行动', myId: 'me', roomCode: '4827',
    gameState: {
      phase: 'flop', pot: 730, currentBet: 0, actionPlayerId: 'chen',
      communityCards: [c('Q', '♠'), c('3', '♥'), c('Q', '♦'), null, null],
      players: P({
        wang: { chips: 650 }, chen: { chips: 15639 }, zhang: { status: 'folded' },
        li: { status: 'folded' }, zhao: { status: 'folded' },
        me: { chips: 12299, holeCards: [c('8', '♠'), c('J', '♥')] },
      }),
    },
  },
  {
    name: '摊牌', myId: 'me', roomCode: '4827',
    showdown: [{
      id: 'chen', name: '陈美玲', handName: '两对，对Q和对5', handNameShort: '两对',
      // Best 5: both her hole cards (pair of 5s) + the board's pair of Qs + the 7 kicker —
      // the board's 3♥/2♥ and everyone else's hole cards should dim, not highlight.
      bestCards: [c('Q', '♠'), c('Q', '♦'), c('5', '♦'), c('5', '♣'), c('7', '♣')],
    }],
    gameState: {
      phase: 'showdown', pot: 1780, currentBet: 0, actionPlayerId: null,
      communityCards: [c('Q', '♠'), c('3', '♥'), c('Q', '♦'), c('7', '♣'), c('2', '♥')],
      players: P({
        wang: { chips: 250, holeCards: [c('K', '♠'), c('A', '♥')] },
        chen: { chips: 15239, holeCards: [c('5', '♦'), c('5', '♣')] },
        zhang: { status: 'folded' }, li: { status: 'folded' }, zhao: { status: 'folded' },
        me: { chips: 11899, holeCards: [c('8', '♠'), c('J', '♥')] },
      }),
    },
  },
];

// Lobby / waiting room
STATES.push({
  name: '大厅',
  lobby: {
    playerId: 'me',
    roomState: {
      code: '4827', hostId: 'me',
      players: [
        { id: 'me', name: 'Augustine', chips: 12549 },
        { id: 'wang', name: '王建国', chips: 1000 },
        { id: 'chen', name: '陈美玲', chips: 15999 },
      ],
    },
  },
});

// Spectator view: mid-game joiner waiting for the next hand (myId isn't in
// gameState.players at all — amPlaying=false is passed explicitly so
// GameTable can't fall back to ordered[0] and mislabel a real opponent as "me").
STATES.push({
  name: '旁观·中途加入等待下一手', myId: 'newguy', roomCode: '4827', amPlaying: false, myChips: 1000,
  gameState: {
    phase: 'flop', pot: 730, currentBet: 0, actionPlayerId: 'chen',
    communityCards: [c('Q', '♠'), c('3', '♥'), c('Q', '♦'), null, null],
    players: P({
      wang: { chips: 650 }, chen: { chips: 15639 },
      zhang: { status: 'folded' }, li: { status: 'folded' }, zhao: { status: 'folded' },
    }).filter(p => p.id !== 'me'),
  },
});

// Spectator view: busted, chose "旁观留下" — persistent rebuy affordance in footer.
STATES.push({
  name: '旁观·归零留下', myId: 'newguy', roomCode: '4827', amPlaying: false, myChips: 0,
  gameState: {
    phase: 'flop', pot: 730, currentBet: 0, actionPlayerId: 'chen',
    communityCards: [c('Q', '♠'), c('3', '♥'), c('Q', '♦'), null, null],
    players: P({
      wang: { chips: 650 }, chen: { chips: 15639 },
      zhang: { status: 'folded' }, li: { status: 'folded' }, zhao: { status: 'folded' },
    }).filter(p => p.id !== 'me'),
  },
});

// Settlement modal over the (dimmed) showdown table — real showdown, hand
// description shown. Also carries `showdown` so the highlight/hand-name
// banner behind the sheet previews correctly — per design, those stay lit
// through the whole settlement, not just the initial reveal beat.
STATES.push({
  name: '结算弹窗·真摊牌', myId: 'me', roomCode: '4827',
  gameState: STATES[3].gameState,
  showdown: STATES[3].showdown,
  settlement: {
    winners: [{ id: 'chen', name: '陈美玲', won: 1780, handName: '两对，对Q和对5' }],
  },
});

// Same component, fold-win case — no real hand to describe, wording alone
// ("其他人全部弃牌") tells it apart from the real-showdown fixture above.
STATES.push({
  name: '结算弹窗·弃牌结束', myId: 'me', roomCode: '4827',
  gameState: STATES[1].gameState,
  settlement: {
    foldWin: true,
    winners: [{ id: 'wang', name: '王建国', won: 200, handName: '其他人全部弃牌' }],
  },
});

// 筹码归零决策弹窗 — over a live (still amPlaying) table just so there's
// something visible behind the overlay; the modal itself only appears once
// RoomPage detects the >0→0 chip transition, independent of amPlaying here.
STATES.push({
  name: '筹码归零决策弹窗', myId: 'me', roomCode: '4827',
  gameState: STATES[1].gameState,
  bustPreview: true,
});

// 账本弹窗
STATES.push({
  name: '账本弹窗', myId: 'me', roomCode: '4827',
  gameState: STATES[1].gameState,
  ledgerPreview: {
    startingChips: 1000,
    players: [
      { id: 'me', name: 'Augustine', chips: 12549, debt: 0 },
      { id: 'wang', name: '王建国', chips: 0, debt: 2000 },
      { id: 'chen', name: '陈美玲', chips: 15889, debt: 0 },
      { id: 'zhang', name: '张伟', chips: 1000, debt: 1000 },
    ],
  },
});

// 9-max dense table — verifies the column layout's two-per-row density and
// card-shrink rules under the fullest supported room size.
STATES.push({
  name: '9人满桌·密集', myId: 'me', roomCode: '4827',
  gameState: {
    phase: 'flop', pot: 480, currentBet: 0, actionPlayerId: 'p3',
    communityCards: [c('9', '♣'), c('4', '♦'), c('K', '♥'), null, null],
    players: [
      { id: 'me', name: 'Augustine', chips: 900, bet: 0, status: 'active', holeCards: [c('8', '♠'), c('J', '♥')] },
      { id: 'p1', name: '王建国', chips: 800, bet: 0, status: 'active', holeCards: [null, null], isDealer: true },
      { id: 'p2', name: '陈美玲', chips: 700, bet: 0, status: 'folded', holeCards: [null, null], isSB: true },
      { id: 'p3', name: '张伟', chips: 600, bet: 0, status: 'active', holeCards: [null, null], isBB: true },
      { id: 'p4', name: '李大明是个非常长的名字', chips: 500, bet: 0, status: 'active', holeCards: [null, null] },
      { id: 'p5', name: '赵军', chips: 400, bet: 0, status: 'allin', holeCards: [null, null] },
      { id: 'p6', name: '孙丽', chips: 300, bet: 0, status: 'folded', holeCards: [null, null] },
      { id: 'p7', name: '周涛', chips: 200, bet: 0, status: 'active', holeCards: [null, null] },
      { id: 'p8', name: '吴敏', chips: 100, bet: 0, status: 'active', holeCards: [null, null] },
    ],
  },
});

// 密集9人桌摊牌：验证赢家牌放大到 md 后，在最紧凑的行距（76px）下是否会跟相邻行
// 的座位/揭示牌相撞——赢家特意放在中间行（p4），两侧行都有座位，是碰撞风险最高的位置。
STATES.push({
  name: '9人满桌·密集·摊牌（碰撞压力测试）', myId: 'me', roomCode: '4827',
  showdown: [{
    id: 'p4', name: '李大明是个非常长的名字', handName: '三条，8带K高', handNameShort: '三条',
    bestCards: [c('8', '♠'), c('8', '♥'), c('8', '♦'), c('K', '♣'), c('9', '♦')],
  }],
  gameState: {
    phase: 'showdown', pot: 3600, currentBet: 0, actionPlayerId: null,
    communityCards: [c('8', '♦'), c('4', '♣'), c('K', '♣'), c('9', '♦'), c('2', '♠')],
    players: [
      { id: 'me', name: 'Augustine', chips: 900, bet: 0, status: 'folded', holeCards: [c('8', '♠'), c('J', '♥')] },
      { id: 'p1', name: '王建国', chips: 800, bet: 0, status: 'active', holeCards: [c('A', '♠'), c('Q', '♥')], isDealer: true },
      { id: 'p2', name: '陈美玲', chips: 700, bet: 0, status: 'folded', holeCards: [null, null], isSB: true },
      { id: 'p3', name: '张伟', chips: 600, bet: 0, status: 'active', holeCards: [c('2', '♥'), c('3', '♣')], isBB: true },
      { id: 'p4', name: '李大明是个非常长的名字', chips: 4100, bet: 0, status: 'active', holeCards: [c('8', '♥'), c('7', '♠')] },
      { id: 'p5', name: '赵军', chips: 400, bet: 0, status: 'allin', holeCards: [c('10', '♣'), c('10', '♥')] },
      { id: 'p6', name: '孙丽', chips: 300, bet: 0, status: 'folded', holeCards: [null, null] },
      { id: 'p7', name: '周涛', chips: 200, bet: 0, status: 'active', holeCards: [c('5', '♣'), c('6', '♦')] },
      { id: 'p8', name: '吴敏', chips: 100, bet: 0, status: 'active', holeCards: [c('4', '♠'), c('9', '♣')] },
    ],
  },
});

// 7人桌摊牌（用户要求实测对比：7人行距100px，比9人的76px松，用来跟9人版对照严重程度）
STATES.push({
  name: '7人桌·摊牌（碰撞对比）', myId: 'me', roomCode: '4827',
  showdown: [{
    id: 'p4', name: '赵军', handName: '三条，8带K高', handNameShort: '三条',
    bestCards: [c('8', '♠'), c('8', '♥'), c('8', '♦'), c('K', '♣'), c('9', '♦')],
  }],
  gameState: {
    phase: 'showdown', pot: 2400, currentBet: 0, actionPlayerId: null,
    communityCards: [c('8', '♦'), c('4', '♣'), c('K', '♣'), c('9', '♦'), c('2', '♠')],
    players: [
      { id: 'me', name: 'Augustine', chips: 900, bet: 0, status: 'folded', holeCards: [c('8', '♠'), c('J', '♥')] },
      { id: 'p1', name: '王建国', chips: 800, bet: 0, status: 'active', holeCards: [c('A', '♠'), c('Q', '♥')], isDealer: true },
      { id: 'p2', name: '陈美玲', chips: 700, bet: 0, status: 'folded', holeCards: [null, null], isSB: true },
      { id: 'p3', name: '张伟', chips: 600, bet: 0, status: 'active', holeCards: [c('2', '♥'), c('3', '♣')], isBB: true },
      { id: 'p4', name: '赵军', chips: 3900, bet: 0, status: 'active', holeCards: [c('8', '♥'), c('7', '♠')] },
      { id: 'p5', name: '周涛', chips: 200, bet: 0, status: 'active', holeCards: [c('5', '♣'), c('6', '♦')] },
      { id: 'p6', name: '吴敏', chips: 100, bet: 0, status: 'active', holeCards: [c('4', '♠'), c('9', '♣')] },
    ],
  },
});

// 8人桌摊牌（用户要求实测对比：8人行距已经是最紧的76px，跟9人同一档）
STATES.push({
  name: '8人桌·摊牌（碰撞对比）', myId: 'me', roomCode: '4827',
  showdown: [{
    id: 'p4', name: '赵军', handName: '三条，8带K高', handNameShort: '三条',
    bestCards: [c('8', '♠'), c('8', '♥'), c('8', '♦'), c('K', '♣'), c('9', '♦')],
  }],
  gameState: {
    phase: 'showdown', pot: 3200, currentBet: 0, actionPlayerId: null,
    communityCards: [c('8', '♦'), c('4', '♣'), c('K', '♣'), c('9', '♦'), c('2', '♠')],
    players: [
      { id: 'me', name: 'Augustine', chips: 900, bet: 0, status: 'folded', holeCards: [c('8', '♠'), c('J', '♥')] },
      { id: 'p1', name: '王建国', chips: 800, bet: 0, status: 'active', holeCards: [c('A', '♠'), c('Q', '♥')], isDealer: true },
      { id: 'p2', name: '陈美玲', chips: 700, bet: 0, status: 'folded', holeCards: [null, null], isSB: true },
      { id: 'p3', name: '张伟', chips: 600, bet: 0, status: 'active', holeCards: [c('2', '♥'), c('3', '♣')], isBB: true },
      { id: 'p4', name: '赵军', chips: 3400, bet: 0, status: 'active', holeCards: [c('8', '♥'), c('7', '♠')] },
      { id: 'p5', name: '孙丽', chips: 300, bet: 0, status: 'folded', holeCards: [null, null] },
      { id: 'p6', name: '周涛', chips: 200, bet: 0, status: 'active', holeCards: [c('5', '♣'), c('6', '♦')] },
      { id: 'p7', name: '吴敏', chips: 100, bet: 0, status: 'active', holeCards: [c('4', '♠'), c('9', '♣')] },
    ],
  },
});

// 英雄同时是行动方（读秒遮罩）且自己有下注（持久气泡）——真机实测暴露过这个组合会让
// 英雄小头像座位跟 .hero-section（姓名+筹码+大手牌）重叠糊在一起，此前没有任何 fixture
// 同时覆盖到这两个条件。2 人局，跟真机截图复现的场景一致。
STATES.push({
  name: '英雄行动中且有下注（2人局，真机重叠回归）', myId: 'me', roomCode: '4827',
  gameState: {
    phase: 'preflop', pot: 30, currentBet: 20, actionPlayerId: 'me',
    communityCards: [null, null, null, null, null],
    players: [
      { id: 'op', name: '邱伟佳', chips: 980, bet: 20, status: 'active', holeCards: [null, null], isDealer: true },
      { id: 'me', name: '测试', chips: 990, bet: 10, status: 'active', isSB: true, holeCards: [c('10', '♦'), c('J', '♦')] },
    ],
  },
});

// 用户反馈（2026-07-28）：对手身家比自己短很多时，加注/全下面板不该还能选
// 到自己的全部身家——超过对手身家的部分反正结算时会原路退还，允许选到那
// 个数字只会制造"这数字什么意思"的困惑。真正上限 = min(自己身家, 场上还
// 没弃牌的对手里最长的那个人的身家)。这个 fixture 专门覆盖"对手明显短码"
// 这一种，回归用（ActionBar.jsx 的 maxRaise/跟注文案）。
STATES.push({
  name: '对手身家远小于自己（全下/跟注封顶回归）', myId: 'me', roomCode: '4827',
  gameState: {
    phase: 'preflop', pot: 115, currentBet: 95, actionPlayerId: 'me',
    communityCards: [null, null, null, null, null],
    players: [
      { id: 'op', name: '短码对手', chips: 0, bet: 95, status: 'allin', holeCards: [null, null], isDealer: true },
      { id: 'me', name: '测试', chips: 990, bet: 10, status: 'active', isSB: true, holeCards: [c('10', '♦'), c('J', '♦')] },
    ],
  },
});
