/**
 * GameEngine 场景测试 — 跨轮次、完整对局流程
 *
 * 测试策略：
 * - 不测孤立动作（已有 GameEngine.test.js 覆盖）
 * - 专测多动作序列，尤其是轮次切换时的状态重置
 * - 对每手牌验证"底池守恒"不变量
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { GameEngine } = require('../GameEngine');

const BIG_BLIND = 20;

function makePlayers(n = 2, chips = 1000) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    name: `Player ${i + 1}`,
    chips,
  }));
}

/** 断言：底池 + 所有玩家筹码 = 初始总筹码（不变量） */
function assertPotConservation(game, totalChips) {
  const sumChips = game.players.reduce((s, p) => s + p.chips, 0);
  expect(game.pot + sumChips).toBe(totalChips);
}

/** 推进到翻牌圈（2人局）：SB call → BB check */
function advanceToFlop(game) {
  expect(game.phase).toBe('preflop');
  const sbId = game.players[game.actionIndex].id;
  game.call(sbId);
  const bbId = game.players[game.actionIndex].id;
  game.check(bbId);
  expect(game.phase).toBe('flop');
}

/** 双方依次过牌（新一轮无注），推进到下一个街道 */
function bothCheck(game) {
  const first = game.players[game.actionIndex].id;
  game.check(first);
  const second = game.players[game.actionIndex].id;
  game.check(second);
}

// ─── 核心 bug 复现 ────────────────────────────────────────────────────────────

describe('Bug 回归：lastRaiseAmount 轮次切换后应重置', () => {
  it('翻牌前加注 80，进入翻牌圈后最小加注仍应为大盲 20', () => {
    const game = new GameEngine(makePlayers(2), 0, BIG_BLIND);
    // preflop: SB raises to 100 (raise increment = 80)
    const sbId = game.players[game.actionIndex].id;
    game.raise(sbId, 100);
    const bbId = game.players[game.actionIndex].id;
    game.call(bbId);

    expect(game.phase).toBe('flop');
    expect(game.lastRaiseAmount).toBe(BIG_BLIND); // 必须重置，不能是 80

    // 翻牌圈尝试加注 10（低于大盲 20）→ 应该报错
    const actor = game.players[game.actionIndex].id;
    const tooSmall = game.raise(actor, 10);
    expect(tooSmall.error).toBeDefined();

    // 加注 20（等于大盲）→ 应该通过
    const valid = game.raise(actor, 20);
    expect(valid.error).toBeUndefined();
  });

  it('转牌圈加注 120，进入河牌圈后最小加注应为大盲 20', () => {
    const game = new GameEngine(makePlayers(2), 0, BIG_BLIND);
    // preflop: call + check → flop
    const sb0 = game.players[game.actionIndex].id;
    game.call(sb0);
    game.check(game.players[game.actionIndex].id);
    // flop: check + check → turn
    bothCheck(game);
    expect(game.phase).toBe('turn');

    // turn: raise to 120
    const turnActor = game.players[game.actionIndex].id;
    game.raise(turnActor, 120);
    game.call(game.players[game.actionIndex].id);
    expect(game.phase).toBe('river');

    expect(game.lastRaiseAmount).toBe(BIG_BLIND); // reset!
    expect(game.currentBet).toBe(0);

    // river: min raise = 20, not 120
    const riverActor = game.players[game.actionIndex].id;
    const bad = game.raise(riverActor, 15);
    expect(bad.error).toBeDefined();
    const good = game.raise(riverActor, BIG_BLIND);
    expect(good.error).toBeUndefined();
  });
});

// ─── 完整手牌流程 ─────────────────────────────────────────────────────────────

