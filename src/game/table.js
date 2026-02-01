/**
 * Poker Table - manages game state, betting, and player actions
 */

const { SecureDeck } = require('./deck');
const { evaluateHand, compareHands, getHandName } = require('./evaluator');

const GAME_PHASES = {
  WAITING: 'waiting',
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown'
};

class Player {
  constructor(id, moltbookId, walletAddress, buyIn) {
    this.id = id;
    this.moltbookId = moltbookId;
    this.walletAddress = walletAddress;
    this.chips = buyIn;
    this.holeCards = [];
    this.currentBet = 0;
    this.totalBetThisHand = 0;
    this.folded = false;
    this.allIn = false;
    this.isConnected = true;
    this.lastAction = null;
    this.lastActionTime = null;
  }

  reset() {
    this.holeCards = [];
    this.currentBet = 0;
    this.totalBetThisHand = 0;
    this.folded = false;
    this.allIn = false;
    this.lastAction = null;
  }

  toPublic() {
    return {
      id: this.id,
      moltbookId: this.moltbookId,
      chips: this.chips,
      currentBet: this.currentBet,
      folded: this.folded,
      allIn: this.allIn,
      isConnected: this.isConnected,
      hasCards: this.holeCards.length > 0
    };
  }

  toPrivate() {
    return {
      ...this.toPublic(),
      holeCards: this.holeCards.map(c => c.toJSON())
    };
  }
}

class Table {
  constructor(id, config = {}) {
    this.id = id;
    this.name = config.name || `Table ${id}`;
    this.maxPlayers = config.maxPlayers || 6;
    this.smallBlind = config.smallBlind || 10;
    this.bigBlind = config.bigBlind || 20;
    this.minBuyIn = config.minBuyIn || this.bigBlind * 20;
    this.maxBuyIn = config.maxBuyIn || this.bigBlind * 100;
    this.rake = config.rake || 0.05; // 5% rake
    this.rakeMax = config.rakeMax || 100;
    
    this.players = new Map();
    this.seats = new Array(this.maxPlayers).fill(null);
    this.deck = null;
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.phase = GAME_PHASES.WAITING;
    this.dealerSeat = 0;
    this.currentPlayerSeat = null;
    this.lastRaiserSeat = null;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.handNumber = 0;
    this.deckCommitment = null;
    this.actionTimeout = config.actionTimeout || 30000; // 30 seconds
    this.handHistory = [];
    this.completedHands = []; // Store completed hands for history
  }

  // Add player to table
  addPlayer(moltbookId, walletAddress, buyIn, preferredSeat = null) {
    if (buyIn < this.minBuyIn || buyIn > this.maxBuyIn) {
      throw new Error(`Buy-in must be between ${this.minBuyIn} and ${this.maxBuyIn}`);
    }

    // Find available seat
    let seat = preferredSeat;
    if (seat === null || this.seats[seat] !== null) {
      seat = this.seats.findIndex(s => s === null);
    }
    if (seat === -1) {
      throw new Error('Table is full');
    }

    const playerId = `${moltbookId}-${Date.now()}`;
    const player = new Player(playerId, moltbookId, walletAddress, buyIn);
    this.players.set(playerId, player);
    this.seats[seat] = playerId;

    return { seat, playerId };
  }

  // Remove player from table
  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return null;

    const seat = this.seats.indexOf(playerId);
    if (seat !== -1) {
      this.seats[seat] = null;
    }
    this.players.delete(playerId);

