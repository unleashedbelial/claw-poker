/**
 * Simple poker bot for testing
 * Can be used to fill tables or test gameplay
 */

class PokerBot {
  constructor(name, style = 'balanced') {
    this.name = name;
    this.style = style; // 'aggressive', 'passive', 'balanced', 'random'
    this.bluffFrequency = this._getBluffFrequency();
  }

  _getBluffFrequency() {
    switch (this.style) {
      case 'aggressive': return 0.4;
      case 'passive': return 0.1;
      case 'balanced': return 0.25;
      case 'random': return Math.random();
      default: return 0.25;
    }
  }

  /**
   * Decide action based on game state
   * @param {Object} state - Current game state
   * @returns {Object} - { action: string, amount?: number }
   */
  decideAction(state) {
    const { myCards, communityCards, pot, currentBet, myChips, phase } = state;
    const toCall = currentBet - (state.myCurrentBet || 0);
    
    // Calculate hand strength (simplified)
    const handStrength = this._evaluateHandStrength(myCards, communityCards);
    
    // Pot odds
    const potOdds = toCall / (pot + toCall);
    
    // Decision logic
    if (toCall === 0) {
      // Can check
      if (handStrength > 0.7 || (handStrength > 0.4 && Math.random() < this.bluffFrequency)) {
        // Strong hand or bluffing - raise
        const raiseAmount = this._calculateRaise(pot, myChips, handStrength);
        return { action: 'raise', amount: raiseAmount };
      }
      return { action: 'check' };
    }

    // Must call or fold
    if (handStrength > potOdds + 0.1) {
      // Good odds to call
      if (handStrength > 0.8 && myChips > toCall * 3) {
        // Very strong - raise
        const raiseAmount = this._calculateRaise(pot, myChips, handStrength);
        return { action: 'raise', amount: raiseAmount };
      }
      return { action: 'call' };
    }

    // Bluff sometimes
    if (Math.random() < this.bluffFrequency * 0.5) {
      if (Math.random() < 0.3) {
        return { action: 'raise', amount: toCall + Math.floor(pot * 0.5) };
      }
      return { action: 'call' };
    }

    return { action: 'fold' };
  }

  _evaluateHandStrength(holeCards, communityCards) {
    if (!holeCards || holeCards.length < 2) return 0.3;

    // Simplified hand strength based on hole cards
    const card1 = holeCards[0];
    const card2 = holeCards[1];
    
    let strength = 0.2; // Base

    // High cards
    const highRanks = ['A', 'K', 'Q', 'J'];
    if (highRanks.includes(card1.rank)) strength += 0.15;
    if (highRanks.includes(card2.rank)) strength += 0.15;

    // Pocket pair
    if (card1.rank === card2.rank) {
      strength += 0.25;
      if (highRanks.includes(card1.rank)) strength += 0.15;
    }

    // Suited
    if (card1.suit === card2.suit) strength += 0.1;

    // Connected
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const gap = Math.abs(ranks.indexOf(card1.rank) - ranks.indexOf(card2.rank));
    if (gap === 1) strength += 0.1;
    if (gap === 0) strength += 0.05; // Pair bonus already applied

    // Community cards improve hand
    if (communityCards && communityCards.length > 0) {
      for (const cc of communityCards) {
        if (cc.rank === card1.rank || cc.rank === card2.rank) {
          strength += 0.15; // Paired with board
        }
      }
    }

    return Math.min(strength, 1);
  }

  _calculateRaise(pot, chips, strength) {
    const minRaise = Math.floor(pot * 0.5);
    const maxRaise = Math.min(chips, pot * 2);
    
    if (strength > 0.9) {
      // Monster hand - big raise or all-in
      return Math.floor(maxRaise * 0.8);
    }
    
    // Standard raise based on strength
    const raiseSize = minRaise + (maxRaise - minRaise) * strength;
    return Math.floor(raiseSize);
  }
}

module.exports = { PokerBot };