describe('完整手牌：全程过牌至摊牌', () => {
  it('2人局，双方每轮过牌直至摊牌', () => {
    const game = new GameEngine(makePlayers(2), 0, BIG_BLIND);
    const total = 2000;

    advanceToFlop(game);
    assertPotConservation(game, total);

    bothCheck(game); // flop
    expect(game.phase).toBe('turn');
    assertPotConservation(game, total);

    bothCheck(game); // turn
    expect(game.phase).toBe('river');
    assertPotConservation(game, total);

    const r1 = game.check(game.players[game.actionIndex].id);
    const r2 = game.check(game.players[game.actionIndex].id);
    const result = r2.showdown ? r2 : r1;
    expect(result.showdown).toBe(true);
    expect(result.winners).toHaveLength(1);
    assertPotConservation(game, total);
  });
});

describe('完整手牌：每轮都有加注', () => {
  it('每个街道各加注一次，最终摊牌', () => {
    const game = new GameEngine(makePlayers(2), 0, BIG_BLIND);
    const total = 2000;

    // preflop: raise + call
    const sb = game.players[game.actionIndex].id;
    game.raise(sb, 60);
    game.call(game.players[game.actionIndex].id);
    expect(game.phase).toBe('flop');
    assertPotConservation(game, total);

    // flop: raise + call
    const f1 = game.players[game.actionIndex].id;
    game.raise(f1, 40);
    game.call(game.players[game.actionIndex].id);
    expect(game.phase).toBe('turn');
    assertPotConservation(game, total);

    // turn: raise + call
    const t1 = game.players[game.actionIndex].id;
    game.raise(t1, 50);
    game.call(game.players[game.actionIndex].id);
    expect(game.phase).toBe('river');
    assertPotConservation(game, total);

    // river: check + check → showdown
    const rv1 = game.check(game.players[game.actionIndex].id);
    const rv2 = game.check(game.players[game.actionIndex].id);
    const result = rv2.showdown ? rv2 : rv1;
    expect(result.showdown).toBe(true);
    assertPotConservation(game, total);
  });
});

// ─── 报错不破坏状态 ───────────────────────────────────────────────────────────

describe('报错后游戏状态保持完整', () => {
  it('加注金额非法报错后，仍可重新合法加注', () => {
    const game = new GameEngine(makePlayers(2), 0, BIG_BLIND);
    const actor = game.players[game.actionIndex];

    const phaseBeforeError = game.phase;
    const potBeforeError = game.pot;
    const chipsBeforeError = actor.chips;

    // 非法加注（金额太小）
    const bad = game.raise(actor.id, 1);
    expect(bad.error).toBeDefined();

    // 状态不变
    expect(game.phase).toBe(phaseBeforeError);
    expect(game.pot).toBe(potBeforeError);
    expect(actor.chips).toBe(chipsBeforeError);
    expect(game.actionIndex).toBe(game.players.indexOf(actor));

    // 重新合法加注
    const good = game.raise(actor.id, 60);
    expect(good.error).toBeUndefined();
    expect(good.state).toBeDefined();
  });

  it('轮次错误操作后，下一个合法操作正常推进', () => {
    const game = new GameEngine(makePlayers(2), 0, BIG_BLIND);
    const wrong = game.players.find((_, i) => i !== game.actionIndex);
    const err = game.fold(wrong.id);
    expect(err.error).toBeDefined();
    // 正确玩家仍可操作
    const ok = game.call(game.players[game.actionIndex].id);
    expect(ok.error).toBeUndefined();
  });
});

// ─── 底池守恒不变量 ───────────────────────────────────────────────────────────

