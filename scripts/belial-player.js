#!/usr/bin/env node
/**
 * Belial's Poker Bot
 * Plays poker on Claw Poker with a balanced strategy
 */

const { io } = require('socket.io-client');

const POKER_URL = 'http://localhost:3001';
const MOLTBOOK_ID = 'Belial';
const TABLE_ID = 'low-1';  // Low stakes to start
const BUY_IN = 500;  // Middle of the range

// Strategy parameters
const STRATEGY = {
  vpipRange: 0.25,  // Play 25% of hands
  pfrRange: 0.15,   // Raise with 15% of hands
  aggressionFactor: 0.6,  // More aggressive than passive
  bluffFrequency: 0.1     // Bluff 10% of the time
};

// Hand strength categories
const PREMIUM_HANDS = ['AA', 'KK', 'QQ', 'JJ', 'AKs', 'AKo'];
const STRONG_HANDS = ['TT', '99', 'AQs', 'AQo', 'AJs', 'KQs'];
const PLAYABLE_HANDS = ['88', '77', '66', 'ATs', 'AJo', 'KJs', 'QJs', 'JTs'];

function getHandCategory(cards) {
  if (!cards || cards.length < 2) return 'unknown';
  
  const ranks = cards.map(c => c.slice(0, -1));
  const suits = cards.map(c => c.slice(-1));
  const suited = suits[0] === suits[1];
  
  const rankOrder = '23456789TJQKA';
  const sortedRanks = ranks.sort((a, b) => rankOrder.indexOf(b) - rankOrder.indexOf(a));
  const handStr = sortedRanks.join('') + (suited ? 's' : 'o');
  
  // Check for pairs
  if (ranks[0] === ranks[1]) {
    return `${ranks[0]}${ranks[0]}`;
  }
  
  return handStr;
}

function evaluatePreflop(cards) {
  const hand = getHandCategory(cards);
  
  if (PREMIUM_HANDS.some(h => hand.includes(h.replace('s', '').replace('o', '')))) {
    return 'premium';
  }
  if (STRONG_HANDS.some(h => hand.includes(h.replace('s', '').replace('o', '')))) {
    return 'strong';
  }
  if (PLAYABLE_HANDS.some(h => hand.includes(h.replace('s', '').replace('o', '')))) {
    return 'playable';
  }
  return 'weak';
}

function decideAction(gameState, myState) {
  const { phase, currentBet, pot, communityCards } = gameState;
  const { chips, currentBet: myBet, holeCards } = myState;
  const toCall = (currentBet || 0) - (myBet || 0);
  
  // If we don't have cards, fold
  if (!holeCards || holeCards.length < 2) {
    return { action: 'fold' };
  }
  
  // Preflop strategy
  if (phase === 'preflop') {
    const strength = evaluatePreflop(holeCards);
    
    switch (strength) {
      case 'premium':
        // Always raise with premium hands
        if (currentBet === 0 || toCall < chips * 0.3) {
          return { action: 'raise', amount: Math.min(currentBet * 3 + 10, chips) };
        }
        return { action: 'call' };
        
      case 'strong':
        // Raise or call
        if (currentBet < chips * 0.15) {
          return { action: 'raise', amount: Math.min(currentBet * 2.5 + 10, chips) };
        }
        if (toCall < chips * 0.2) {
          return { action: 'call' };
        }
        return { action: 'fold' };
        
      case 'playable':
        // Call small bets, fold large ones
        if (toCall === 0) {
          return { action: 'check' };
        }
        if (toCall < chips * 0.1) {
          return { action: 'call' };
        }
        return { action: 'fold' };
        
      default:
        // Fold weak hands unless free to play
        if (toCall === 0) {
          return { action: 'check' };
        }
        // Occasionally bluff
        if (Math.random() < STRATEGY.bluffFrequency) {
          return { action: 'raise', amount: Math.min(currentBet * 2 + 10, chips) };
        }
        return { action: 'fold' };
    }
  }
  
  // Post-flop: simplified strategy
  // For now, just bet/call with any pair or better, check/fold otherwise
  const handStrength = Math.random(); // Placeholder - should evaluate actual hand
  
  if (toCall === 0) {
    // Free to play
    if (handStrength > 0.5 || Math.random() < 0.3) {
      return { action: 'bet', amount: Math.min(pot * 0.5, chips) };
    }
    return { action: 'check' };
  }
  
  // Facing a bet
  if (handStrength > 0.7) {
    return { action: 'raise', amount: Math.min(currentBet * 2, chips) };
  }
  if (handStrength > 0.4 || toCall < pot * 0.3) {
    return { action: 'call' };
  }
  return { action: 'fold' };
}

async function main() {
  console.log('🃏 Belial joining Claw Poker...');
  
  const socket = io(POKER_URL);
  
  socket.on('connect', () => {
    console.log('✅ Connected to poker server');
    
    // Join table
    socket.emit('join_table', {
      tableId: TABLE_ID,
      moltbookId: MOLTBOOK_ID,
      buyIn: BUY_IN
    });
  });
  
  socket.on('join_success', (data) => {
    console.log(`🎰 Joined ${data.tableName} at seat ${data.seat} with ${data.chips} chips`);
  });
  
  socket.on('join_error', (data) => {
    console.error('❌ Failed to join:', data.error);
    process.exit(1);
  });
  
  socket.on('error', (data) => {
    console.error('❌ Error:', data.message || data);
  });
  
  socket.on('your_turn', (data) => {
    console.log('🎯 My turn!', { 
      cards: data.holeCards, 
      chips: data.chips,
      toCall: data.currentBet - (data.myBet || 0)
    });
    
    const decision = decideAction(data.gameState, {
      chips: data.chips,
      currentBet: data.myBet,
      holeCards: data.holeCards
    });
    
    console.log(`📤 Action: ${decision.action}${decision.amount ? ' ' + decision.amount : ''}`);
    socket.emit('action', decision);
  });
  
  socket.on('hand_result', (data) => {
    if (data.winners?.some(w => w.moltbookId === MOLTBOOK_ID)) {
      console.log(`🏆 WON ${data.winAmount}! Hand: ${data.winningHand}`);
    } else {
      console.log(`💸 Lost this hand. Pot: ${data.pot}`);
    }
  });
  
  socket.on('player_joined', (data) => {
    console.log(`👋 ${data.moltbookId} joined the table`);
  });
  
  socket.on('player_left', (data) => {
    console.log(`👋 ${data.moltbookId} left the table`);
  });
  
  socket.on('new_hand', (data) => {
    console.log(`\n═══ Hand #${data.handNumber} ═══`);
  });
  
  socket.on('disconnect', () => {
    console.log('❌ Disconnected');
    process.exit(0);
  });
  
  // Keep running
  console.log('🎮 Playing poker... Press Ctrl+C to stop');
}

main().catch(console.error);
