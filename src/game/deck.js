/**
 * Deck and card management with cryptographic security
 * Uses commitment scheme to prevent cheating
 */

const crypto = require('crypto');

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

class Card {
  constructor(rank, suit) {
    this.rank = rank;
    this.suit = suit;
    this.value = RANKS.indexOf(rank);
  }

  toString() {
    return `${this.rank}${this.suit}`;
  }

  toJSON() {
    return { rank: this.rank, suit: this.suit };
  }
}

class SecureDeck {
  constructor() {
    this.cards = [];
    this.salt = crypto.randomBytes(32).toString('hex');
    this.commitment = null;
    this.revealed = false;
    this._buildDeck();
    this._shuffle();
    this._generateCommitment();
  }

  _buildDeck() {
    this.cards = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        this.cards.push(new Card(rank, suit));
      }
    }
  }

  _shuffle() {
    // Fisher-Yates with crypto-secure randomness
    for (let i = this.cards.length - 1; i > 0; i--) {
      const randomBytes = crypto.randomBytes(4);
      const j = randomBytes.readUInt32BE(0) % (i + 1);
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  _generateCommitment() {
    // Create a cryptographic commitment to the deck order
    // This proves the deck wasn't modified after dealing started
    const deckString = this.cards.map(c => c.toString()).join(',');
    this.commitment = crypto
      .createHash('sha256')
      .update(deckString + this.salt)
      .digest('hex');
  }

  getCommitment() {
    return this.commitment;
  }

  deal() {
    if (this.cards.length === 0) {
      throw new Error('Deck is empty');
    }
    return this.cards.pop();
  }

  // Reveal salt at end of hand so players can verify deck was fair
  revealSalt() {
    this.revealed = true;
    return {
      salt: this.salt,
      commitment: this.commitment,
      remainingCards: this.cards.map(c => c.toString())
    };
  }

  cardsRemaining() {
    return this.cards.length;
  }
}

module.exports = { Card, SecureDeck, SUITS, RANKS };