describe('底池守恒不变量', () => {
  it('3人局每次操作后 pot + chips === 3000', () => {
    const total = 3000;
    const game = new GameEngine(makePlayers(3), 0, BIG_BLIND);
    assertPotConservation(game, total);

    // p0 = dealer, p1=SB, p2=BB, action at p0 first
    const utg = game.players[game.actionIndex].id;
    game.call(utg);
    assertPotConservation(game, total);

    const sb = game.players[game.actionIndex].id;
    game.call(sb);
    assertPotConservation(game, total);

    const bb = game.players[game.actionIndex].id;
    game.check(bb);
    assertPotConservation(game, total);

    expect(game.phase).toBe('flop');

    // flop: all check
    game.check(game.players[game.actionIndex].id);
    game.check(game.players[game.actionIndex].id);
    game.check(game.players[game.actionIndex].id);
    assertPotConservation(game, total);
  });

  it('All-In 场景底池正确', () => {
    const game = new GameEngine(makePlayers(2, 200), 0, BIG_BLIND);
    const total = 400;
    assertPotConservation(game, total);

    const actor = game.players[game.actionIndex].id;
    game.allIn(actor);
    assertPotConservation(game, total);

    const resp = game.players[game.actionIndex].id;
    game.allIn(resp);
    assertPotConservation(game, total);
  });
});

// ─── All-In 场景 ─────────────────────────────────────────────────────────────

describe('All-In 场景', () => {
  it('双方 all-in 后直接进入摊牌', () => {
    const game = new GameEngine(makePlayers(2, 500), 0, BIG_BLIND);
    const a1 = game.players[game.actionIndex].id;
    game.allIn(a1);
    const a2 = game.players[game.actionIndex].id;
    const result = game.allIn(a2);
    expect(result.showdown).toBe(true);
  });

  it('chips 耗尽的玩家状态为 allin', () => {
    const game = new GameEngine(makePlayers(2, 500), 0, BIG_BLIND);
    const actor = game.players[game.actionIndex];
    game.allIn(actor.id);
    // actor 筹码全压，应为 allin
    expect(actor.chips).toBe(0);
    expect(actor.status).toBe('allin');
  });
});

// ─── 多人折牌 ─────────────────────────────────────────────────────────────────

describe('3人局折牌', () => {
  it('两人折牌后仅剩一人，直接获胜', () => {
    const game = new GameEngine(makePlayers(3), 0, BIG_BLIND);
    // UTG folds
    const utg = game.players[game.actionIndex].id;
    game.fold(utg);
    // SB folds
    const sb = game.players[game.actionIndex].id;
    const result = game.fold(sb);
    expect(result.showdown).toBe(true);
    expect(result.winners).toHaveLength(1);
  });

  it('折牌后底池归赢家，守恒', () => {
    const game = new GameEngine(makePlayers(3), 0, BIG_BLIND);
    const total = 3000;
    const utg = game.players[game.actionIndex].id;
    game.fold(utg);
    const sb = game.players[game.actionIndex].id;
    const result = game.fold(sb);
    assertPotConservation(game, total);
    expect(result.winners[0]).toBeDefined();
  });
});

// ─── 边池（Side Pot）─────────────────────────────────────────────────────────
// 短码全下玩家只能赢主池；主池以外的边池只在没全下/全下更多的玩家之间瓜分，
// 短码玩家不应分到任何边池份额。

