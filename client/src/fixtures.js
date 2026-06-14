// Fixed game states for self-verification — renders the REAL GameTable component.
const c = (rank, suit) => ({ rank, suit, color: (suit === '♥' || suit === '♦') ? 'red' : 'black' });

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
    showdown: [{ name: '陈美玲', handName: '两对 Q & 5' }],
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

// Settlement modal over the (dimmed) showdown table
STATES.push({
  name: '结算弹窗', myId: 'me', roomCode: '4827',
  gameState: STATES[3].gameState,
  settlement: {
    winner: { id: 'chen', name: '陈美玲', amount: 1780, hand: '两对 Q 和 5' },
    results: [
      { name: '陈美玲', delta: 1780 },
      { name: '王建国', delta: -500 },
      { name: 'Augustine（我）', delta: -650, isMe: true },
      { name: '张伟 / 李大明 / 赵军', delta: null },
    ],
  },
});
