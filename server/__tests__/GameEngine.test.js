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

describe('GameEngine — lastActionPhase（用户反馈 2026-08-02："新的一轮的时候，上一轮的气泡不应该还存在吧"）', () => {
  it('一条街最后一个动作（触发进入下一条街）的 lastActionPhase 是它实际发生的那条街，不是广播时已经变成的新street', () => {
    const game = new GameEngine(makePlayers(2), 0, 100);
    const p1 = game.players[game.actionIndex];
    game.call(p1.id);
    const p2 = game.players[game.actionIndex];
    const state = game.check(p2.id); // 结束翻前，进入翻牌
    expect(game.phase).toBe('flop'); // 广播时 phase 已经是新的一条街
    expect(state.state.lastActionPhase).toBe('preflop'); // 但这个动作真的发生在翻前
    expect(state.state.lastActionBy).toBe(p2.id);
  });

  it('一条街内非最后一个动作（不触发换街）的 lastActionPhase 跟当前 phase 一致', () => {
    const game = new GameEngine(makePlayers(3), 0, 100);
    const p1 = game.players[game.actionIndex];
    const state = game.call(p1.id); // 3 人桌，第一个跟注不会立刻结束翻前
    expect(game.phase).toBe('preflop');
    expect(state.state.lastActionPhase).toBe('preflop');
  });

  it('弃牌到只剩一人直接摊牌：lastActionPhase 是弃牌发生的那条街，不是 showdown', () => {
    const game = new GameEngine(makePlayers(2), 0, 100);
    const actor = game.players[game.actionIndex];
    const result = game.fold(actor.id);
    expect(game.phase).toBe('showdown');
    expect(result.state.lastActionPhase).toBe('preflop');
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

  it('fold-win（其余人全部弃牌，没有真正比牌）：本手已经弃牌的玩家看不到那个未战而胜的赢家的牌（回归：真机实测"弃牌后还能看到对方摊牌"）', () => {
    const game = new GameEngine(makePlayers(3), 0, 20);
    // 让第一个行动方弃牌，其余两人打到摊牌（简化：直接把剩下两人也弃到只剩一个，
    // 关键是先弃牌那位在摊牌阶段回看，不应该看到任何人的牌）。
    const folder = game.players[game.actionIndex];
    game.fold(folder.id);
    const second = game.players[game.actionIndex];
    game.fold(second.id);
    // 此时只剩一人未弃牌 → 直接 _endHand，phase 变为 showdown，是 fold-win。
    expect(game.phase).toBe('showdown');
    expect(game.lastHandFoldWin).toBe(true);

    const folderState = game.getStateForPlayer(folder.id);
    for (const p of folderState.players) {
      if (p.id === folder.id) continue; // 自己的牌永远可见，不受影响
      expect(p.holeCards.every(c => c === null || c === undefined)).toBe(true);
    }
  });

  it('真正的多人摊牌（弃牌后桌上还剩 2+ 人打到河牌、真的比牌，不是全弃到剩一人）：已经弃牌的玩家应该能看到这个真实摊牌，跟真人牌桌上摊牌是公开信息一致（用户反馈 2026-08-02："我中间弃牌了，最后几个电脑走到摊牌结算...在结算的时候，我看不到这几个电脑的摊牌"——之前的修复把 fold-win 和真实摊牌这两种都归到"phase===showdown 就该藏"，没有区分开）', () => {
    const game = new GameEngine(makePlayers(3), 0, 20);
    const folder = game.players[game.actionIndex];
    game.fold(folder.id);
    expect(game.phase).not.toBe('showdown'); // 还剩 2 个活跃玩家，牌局继续

    // 剩下两人一路过牌/跟注打到真正的河牌摊牌，不再有人弃牌。
    while (game.phase !== 'showdown') {
      const p = game.players[game.actionIndex];
      const toCall = game.currentBet - p.bet;
      if (toCall > 0) game.call(p.id); else game.check(p.id);
    }
    expect(game.lastHandFoldWin).toBe(false); // 是真实比牌，不是 fold-win

    const folderState = game.getStateForPlayer(folder.id);
    const others = folderState.players.filter(p => p.id !== folder.id);
    expect(others.length).toBeGreaterThan(0);
    for (const p of others) {
      expect(p.holeCards[0]).not.toBeNull();
    }
  });

  it('摊牌阶段，本手未弃牌的玩家仍能看到其他人的揭示牌（确认上一条修复没有误伤正常摊牌）', () => {
    const game = new GameEngine(makePlayers(3), 0, 20);
    const folder = game.players[game.actionIndex];
    game.fold(folder.id);
    const second = game.players[game.actionIndex];
    game.fold(second.id);
    const winner = game.players.find(p => p.status !== 'folded');
    const winnerState = game.getStateForPlayer(winner.id);
    const folderInWinnerView = winnerState.players.find(p => p.id === folder.id);
    expect(folderInWinnerView.holeCards[0]).not.toBeNull();
  });
});

describe('GameEngine — 摊牌 bestCards / handNameShort（用于牌桌高亮，用户反馈 2026-07-24）', () => {
  it('单一赢家：bestCards 是组成最大牌型的5张，handNameShort 是不带踢脚的牌型短名', () => {
    const game = new GameEngine(makePlayers(2), 0, 20);
    const [p1, p2] = game.players;
    p1.holeCards = ['Ah', 'Ac']; // 一对A
    p2.holeCards = ['3c', '4c']; // 高牌
    game.communityCards = ['2h', '7c', '9d', 'Jc', 'Kd'];
    // 让两人已投入筹码相等，避免因盲注差额触发边池分层（那是另一套已覆盖的行为）
    p1.totalBet = p2.totalBet = 20;

    const result = game._endHand(game.players);
    const winner = result.winners.find(w => w.id === p1.id);
    expect(winner).toBeDefined();
    expect(winner.handNameShort).toBe('一对');
    expect(winner.bestCards).toHaveLength(5);
    const rawSet = new Set(winner.bestCards.map(c => c.raw));
    expect(rawSet.has('Ah')).toBe(true);
    expect(rawSet.has('Ac')).toBe(true);

    const loser = result.winners.find(w => w.id === p2.id);
    expect(loser).toBeUndefined(); // 没赢，不在 winners 里
  });

  it('弃牌获胜（foldWin）：不产出 bestCards / handNameShort', () => {
    const game = new GameEngine(makePlayers(2), 0, 20);
    const actor = game.players[game.actionIndex];
    const result = game.fold(actor.id);
    expect(result.foldWin).toBe(true);
    const winner = result.winners[0];
    expect(winner.handNameShort).toBeNull();
    expect(winner.bestCards).toEqual([]);
  });

  it('多个赢家（平分底池/公共牌打满）：每个赢家各自拿到自己的 bestCards，不是只有一组', () => {
    const game = new GameEngine(makePlayers(2), 0, 20);
    const [p1, p2] = game.players;
    // 公共牌本身就是皇家同花顺，双方底牌都打不过公共牌，只能打平分公共牌
    game.communityCards = ['Ah', 'Kh', 'Qh', 'Jh', 'Th'];
    p1.holeCards = ['2c', '3d'];
    p2.holeCards = ['4c', '5d'];
    p1.totalBet = p2.totalBet = 20;

    const result = game._endHand(game.players);
    expect(result.winners).toHaveLength(2);
    for (const w of result.winners) {
      expect(w.handNameShort).toBe('皇家同花顺');
      expect(w.bestCards).toHaveLength(5);
      const rawSet = new Set(w.bestCards.map(c => c.raw));
      for (const boardCard of game.communityCards) {
        expect(rawSet.has(boardCard)).toBe(true);
      }
    }
  });
});