describe('边池 — 三人不等额 All-In', () => {
  it('短码赢家只拿主池，边池归另外两人中牌力更强者', () => {
    // A(庄, 1000) / B(小盲, 300, 短码) / C(大盲, 1000)
    const players = [
      { id: 'A', name: 'A', chips: 1000 },
      { id: 'B', name: 'B', chips: 300 },
      { id: 'C', name: 'C', chips: 1000 },
    ];
    const game = new GameEngine(players, 0, BIG_BLIND);
    const total = 2300;

    const byId = id => game.players.find(p => p.id === id);
    // 牌力：B(AA) > A(KK) > C(QQ)，公共牌不成对/不成顺/不成同花，纯比对子
    byId('A').holeCards = ['Kh', 'Kd'];
    byId('B').holeCards = ['Ah', 'Ad'];
    byId('C').holeCards = ['Qh', 'Qd'];
    // 固定发牌顺序：翻牌 2s,7c,9d／转牌 Tc／河牌 3h（pop() 从数组尾部取）
    game.deck = ['3h', 'Tc', '9d', '7c', '2s'];

    expect(game.players[game.actionIndex].id).toBe('A');
    game.allIn('A'); // A 全下 1000（视为加注到1000）
    expect(game.players[game.actionIndex].id).toBe('B');
    game.allIn('B'); // B 全下剩余290（总入池300），不足跟注额，不算加注
    expect(game.players[game.actionIndex].id).toBe('C');
    const result = game.allIn('C'); // C 全下剩余980（总入池1000）→ 三人全下，直接摊牌

    assertPotConservation(game, total);
    expect(result.showdown).toBe(true);
    expect(game.communityCards).toHaveLength(5);

    // 主池 = 300*3 = 900，全归 B（AA 全场最大）
    // 边池 = (1000-300)*2 = 1400，只在 A/C 间瓜分，A(KK) 胜出，C 拿 0
    expect(byId('B').chips).toBe(900);
    expect(byId('A').chips).toBe(1400);
    expect(byId('C').chips).toBe(0);

    const netOf = id => result.settle.find(s => s.id === id).net;
    expect(netOf('B')).toBe(600);   // 赢900 − 投入300
    expect(netOf('A')).toBe(400);   // 赢1400 − 投入1000
    expect(netOf('C')).toBe(-1000); // 赢0 − 投入1000
  });

  it('两人全下、一人过牌未跟注更多：多出的注额原路退还', () => {
    // A(庄,1000)/B(小盲,200,短码)/C(大盲,1000) — C 只跟注到200（不加注），
    // A 全下1000后 B/C 都只需要面对1000的注，B 全下到200(短码封顶)。
    const players = [
      { id: 'A', name: 'A', chips: 1000 },
      { id: 'B', name: 'B', chips: 200 },
      { id: 'C', name: 'C', chips: 1000 },
    ];
    const game = new GameEngine(players, 0, BIG_BLIND);
    const byId = id => game.players.find(p => p.id === id);
    byId('A').holeCards = ['4h', '4d'];
    byId('B').holeCards = ['5h', '5d'];
    byId('C').holeCards = ['6h', '6d']; // C 牌力最强
    game.deck = ['3h', 'Tc', '9d', '7c', '2s']; // 公共牌不连续/不成顺，纯比对子

    game.allIn('A'); // A 全下1000
    game.allIn('B'); // B 短码全下200
    const result = game.allIn('C'); // C 全下1000

    const total = 2200;
    assertPotConservation(game, total);
    // 主池 600 全场最强的 C 拿；边池 (1000-200)*2=1600 也在 A/C 间由 C 拿（C 最强）
    expect(byId('C').chips).toBe(2200);
    expect(byId('A').chips).toBe(0);
    expect(byId('B').chips).toBe(0);
  });

  it('边池分层胜出者若是因为筹码差（而非全场弃牌）唯一有资格，牌型描述必须是真实比牌结果，不能标成"其他人全部弃牌"（回归：真机实测发现两个矛盾的结算原因同时出现在同一手结算里）', () => {
    // A(庄,1000) 全下 / B(小盲,300,短码) 全下 / C(大盲,1000) 弃牌。
    // A/B 两人真正打到摊牌（isFoldWin 应为 false）——但最高那层边池
    // （300~1000 之间那 700）只有 A 一个人筹码够格，不是因为 B 弃牌。
    const players = [
      { id: 'A', name: 'A', chips: 1000 },
      { id: 'B', name: 'B', chips: 300 },
      { id: 'C', name: 'C', chips: 1000 },
    ];
    const game = new GameEngine(players, 0, BIG_BLIND);
    const byId = id => game.players.find(p => p.id === id);
    byId('A').holeCards = ['Kh', 'Kd']; // A 全场最强：一对K
    byId('B').holeCards = ['5h', '5d']; // B：一对5
    byId('C').holeCards = ['2h', '2d']; // C 弃牌，牌力无关紧要
    game.deck = ['3h', 'Tc', '9d', '7c', '2s']; // 不成顺/不成同花，纯比对子

    expect(game.players[game.actionIndex].id).toBe('A');
    game.allIn('A'); // 全下 1000
    game.allIn('B'); // 短码全下 300
    const result = game.fold('C'); // C 弃牌（此前已投入大盲 20）

    expect(result.showdown).toBe(true);
    expect(result.foldWin).toBe(false); // 整手牌层面：A/B 两个真实参与者打到摊牌，不是弃牌获胜

    // A 一对K全场最强，三层边池全部由 A 一人拿下（B 一对5真实比牌落败，
    // 不会出现在 winners 里）——尤其是最高那层，唯一有资格的原因是筹码额度，
    // 不是弃牌，这正是本回归要盯住的那一层。
    const aWinner = result.winners.find(w => w.id === 'A');
    expect(aWinner).toBeDefined();
    expect(aWinner.handName).not.toBe('其他人全部弃牌');
    expect(aWinner.handName).toMatch(/一对|三条|两对/); // 已翻译为中文，pokersolver 原始描述例如 "Pair, K's"
    expect(byId('A').chips).toBe(1320); // 三层边池全部拿下：60+560+700

    assertPotConservation(game, 2300);
  });
});

