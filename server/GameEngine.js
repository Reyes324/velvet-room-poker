const { Hand } = require('pokersolver');

const SUITS = ['s', 'h', 'd', 'c']; // spades hearts diamonds clubs
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

// pokersolver only speaks English (its `descr` strings are hardcoded in the
// library) — translate at the source, right where we read `.descr`, so
// every consumer downstream (settlement modal, fixtures, future features)
// always sees Chinese and never has to duplicate this parsing.
const HAND_NAME_ZH = {
  'Straight Flush': '同花顺',
  'Four of a Kind': '四条',
  'Full House': '葫芦',
  'Flush': '同花',
  'Straight': '顺子',
  'Three of a Kind': '三条',
  'Two Pair': '两对',
  'Pair': '一对',
};

function zhRank(token) {
  // Flush/Straight Flush high-card tokens keep the trailing suit letter
  // (pokersolver's own `descr` template does this, e.g. "As High") — strip
  // it before translating the rank itself.
  const r = token.length > 1 && SUITS.includes(token.slice(-1).toLowerCase())
    ? token.slice(0, -1)
    : token;
  return r === 'T' ? '10' : r;
}

function translateHandDescr(descr) {
  if (!descr) return descr;
  if (descr === 'Royal Flush') return '皇家同花顺';

  let m = descr.match(/^Full House, (\w+)'s over (\w+)'s$/);
  if (m) return `葫芦，${zhRank(m[1])} 带 ${zhRank(m[2])}`;

  m = descr.match(/^Two Pair, (\w+)'s & (\w+)'s$/);
  if (m) return `两对，对${zhRank(m[1])}和对${zhRank(m[2])}`;

  m = descr.match(/^(.+), (\w+)'s$/);
  if (m && HAND_NAME_ZH[m[1]]) return `${HAND_NAME_ZH[m[1]]} ${zhRank(m[2])}`;

  m = descr.match(/^(.+), (\w+) High$/);
  if (m && HAND_NAME_ZH[m[1]]) return `${HAND_NAME_ZH[m[1]]}，${zhRank(m[2])} 高`;

  m = descr.match(/^(\w+) High$/);
  if (m) return `高牌 ${zhRank(m[1])}`;

  return descr; // unrecognized format (e.g. wild-card variants we don't use) — pass through rather than break
}

// Bare category name only ("葫芦", "两对", "一对") — no kicker/rank detail —
// for the large on-table banner, as opposed to translateHandDescr's full
// description ("葫芦，Q 带 8") which stays reserved for the settlement sheet.
function translateHandDescrShort(descr) {
  if (!descr) return descr;
  if (descr === 'Royal Flush') return '皇家同花顺';
  const commaIdx = descr.indexOf(',');
  if (commaIdx === -1) return '高牌'; // no category prefix at all (e.g. "Ace High") means High Card
  const category = descr.slice(0, commaIdx);
  return HAND_NAME_ZH[category] || category;
}

// pokersolver notation: 'As', 'Kh', 'Td', '2c'
function makeDeck() {
  const deck = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push(rank + suit);
    }
  }
  return deck;
}

function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// Convert internal card notation to display { rank, suit, color }
function parseCard(card) {
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const suitMap = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const displayRank = rank === 'T' ? '10' : rank;
  return {
    rank: displayRank,
    suit: suitMap[suit],
    color: (suit === 'h' || suit === 'd') ? 'red' : 'black',
    raw: card,
  };
}

const PHASES = ['waiting', 'preflop', 'flop', 'turn', 'river', 'showdown'];