    return player.chips; // Return remaining chips
  }

  // Start new hand
  startHand() {
    const activePlayers = this._getActivePlayers();
    if (activePlayers.length < 2) {
      throw new Error('Need at least 2 players to start');
    }

    this.handNumber++;
    this.deck = new SecureDeck();
    this.deckCommitment = this.deck.getCommitment();
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.phase = GAME_PHASES.PREFLOP;
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.handHistory = [];

    // Reset players
    for (const player of this.players.values()) {
      player.reset();
    }

    // Move dealer button
    this._moveDealer();

    // Post blinds
    this._postBlinds();

    // Deal hole cards
    this._dealHoleCards();

    // Set first player to act
    this._setNextPlayer(this._getBigBlindSeat());

    this._logAction('HAND_START', { handNumber: this.handNumber, commitment: this.deckCommitment });

    return this.getGameState();
  }

  // Player actions
  fold(playerId) {
    this._validateAction(playerId);
    const player = this.players.get(playerId);
    player.folded = true;
    player.lastAction = 'fold';
    this._logAction('FOLD', { playerId });
    return this._advanceGame();
  }

  check(playerId) {
    this._validateAction(playerId);
    const player = this.players.get(playerId);
    if (player.currentBet < this.currentBet) {
      throw new Error('Cannot check, must call or raise');
    }
    player.lastAction = 'check';
    this._logAction('CHECK', { playerId });
    return this._advanceGame();
  }

  call(playerId) {
    this._validateAction(playerId);
    const player = this.players.get(playerId);
    const toCall = this.currentBet - player.currentBet;
    
    if (toCall <= 0) {
      throw new Error('Nothing to call');
    }

    const actualCall = Math.min(toCall, player.chips);
    player.chips -= actualCall;
    player.currentBet += actualCall;
    player.totalBetThisHand += actualCall;
    this.pot += actualCall;

    if (player.chips === 0) {
      player.allIn = true;
    }

    player.lastAction = 'call';
    this._logAction('CALL', { playerId, amount: actualCall });
    return this._advanceGame();
  }

  raise(playerId, amount) {
    this._validateAction(playerId);
    const player = this.players.get(playerId);
    const toCall = this.currentBet - player.currentBet;
    const raiseAmount = amount - toCall;

    if (raiseAmount < this.minRaise && amount < player.chips) {
      throw new Error(`Minimum raise is ${this.minRaise}`);
    }

    if (amount > player.chips) {
      throw new Error('Not enough chips');
    }

    player.chips -= amount;
    player.currentBet += amount;
    player.totalBetThisHand += amount;
    this.pot += amount;
    this.currentBet = player.currentBet;
    this.minRaise = Math.max(this.minRaise, raiseAmount);
    this.lastRaiserSeat = this.seats.indexOf(playerId);

    if (player.chips === 0) {
      player.allIn = true;
    }

    player.lastAction = 'raise';
    this._logAction('RAISE', { playerId, amount, newBet: this.currentBet });
    return this._advanceGame();
  }

  allIn(playerId) {
    return this.raise(playerId, this.players.get(playerId).chips);
  }

  // Get public game state (what everyone can see)
  getGameState() {
    const players = {};
    for (const [id, player] of this.players) {
      players[id] = player.toPublic();
    }

    return {
      tableId: this.id,
      name: this.name,
      phase: this.phase,
      pot: this.pot,
      communityCards: this.communityCards.map(c => c.toJSON()),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      dealerSeat: this.dealerSeat,
      currentPlayerSeat: this.currentPlayerSeat,
      players,
      seats: this.seats,
      handNumber: this.handNumber,
      deckCommitment: this.deckCommitment
    };
  }

  // Get public state for spectators (no private cards unless showdown)
  getPublicState() {
    const players = [];
    for (const [id, player] of this.players) {
      const publicPlayer = {
        id,
        moltbookId: player.moltbookId,
        chips: player.chips,
        currentBet: player.currentBet,
        folded: player.folded,
        allIn: player.allIn,
        hasCards: player.holeCards.length > 0,
        lastAction: player.lastAction
      };

      // Only reveal cards at showdown
      if (this.phase === GAME_PHASES.SHOWDOWN && !player.folded && player.holeCards.length > 0) {
        publicPlayer.holeCards = player.holeCards.map(c => c.toJSON());
      }

      players.push(publicPlayer);
    }

    return {
      tableId: this.id,
      name: this.name,
      phase: this.phase,
      pot: this.pot,
      communityCards: this.communityCards.map(c => c.toJSON()),
      currentBet: this.currentBet,
      dealerSeat: this.dealerSeat,
      currentPlayerSeat: this.currentPlayerSeat,
      players,
      seats: this.seats,
      handNumber: this.handNumber,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind
    };
  }

  // Get private state for specific player
  getPlayerState(playerId) {
    const player = this.players.get(playerId);
    if (!player) return null;

    return {
      ...this.getGameState(),
      myCards: player.holeCards.map(c => c.toJSON()),
      myChips: player.chips
    };
  }

  // Private methods
  _getActivePlayers() {
    return Array.from(this.players.values()).filter(p => p.chips > 0 && p.isConnected);
  }

  _getPlayersInHand() {
    return Array.from(this.players.values()).filter(p => !p.folded && p.holeCards.length > 0);
  }

  _moveDealer() {
    do {
      this.dealerSeat = (this.dealerSeat + 1) % this.maxPlayers;
    } while (this.seats[this.dealerSeat] === null);
  }

  _getSmallBlindSeat() {
    let seat = (this.dealerSeat + 1) % this.maxPlayers;
    while (this.seats[seat] === null) {
      seat = (seat + 1) % this.maxPlayers;
    }
    return seat;
  }

  _getBigBlindSeat() {
    let seat = this._getSmallBlindSeat();
    do {
      seat = (seat + 1) % this.maxPlayers;
    } while (this.seats[seat] === null);
    return seat;
  }

  _postBlinds() {
    const sbSeat = this._getSmallBlindSeat();
    const bbSeat = this._getBigBlindSeat();
    
    const sbPlayer = this.players.get(this.seats[sbSeat]);
    const bbPlayer = this.players.get(this.seats[bbSeat]);

    const sbAmount = Math.min(this.smallBlind, sbPlayer.chips);
    const bbAmount = Math.min(this.bigBlind, bbPlayer.chips);

    sbPlayer.chips -= sbAmount;
    sbPlayer.currentBet = sbAmount;
    sbPlayer.totalBetThisHand = sbAmount;
    this.pot += sbAmount;

    bbPlayer.chips -= bbAmount;
    bbPlayer.currentBet = bbAmount;
    bbPlayer.totalBetThisHand = bbAmount;
    this.pot += bbAmount;

    if (sbPlayer.chips === 0) sbPlayer.allIn = true;
    if (bbPlayer.chips === 0) bbPlayer.allIn = true;

    this._logAction('BLINDS', { sb: sbAmount, bb: bbAmount });
  }

  _dealHoleCards() {
    for (const playerId of this.seats) {
      if (playerId) {
        const player = this.players.get(playerId);
        if (player.chips > 0) {
          player.holeCards = [this.deck.deal(), this.deck.deal()];
        }
      }
    }
  }

  _setNextPlayer(afterSeat) {
    let seat = (afterSeat + 1) % this.maxPlayers;
    let checked = 0;

    while (checked < this.maxPlayers) {
      const playerId = this.seats[seat];
      if (playerId) {
        const player = this.players.get(playerId);
        if (!player.folded && !player.allIn) {
          this.currentPlayerSeat = seat;
          return;
        }
      }
      seat = (seat + 1) % this.maxPlayers;
      checked++;
    }

    this.currentPlayerSeat = null;
  }

  _validateAction(playerId) {
    if (this.phase === GAME_PHASES.WAITING || this.phase === GAME_PHASES.SHOWDOWN) {
      throw new Error('No active hand');
    }
    const seat = this.seats.indexOf(playerId);
    if (seat !== this.currentPlayerSeat) {
      throw new Error('Not your turn');
    }
  }

  _advanceGame() {
    const playersInHand = this._getPlayersInHand();
    
    // Check if only one player left
    if (playersInHand.length === 1) {
      return this._awardPot(playersInHand[0]);
    }

    // Check if betting round is complete
    if (this._isBettingComplete()) {
      return this._advancePhase();
    }

    // Next player
    this._setNextPlayer(this.currentPlayerSeat);
    return this.getGameState();
  }

  _isBettingComplete() {
    const playersInHand = this._getPlayersInHand();
    for (const player of playersInHand) {
      if (!player.allIn && player.currentBet < this.currentBet) {
        return false;
      }
      if (!player.allIn && player.lastAction === null && this.phase === GAME_PHASES.PREFLOP) {
        // Big blind hasn't acted yet
        const bbSeat = this._getBigBlindSeat();
        if (this.seats[bbSeat] === player.id && player.currentBet === this.bigBlind) {
          return false;
        }
      }
    }
    return true;
  }

  _advancePhase() {
    // Reset betting for new round
    for (const player of this.players.values()) {
      player.currentBet = 0;
      player.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    switch (this.phase) {
      case GAME_PHASES.PREFLOP:
        this.phase = GAME_PHASES.FLOP;
        this.communityCards = [this.deck.deal(), this.deck.deal(), this.deck.deal()];
        this._logAction('FLOP', { cards: this.communityCards.map(c => c.toString()) });
        break;
      case GAME_PHASES.FLOP:
        this.phase = GAME_PHASES.TURN;
        this.communityCards.push(this.deck.deal());
        this._logAction('TURN', { card: this.communityCards[3].toString() });
        break;
      case GAME_PHASES.TURN:
        this.phase = GAME_PHASES.RIVER;
        this.communityCards.push(this.deck.deal());
        this._logAction('RIVER', { card: this.communityCards[4].toString() });
        break;
      case GAME_PHASES.RIVER:
        return this._showdown();
    }

    // Set first player after dealer
    this._setNextPlayer(this.dealerSeat);
    
    // If everyone is all-in, run out the board
    const canAct = this._getPlayersInHand().filter(p => !p.allIn);
    if (canAct.length <= 1) {
      return this._advancePhase();
    }

    return this.getGameState();
  }

  _showdown() {
    this.phase = GAME_PHASES.SHOWDOWN;
    const playersInHand = this._getPlayersInHand();
    
    // Evaluate all hands
    const results = playersInHand.map(player => {
      const allCards = [...player.holeCards, ...this.communityCards];
      const hand = evaluateHand(allCards);
      return {
        player,
        hand,
        handName: getHandName(hand.ranking)
      };
    });

    // Sort by hand strength
    results.sort((a, b) => compareHands(b.hand, a.hand));

    // Find winners (handle ties)
    const winners = [results[0]];
    for (let i = 1; i < results.length; i++) {
      if (compareHands(results[i].hand, results[0].hand) === 0) {
        winners.push(results[i]);
      } else {
        break;
      }
    }

    // Award pot
    const rake = Math.min(this.pot * this.rake, this.rakeMax);
    const potAfterRake = this.pot - rake;
    const winAmount = Math.floor(potAfterRake / winners.length);

    for (const winner of winners) {
      winner.player.chips += winAmount;
    }

    const deckReveal = this.deck.revealSalt();

    this._logAction('SHOWDOWN', {
      results: results.map(r => ({
        playerId: r.player.id,
        holeCards: r.player.holeCards.map(c => c.toString()),
        handName: r.handName
      })),
      winners: winners.map(w => w.player.id),
      pot: this.pot,
      rake,
      winAmount,
      deckReveal
    });

    // Save completed hand to history
    this.completedHands.unshift({
      handNumber: this.handNumber,
      timestamp: Date.now(),
      winners: winners.map(w => ({ name: w.player.moltbookId, hand: w.handName })),
      pot: this.pot,
      players: results.map(r => ({
        name: r.player.moltbookId,
        cards: r.player.holeCards.map(c => c.toString()),
        hand: r.handName,
        won: winners.some(w => w.player.id === r.player.id)
      })),
      communityCards: this.communityCards.map(c => c.toString())
    });
    // Keep only last 20 hands
    if (this.completedHands.length > 20) this.completedHands.pop();

    return {
      ...this.getGameState(),
      showdown: {
        results: results.map(r => ({
          playerId: r.player.id,
          holeCards: r.player.holeCards.map(c => c.toJSON()),
          handName: r.handName,
          handRanking: r.hand.ranking
        })),
        winners: winners.map(w => w.player.id),
        pot: this.pot,
        rake,
        winAmount,
        deckReveal
      }
    };
  }

  _awardPot(winner) {
    const rake = Math.min(this.pot * this.rake, this.rakeMax);
    const winAmount = this.pot - rake;
    winner.chips += winAmount;

    this._logAction('WIN_UNCONTESTED', {
      playerId: winner.id,
      pot: this.pot,
      rake,
      winAmount
    });

    // Save completed hand to history (uncontested win)
    this.completedHands.unshift({
      handNumber: this.handNumber,
      timestamp: Date.now(),
      winners: [{ name: winner.moltbookId, hand: 'Uncontested' }],
      pot: this.pot,
      players: [{ name: winner.moltbookId, cards: [], hand: 'Winner', won: true }],
      communityCards: this.communityCards.map(c => c.toString()),
      uncontested: true
    });
    if (this.completedHands.length > 20) this.completedHands.pop();

    this.phase = GAME_PHASES.SHOWDOWN;
    return {
      ...this.getGameState(),
      winner: {
        playerId: winner.id,
        amount: winAmount,
        rake
      }
    };
  }

  _logAction(action, data) {
    this.handHistory.push({
      timestamp: Date.now(),
      action,
      data
    });
  }
}

module.exports = { Table, Player, GAME_PHASES };
