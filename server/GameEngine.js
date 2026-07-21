const { Hand } = require('pokersolver');

const SUITS = ['s', 'h', 'd', 'c']; // spades hearts diamonds clubs
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

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

  // Public action API
  fold(playerId) {
    const idx = this._playerIndex(playerId);
    if (idx !== this.actionIndex) return { error: '还没轮到你' };
    this.players[idx].status = 'folded';
    this.actedThisStreet.add(playerId);
    return this._advance();
  }

  check(playerId) {
    const idx = this._playerIndex(playerId);
    if (idx !== this.actionIndex) return { error: '还没轮到你' };
    const p = this.players[idx];
    if (p.bet < this.currentBet) return { error: '当前有注可以跟注，不能过牌' };
    this.actedThisStreet.add(playerId);
    return this._advance();
  }

  call(playerId) {
    const idx = this._playerIndex(playerId);
    if (idx !== this.actionIndex) return { error: '还没轮到你' };
    const p = this.players[idx];
    const toCall = this.currentBet - p.bet;
    this._placeBet(idx, toCall);
    this.actedThisStreet.add(playerId);
    return this._advance();
  }

  raise(playerId, totalAmount) {
    const idx = this._playerIndex(playerId);
    if (idx !== this.actionIndex) return { error: '还没轮到你' };
    const p = this.players[idx];
    const maxTotal = p.chips + p.bet;
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
    return this._advance();
  }

  allIn(playerId) {
    const idx = this._playerIndex(playerId);
    if (idx !== this.actionIndex) return { error: '还没轮到你' };
    const p = this.players[idx];
    const totalBet = p.bet + p.chips;
    if (totalBet > this.currentBet) {
      // treat as raise
      return this.raise(playerId, totalBet);
    } else {
      this._placeBet(idx, p.chips);
      this.actedThisStreet.add(playerId);
      return this._advance();
    }
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

    for (const layer of pots) {
      const eligible = this.players.filter(p => layer.eligibleIds.includes(p.id));
      const layerWinners = this._determineWinners(eligible);
      const share = Math.floor(layer.amount / layerWinners.length);
      layerWinners.forEach((w, i) => {
        const amt = share + (i === 0 ? layer.amount - share * layerWinners.length : 0);
        w.chips += amt;
        won[w.id] = (won[w.id] || 0) + amt;
        winnersById.set(w.id, w);
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
      foldWin: contenders.length === 1,
      pot: potWon,
      winners: winners.map(w => ({
        id: w.id,
        name: w.name,
        handName: w.handName,
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
    };
  }

  _determineWinners(contenders) {
    if (contenders.length === 1) {
      // Not "对手全部弃牌" ("the opponent(s) folded") — that phrasing is
      // relative to whoever's reading it, so it reads differently (and
      // ambiguously) for the winner, the folder, and any other player at
      // the table (confirmed by user feedback on a real render). Anchored
      // to the winner instead ("everyone else folded"), which the client
      // always displays right next to the winner's own name — unambiguous
      // regardless of who's looking at it.
      contenders[0].handName = contenders[0].handName || '其他人全部弃牌';
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
        h.player.handName = h.hand.descr;
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

  // Returns state safe to send to a specific player (hides others' cards)
  getStateForPlayer(playerId) {
    const pub = this.getPublicState();
    pub.players = pub.players.map(p => {
      if (p.id === playerId || this.phase === 'showdown') {
        return { ...p, holeCards: this.players.find(x => x.id === p.id).holeCards.map(parseCard) };
      }
      return { ...p, holeCards: p.status === 'folded' ? [] : [null, null] };
    });
    return pub;
  }

  getPublicState() {
    return {
      phase: this.phase,
      pot: this.pot,
      currentBet: this.currentBet,
      communityCards: this.communityCards.map(parseCard),
      actionPlayerId: this.players[this.actionIndex]?.id ?? null,
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

module.exports = { GameEngine, parseCard };