class GameEngine {
  constructor(players, dealerIndex = 0, bigBlind = 200) {
    this.bigBlind = bigBlind;
    this.smallBlind = bigBlind / 2;
    this.deck = shuffle(makeDeck());
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = []; // [{ amount, eligibleIds }]
    this.phase = 'preflop';
    this.currentBet = 0;
    this.lastRaiseAmount = bigBlind;

    // Clone players, assign seat order
    this.players = players.map((p, i) => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      holeCards: [],
      bet: 0,          // bet this street
      totalBet: 0,     // total committed this hand
      status: 'active', // active | folded | allin
      isDealer: i === dealerIndex,
      isSB: false,
      isBB: false,
    }));

    this.dealerIndex = dealerIndex;
    this._assignBlinds();
    this._dealHoleCards();
    // Action starts left of BB in a ring game (3+ players) — but heads-up
    // (2 players) is the special case where the dealer/SB acts first
    // preflop instead (see _assignBlinds for why n===2 needs its own branch).
    this.actionIndex = this._nextActive(
      this.players.length === 2 ? this.dealerIndex : (this.dealerIndex + 3) % this.players.length
    );
    this.lastAggressorIndex = this.actionIndex;
    this.actedThisStreet = new Set();
    // 谁刚做了动作、这是第几次动作——跟 actionIndex 是两件独立的事。
    // actionIndex 只在"还需要有人接着行动"时才会推进（_advance()/_nextStreet()
    // 里都是这样写的），一手牌里最后一个导致直接结束的动作（弃牌到只剩一人、
    // 或河牌圈跟注完直接摊牌）不会再推进 actionIndex——那一刻已经没有"下一个
    // 该谁"这件事了。用户反馈（2026-07-28）：客户端原来完全靠"actionPlayerId
    // 变了"去判断"刚才是谁行动了"，这两种收尾动作因为 actionIndex 压根没变，
    // 从未被判断出来过，导致最后一家跟注/弃牌收尾时那个动作气泡从来没显示
    // 过。这两个字段就是给客户端一个不依赖 actionIndex 语义的、明确的"谁刚
    // 行动了"信号，每次真正执行一个合法动作（fold/check/call/raise/allIn）
    // 都会更新，不管这手牌是否因此结束。
    this.lastActionSeq = 0;
    this.lastActionBy = null;
    this.lastActionLabel = null;
    this.lastActionPhase = null;
    // Set in _endHand — getStateForPlayer needs this to tell a genuine
    // multi-way showdown apart from a fold-out, see that method's comment.
    this.lastHandFoldWin = false;
  }

  // 在每个动作方法真正生效（校验通过之后）时调用，而不是在方法一开始——避
  // 免一次被拒绝的非法操作（比如"还没轮到你"）也被误记成一次真实动作。
  // label 由调用方在自己重置任何状态（比如 raise 清空 actedThisStreet、
  // _nextStreet 把所有人的 bet 清零）之前算好传进来——客户端气泡文案原来
  // 是靠对比前后两次 getPublicState 的 bet/status 字段"猜"出玩家做了什么，
  // 但一条街最后一个动作往往紧接着就会触发 _nextStreet 把 bet 清零，猜出
  // 来的文案要么是错的（比如全都变成"过牌"）要么干脆没有，所以改成服务端
  // 直接算好、原样告诉客户端，不再让客户端反推。
  // lastActionPhase 顺手记一下这个动作真正发生在哪条街——调用方（下面的
  // fold/check/call/raise/allIn）总是先 _recordAction 再调 _advance()，而
  // 一条街最后一个动作会在同一次 _advance() 里触发 _nextStreet()，把
  // this.phase 直接改成下一条街；如果客户端拿广播里的 this.phase 给这个
  // 气泡打标签，"结束这条街的最后一个动作"永远会被误标成下一条街（用户
  // 反馈 2026-08-02："新的一轮的时候，上一轮的气泡不应该还存在吧"——根因
  // 就是这个动作的气泡被误标成新的一轮，导致气泡清理的"标签不等于目标街"
  // 判断把它当成新一轮自己的气泡，一直留到新一轮结束才清）。这里在
  // this.phase 还没被 _nextStreet() 改动之前就把它存下来，让客户端不用
  // 再猜。
  _recordAction(playerId, label) {
    this.lastActionSeq += 1;
    this.lastActionBy = playerId;
    this.lastActionLabel = label;
    this.lastActionPhase = this.phase;
  }

  _seat(i) {
    return this.players[i % this.players.length];
  }

  _nextActive(from) {
    let i = from % this.players.length;
    for (let tries = 0; tries < this.players.length; tries++) {
      if (this.players[i].status === 'active') return i;
      i = (i + 1) % this.players.length;
    }
    return -1;
  }

  _activePlayers() {
    return this.players.filter(p => p.status === 'active');
  }

  _assignBlinds() {
    const n = this.players.length;
    // Heads-up (n===2) follows a different rule than a ring game: the
    // dealer/button posts the SMALL blind (and acts first preflop) —
    // the ring-game formula below (dealer+1=SB, dealer+2=BB) degenerates
    // incorrectly for n===2, since dealer+2 wraps back to the dealer
    // himself and hands him the BIG blind instead.
    const sbIdx = n === 2 ? this.dealerIndex : (this.dealerIndex + 1) % n;
    const bbIdx = n === 2 ? (this.dealerIndex + 1) % n : (this.dealerIndex + 2) % n;
    this.players[sbIdx].isSB = true;
    this.players[bbIdx].isBB = true;
    this._placeBet(sbIdx, this.smallBlind);
    this._placeBet(bbIdx, this.bigBlind);
    this.currentBet = this.bigBlind;
    this.lastRaiseAmount = this.bigBlind;
  }

  _dealHoleCards() {
    for (const p of this.players) {
      p.holeCards = [this.deck.pop(), this.deck.pop()];
    }
  }

  _placeBet(playerIndex, amount) {
    const p = this.players[playerIndex];
    const actual = Math.min(amount, p.chips);
    p.chips -= actual;
    p.bet += actual;
    p.totalBet += actual;
    this.pot += actual;
    if (p.chips === 0) p.status = 'allin';
    return actual;
  }

  // Public — the actual most a player could usefully put in this street
  // (own stack, capped by the deepest live opponent's own ceiling). raise/
  // allIn use this internally; PveSession's AI decision sizing also needs
  // it (its own maxTotal math has to agree with what the engine will
  // actually accept, or its "raiseTo" gets rejected — see design.md).
  maxTotalFor(playerId) {
    const idx = this._playerIndex(playerId);
    if (idx === -1) return 0;
    const p = this.players[idx];
    return Math.min(p.chips + p.bet, this._liveOpponentCeiling(playerId));
  }

  // Public action API
  fold(playerId) {
    const idx = this._playerIndex(playerId);
    if (idx !== this.actionIndex) return { error: '还没轮到你' };
    this.players[idx].status = 'folded';
    this.actedThisStreet.add(playerId);
    this._recordAction(playerId, { type: 'fold' });
    return this._advance();
  }

  check(playerId) {
    const idx = this._playerIndex(playerId);
    if (idx !== this.actionIndex) return { error: '还没轮到你' };
    const p = this.players[idx];
    if (p.bet < this.currentBet) return { error: '当前有注可以跟注，不能过牌' };
    this.actedThisStreet.add(playerId);
    this._recordAction(playerId, { type: 'check' });
    return this._advance();
  }

  call(playerId) {
    const idx = this._playerIndex(playerId);
    if (idx !== this.actionIndex) return { error: '还没轮到你' };
    const p = this.players[idx];
    const toCall = this.currentBet - p.bet;
    this._placeBet(idx, toCall);
    this.actedThisStreet.add(playerId);
    const label = p.status === 'allin' ? { type: 'allin', amount: p.bet } : { type: 'call', amount: toCall };
    this._recordAction(playerId, label);
    return this._advance();
  }

  // 场上还没弃牌的其他玩家里，身家最长的那个人这条街最多能跟到多少（他自
  // 己的剩余筹码 + 已经投入这条街的部分，跟 raise/allIn 自己算 maxTotal
  // 用的是同一个公式）——用户反馈（2026-07-28）：推超过所有对手身家的部
  // 分，本来就只能靠边池机制原路退还（见 _endHand 的"纯退还"判定），允许
  // 选到那个数字只会制造"怎么显示的是我全部身家"的困惑。没有对手在场（不
  // 该在真实一手牌里发生，纯兜底）时不设上限。
  _liveOpponentCeiling(playerId) {
    const others = this.players.filter(p => p.id !== playerId && p.status !== 'folded');
    return others.length > 0 ? Math.max(...others.map(p => p.chips + p.bet)) : Infinity;
  }

  raise(playerId, totalAmount) {
    const idx = this._playerIndex(playerId);
    if (idx !== this.actionIndex) return { error: '还没轮到你' };
    const p = this.players[idx];
    const maxTotal = this.maxTotalFor(playerId);
    if (totalAmount > maxTotal) {
      return { error: `最多下注 ¥${maxTotal}` };
    }
    const minRaise = this.currentBet + this.lastRaiseAmount;
    if (totalAmount < minRaise && totalAmount < maxTotal) {
      return { error: `最小加注至 ¥${minRaise}` };
    }
    const raiseAmount = totalAmount - this.currentBet;
    this.lastRaiseAmount = raiseAmount;
    const additional = totalAmount - p.bet;
    this._placeBet(idx, additional);
    this.currentBet = p.bet; // after bet placed
    this.lastAggressorIndex = idx;
    this.actedThisStreet = new Set([playerId]); // everyone else must act again
    const label = p.status === 'allin' ? { type: 'allin', amount: totalAmount } : { type: 'raise', amount: totalAmount };
    this._recordAction(playerId, label);
    return this._advance();
  }

  allIn(playerId) {
    const idx = this._playerIndex(playerId);
    if (idx !== this.actionIndex) return { error: '还没轮到你' };
    const p = this.players[idx];
    // Capped the same way raise() caps its own maxTotal — a player whose
    // real stack would raise, but whose capped ceiling no longer clears
    // the current bet (only possible when every other live opponent is
    // already tapped out at or below the current bet), effectively
    // downgrades to a capped call instead of erroring out or silently
    // pushing more than anyone could ever match.
    const cappedTotal = this.maxTotalFor(playerId);
    if (cappedTotal > this.currentBet) {
      return this.raise(playerId, cappedTotal); // raise() 自己会记 _recordAction，这里不用重复记
    }
    this._placeBet(idx, Math.min(p.chips, cappedTotal - p.bet));
    this.actedThisStreet.add(playerId);
    this._recordAction(playerId, { type: 'allin', amount: p.bet });
    return this._advance();
  }

  _playerIndex(id) {
    return this.players.findIndex(p => p.id === id);
  }

  _streetDone() {
    const active = this._activePlayers();
    if (active.length === 0) return true;
    // All active players have acted AND all bets are equal
    for (const p of active) {
      if (!this.actedThisStreet.has(p.id)) return false;
      if (p.bet < this.currentBet) return false;
    }
    return true;
  }

  _advance() {
    // Check if only one player left
    const notFolded = this.players.filter(p => p.status !== 'folded');
    if (notFolded.length === 1) {
      return this._endHand(notFolded);
    }

    // Check if street is done
    if (this._streetDone()) {
      return this._nextStreet();
    }

    // Move to next active player
    const next = this._nextActive((this.actionIndex + 1) % this.players.length);
    this.actionIndex = next;
    return { state: this.getPublicState() };
  }

  _nextStreet() {
    // Collect bets into pot (already done in _placeBet), reset street bets
    for (const p of this.players) p.bet = 0;
    this.currentBet = 0;
    this.lastRaiseAmount = this.bigBlind; // reset to big blind for new street
    this.actedThisStreet = new Set();

    const phaseOrder = ['preflop', 'flop', 'turn', 'river', 'showdown'];
    const nextPhase = phaseOrder[phaseOrder.indexOf(this.phase) + 1];

    if (!nextPhase) return this._endHand(this.players.filter(p => p.status !== 'folded'));

    this.phase = nextPhase;

    if (nextPhase === 'flop') {
      this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    } else if (nextPhase === 'turn' || nextPhase === 'river') {
      this.communityCards.push(this.deck.pop());
    } else if (nextPhase === 'showdown') {
      return this._endHand(this.players.filter(p => p.status !== 'folded'));
    }

    // Action starts left of dealer among active players
    this.actionIndex = this._nextActive((this.dealerIndex + 1) % this.players.length);

    // If at most one player can still act (everyone else is folded or
    // all-in), there's no one left to bet against — no more meaningful
    // action is possible. Run the board out automatically instead of
    // prompting the lone remaining player for a pointless check/bet.
    // (Zero active players is the actionIndex===-1 case; it's a subset of
    // this condition, not a separate one — no need to check it twice.)
    if (this._activePlayers().length <= 1) {
      return this._nextStreet();
    }

    return { state: this.getPublicState() };
  }

  _endHand(contenders) {
    this.phase = 'showdown';
    const potWon = this.pot;
    const pots = this._buildSidePots();
    const won = {};
    const winnersById = new Map();
    // A property of the whole hand, not of any individual side-pot layer —
    // see _determineWinners for why that distinction matters.
    const isFoldWin = contenders.length === 1;
    this.lastHandFoldWin = isFoldWin; // getStateForPlayer reads this below

    for (const layer of pots) {
      const eligible = this.players.filter(p => layer.eligibleIds.includes(p.id));
      const layerWinners = this._determineWinners(eligible, isFoldWin);
      const share = Math.floor(layer.amount / layerWinners.length);
      // A layer with exactly one eligible player, reached at a REAL
      // showdown (not an outright fold-win), is uncalled money — by
      // construction, eligibility for a layer requires totalBet >= that
      // layer's level, so "only one player eligible" here means no one
      // else in the whole hand ever had enough chips to reach it, not
      // that they folded away from it. User feedback (2026-07-28, real
      // playtest): showing this as a second "won this hand" card next to
      // the actual contested-pot winner reads as two different people/
      // hands both winning, when one of them is really just getting their
      // own excess bet refunded. It still gets added to chips/won below
      // (the money itself was always correct — see settle[].net), just
      // excluded from the public-facing winners list.
      const isUncalledReturn = eligible.length === 1 && !isFoldWin;
      layerWinners.forEach((w, i) => {
        const amt = share + (i === 0 ? layer.amount - share * layerWinners.length : 0);
        w.chips += amt;
        won[w.id] = (won[w.id] || 0) + amt;
        if (!isUncalledReturn) winnersById.set(w.id, w);
      });
    }

    this.pot = 0;
    this.sidePots = pots;
    const winners = [...winnersById.values()];

    return {
      state: this.getPublicState(),
      showdown: true,
      // Client needs this to tell "everyone else folded, no real showdown to
      // look at" apart from an actual multi-way card comparison — they call
      // for very different presentations (a quick banner vs. giving players
      // a beat to see the revealed hands before covering the table).
      foldWin: isFoldWin,
      pot: potWon,
      winners: winners.map(w => ({
        id: w.id,
        name: w.name,
        handName: w.handName,
        // Short category label ("葫芦") for the on-table banner and the 5
        // cards (own hole cards + community) that make up that best hand,
        // for highlighting — both absent on a fold-win, where there's no
        // real hand comparison to show.
        handNameShort: w.handNameShort || null,
        bestCards: (w.bestCards || []).map(parseCard),
        won: won[w.id] || 0,
        holeCards: w.holeCards.map(parseCard),
      })),
      // per-player net for the settlement modal: won (gross) − committed this hand
      settle: this.players.map(p => ({
        id: p.id,
        name: p.name,
        status: p.status,
        net: (won[p.id] || 0) - p.totalBet,
      })),
      // For hand-history logging only — deliberately NOT everyone's cards.
      // A fold-win winner never had to prove their hand, so nothing goes in
      // here until (if ever) they opt into 亮牌炫耀 later; a real showdown's
      // `contenders` (everyone who didn't fold) already had their cards
      // shown to the whole table live (see getStateForPlayer), so recording
      // them in history isn't a new leak, just a durable copy of what was
      // already public.
      showdownReveal: isFoldWin ? [] : contenders.map(p => ({
        id: p.id,
        name: p.name,
        holeCards: p.holeCards.map(parseCard),
      })),
      // Private per-player snapshot for hand-history — NOT for broadcast.
      // A player can always see their own hole cards for a hand they were
      // dealt into, win or lose, showdown or fold, same as the live table's
      // own rule (getStateForPlayer: viewer's own cards are always visible
      // regardless of status). showdownReveal above is the PUBLIC layer
      // (what everyone at the table gets to see); this is the private layer
      // the server uses to answer "what were MY cards" for whoever asks.
      allHoleCards: this.players.map(p => ({ id: p.id, holeCards: p.holeCards.map(parseCard) })),
    };
  }

  // `contenders` here is one side-pot layer's eligible players, which can
  // land on exactly one name for two completely different reasons: either
  // this is a real single-winner fold-out (isFoldWin — every layer has
  // exactly one eligible player, because everyone else is folded), or it's
  // an all-in/side-pot layer where the other non-folded contenders simply
  // didn't commit enough chips to be eligible for *this* layer — a normal,
  // frequent outcome of unequal all-in stack sizes, not a fold. Confirmed
  // as a real bug from a live 3+ player game: a side-pot winner who reached
  // a genuine showdown was mislabeled "其他人全部弃牌" ("everyone else
  // folded") right next to another winner's real hand description in the
  // very same settlement, reading as two contradictory outcomes for one
  // hand. Only the true fold-out case gets that label; an uncontested side
  // pot at a real showdown still gets the winner's actual hand.
  _determineWinners(contenders, isFoldWin) {
    if (contenders.length === 1) {
      const w = contenders[0];
      if (isFoldWin) {
        w.handName = w.handName || '其他人全部弃牌';
      } else if (!w.handName) {
        const solved = Hand.solve([...w.holeCards, ...this.communityCards]);
        w.handName = translateHandDescr(solved.descr);
        w.handNameShort = translateHandDescrShort(solved.descr);
        w.bestCards = solved.cards.map(c => c.value + c.suit);
      }
      return contenders;
    }
    const hands = contenders.map(p => ({
      player: p,
      hand: Hand.solve([...p.holeCards, ...this.communityCards]),
    }));
    const winningHands = Hand.winners(hands.map(h => h.hand));
    return hands
      .filter(h => winningHands.includes(h.hand))
      .map(h => {
        h.player.handName = translateHandDescr(h.hand.descr);
        h.player.handNameShort = translateHandDescrShort(h.hand.descr);
        h.player.bestCards = h.hand.cards.map(c => c.value + c.suit);
        return h.player;
      });
  }

  // Splits the pot into layers ("side pots") based on each player's total
  // commitment this hand. A player can only win layers up to their own
  // totalBet — money above that belongs to a layer they're not eligible for.
  _buildSidePots() {
    const contributors = this.players.filter(p => p.totalBet > 0);
    const levels = [...new Set(contributors.map(p => p.totalBet))].sort((a, b) => a - b);
    let prevLevel = 0;
    const pots = [];
    for (const level of levels) {
      const layerSize = level - prevLevel;
      let amount = 0;
      for (const p of contributors) {
        amount += Math.min(Math.max(p.totalBet - prevLevel, 0), layerSize);
      }
      const eligibleIds = this.players
        .filter(p => p.status !== 'folded' && p.totalBet >= level)
        .map(p => p.id);
      if (amount > 0) pots.push({ amount, eligibleIds });
      prevLevel = level;
    }
    return pots;
  }

  // Returns state safe to send to a specific player (hides others' cards).
  // A viewer who already folded this hand does NOT get the reveal when the
  // hand ends as a fold-win (everyone else folded, no real comparison ever
  // happened) — confirmed as unwanted behavior from real-device feedback
  // ("我弃牌之后还能看到对方摊牌，这不合理"): once you're out of the hand,
  // you shouldn't get to see a winner's cards they never had to show.
  //
  // But a GENUINE multi-way showdown (2+ live players actually comparing
  // hands) is public table information — every real poker table shows
  // those cards face-up to everyone, folded or not. Both land in
  // `this.phase === 'showdown'`, so `lastHandFoldWin` (set in _endHand) is
  // what actually distinguishes them; phase alone can't (user feedback,
  // 2026-08-02: folded mid-hand in a multi-way PVE table, the other AI
  // seats played out to a real showdown, and the reveal was wrongly hidden
  // — this masking used to apply to every showdown regardless of which
  // kind it was). This only affects OTHER players' cards; a viewer always
  // sees their own regardless of status.
  getStateForPlayer(playerId) {
    const pub = this.getPublicState();
    const viewer = this.players.find(x => x.id === playerId);
    const viewerFolded = viewer?.status === 'folded';
    const hideFromFoldedViewer = viewerFolded && this.lastHandFoldWin;
    pub.players = pub.players.map(p => {
      if (p.id === playerId || (this.phase === 'showdown' && !hideFromFoldedViewer)) {
        return { ...p, holeCards: this.players.find(x => x.id === p.id).holeCards.map(parseCard) };
      }
      return { ...p, holeCards: p.status === 'folded' ? [] : [null, null] };
    });
    return pub;
  }

  getPublicState() {
    return {
      phase: this.phase,
      bigBlind: this.bigBlind,
      pot: this.pot,
      currentBet: this.currentBet,
      communityCards: this.communityCards.map(parseCard),
      actionPlayerId: this.players[this.actionIndex]?.id ?? null,
      lastActionSeq: this.lastActionSeq,
      lastActionBy: this.lastActionBy,
      lastActionLabel: this.lastActionLabel,
      lastActionPhase: this.lastActionPhase,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        status: p.status,
        isDealer: p.isDealer,
        isSB: p.isSB,
        isBB: p.isBB,
        holeCards: [], // overridden in getStateForPlayer
      })),
    };
  }
}

module.exports = { GameEngine, parseCard, makeDeck, RANKS, SUITS };