describe('加注金额上限校验', () => {
  it('加注超过自己筹码时应报错，且不改变任何状态', () => {
    const game = new GameEngine(makePlayers(2, 500), 0, BIG_BLIND);
    const actor = game.players[game.actionIndex];
    const before = {
      chips: actor.chips,
      bet: actor.bet,
      pot: game.pot,
      currentBet: game.currentBet,
      lastRaiseAmount: game.lastRaiseAmount,
    };

    const result = game.raise(actor.id, 999999); // 远超 actor 实际筹码

    expect(result.error).toBeDefined();
    expect(actor.chips).toBe(before.chips);
    expect(actor.bet).toBe(before.bet);
    expect(game.pot).toBe(before.pot);
    expect(game.currentBet).toBe(before.currentBet);
    expect(game.lastRaiseAmount).toBe(before.lastRaiseAmount);
  });

  it('加注到刚好等于自己全部筹码（全下）应该成功', () => {
    const game = new GameEngine(makePlayers(2, 500), 0, BIG_BLIND);
    const actor = game.players[game.actionIndex];
    const maxTotal = actor.chips + actor.bet;

    const result = game.raise(actor.id, maxTotal);

    expect(result.error).toBeUndefined();
    expect(actor.chips).toBe(0);
    expect(actor.status).toBe('allin');
  });
});

describe('对手全下后，剩余唯一可行动玩家不应被重复要求操作', () => {
  it('短码方全下、长码方跟注后仍有余额，应直接自动摊牌，不再弹出行动机会', () => {
    const game = new GameEngine(makePlayers(2, 1000), 0, BIG_BLIND);

    // heads-up 里 dealerIndex=0 时，SB 先手；把 SB 改造成"短码"
    const short = game.players[game.actionIndex];
    short.chips = 100;

    // 盲注已在构造函数里扣过（且已计入 game.pot），直接改写 chips 会让桌面
    // 总筹码偏离 2*1000；用改写后的实际结存重新计算守恒基准，而不是硬编码 2000。
    const total = game.players.reduce((s, p) => s + p.chips, 0) + game.pot;

    const r1 = game.allIn(short.id);
    expect(r1.showdown).toBeFalsy(); // 对手还没决定跟注/弃牌，不该直接结束

    const caller = game.players[game.actionIndex];
    const r2 = game.call(caller.id);

    expect(caller.status).toBe('active'); // 跟注方筹码有富余，跟注后不是 allin
    expect(r2.showdown).toBe(true);       // 应该直接摊牌——不应该再给它发牌后的行动机会
    expect(r2.state.communityCards).toHaveLength(5);
    assertPotConservation(game, total);
  });
});
