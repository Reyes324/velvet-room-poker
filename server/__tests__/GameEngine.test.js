import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { GameEngine } = require('../GameEngine');

function makePlayers(n = 2, chips = 1000) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    name: `Player ${i + 1}`,
    chips,
  }));
}

describe('GameEngine — 初始化', () => {
  it('发完牌后底池等于大小盲之和', () => {
    const game = new GameEngine(makePlayers(2), 0, 200);
    expect(game.pot).toBe(300); // SB=100 + BB=200
  });

  it('每位玩家有2张底牌', () => {
    const game = new GameEngine(makePlayers(3), 0, 200);
    for (const p of game.players) {
      expect(p.holeCards).toHaveLength(2);
    }
  });

  it('正确分配小盲/大盲/庄家', () => {
    const game = new GameEngine(makePlayers(3), 0, 200);
    expect(game.players[0].isDealer).toBe(true);
    expect(game.players[1].isSB).toBe(true);
    expect(game.players[2].isBB).toBe(true);
  });

  it('小盲筹码减少100，大盲减少200', () => {
    // 3 players: dealer=0, SB=1, BB=2
    const game = new GameEngine(makePlayers(3, 1000), 0, 200);
    expect(game.players[1].chips).toBe(900); // SB paid 100
    expect(game.players[2].chips).toBe(800); // BB paid 200
  });

  it('单挑（2人）时庄家是小盲、翻牌前先手，另一人是大盲', () => {
    // Heads-up is a special case in real Hold'em rules: the dealer/button
    // posts the small blind (and acts first preflop) — NOT the ring-game
    // rule (dealer+1=SB, dealer+2=BB), which for n=2 degenerates to handing
    // the dealer the BIG blind instead (dealer+2 wraps back to the dealer).
    const game = new GameEngine(makePlayers(2, 1000), 0, 200);
    expect(game.players[0].isDealer).toBe(true);
    expect(game.players[0].isSB).toBe(true);
    expect(game.players[0].isBB).toBe(false);
    expect(game.players[1].isSB).toBe(false);
    expect(game.players[1].isBB).toBe(true);
    expect(game.players[0].chips).toBe(900); // dealer/SB paid 100
    expect(game.players[1].chips).toBe(800); // BB paid 200
    expect(game.players[game.actionIndex].id).toBe(game.players[0].id); // dealer/SB acts first preflop
  });

  it('单挑时庄家换成非 0 号座位，小盲依然正确跟着庄家走', () => {
    const game = new GameEngine(makePlayers(2, 1000), 1, 200);
    expect(game.players[1].isDealer).toBe(true);
    expect(game.players[1].isSB).toBe(true);
    expect(game.players[0].isBB).toBe(true);
    expect(game.players[game.actionIndex].id).toBe(game.players[1].id);
  });
});

describe('GameEngine — 动作校验', () => {
  it('不是自己回合时 fold 返回错误', () => {
    const game = new GameEngine(makePlayers(2), 0, 200);
    const wrongPlayer = game.players.find(p => p.id !== game.players[game.actionIndex].id);
    const result = game.fold(wrongPlayer.id);
    expect(result.error).toBeDefined();
  });

  it('有未跟注时 check 返回错误', () => {
    const game = new GameEngine(makePlayers(3), 0, 200);
    const current = game.players[game.actionIndex];
    // preflop: currentBet=200, UTG hasn't matched it
    if (game.currentBet > current.bet) {
      const result = game.check(current.id);
      expect(result.error).toBeDefined();
    }
  });

  it('加注低于最小值时返回错误', () => {
    const game = new GameEngine(makePlayers(2), 0, 200);
    const current = game.players[game.actionIndex];
    const tooSmall = game.currentBet + 1;
    const result = game.raise(current.id, tooSmall);
    expect(result.error).toBeDefined();
  });

  it('call 后玩家筹码正确减少', () => {
    const game = new GameEngine(makePlayers(2), 0, 200);
    const actor = game.players[game.actionIndex];
    const chipsBefore = actor.chips;
    const toCall = game.currentBet - actor.bet;
    game.call(actor.id);
    expect(actor.chips).toBe(chipsBefore - toCall);
  });
});

describe('GameEngine — 街道推进', () => {
  it('翻牌前所有人过牌/跟注后进入翻牌圈，公共牌变为3张', () => {
    const game = new GameEngine(makePlayers(2), 0, 100);
    const p1 = game.players[game.actionIndex];
    game.call(p1.id);
    const p2 = game.players[game.actionIndex];
    game.check(p2.id);
    expect(game.phase).toBe('flop');
    expect(game.communityCards).toHaveLength(3);
  });

  it('弃牌后只剩一个玩家则进入摊牌并宣布赢家', () => {
    const game = new GameEngine(makePlayers(2), 0, 100);
    const actor = game.players[game.actionIndex];
    const result = game.fold(actor.id);
    expect(result.showdown).toBe(true);
    expect(result.winners).toHaveLength(1);
  });
});

describe('GameEngine — getStateForPlayer 隐藏底牌', () => {
  it('玩家只能看到自己的底牌，对手底牌为 null', () => {
    const game = new GameEngine(makePlayers(2), 0, 200);
    const [p1, p2] = game.players;
    const state = game.getStateForPlayer(p1.id);
    const myCards = state.players.find(p => p.id === p1.id).holeCards;
    const oppCards = state.players.find(p => p.id === p2.id).holeCards;
    expect(myCards).toHaveLength(2);
    expect(myCards[0]).not.toBeNull();
    expect(oppCards[0]).toBeNull();
    expect(oppCards[1]).toBeNull();
  });

  it('摊牌阶段获胜者底牌可见', () => {
    const game = new GameEngine(makePlayers(2), 0, 100);
    const actor = game.players[game.actionIndex];
    game.fold(actor.id);
    const winner = game.players.find(p => p.status !== 'folded');
    const state = game.getStateForPlayer(winner.id);
    const winnerState = state.players.find(p => p.id === winner.id);
    expect(winnerState.holeCards.length).toBeGreaterThan(0);
    expect(winnerState.holeCards[0]).not.toBeNull();
  });
});
