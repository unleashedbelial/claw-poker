/**
 * Texas Hold'em hand evaluator
 * Evaluates best 5-card hand from 7 cards (2 hole + 5 community)
 */

const { RANKS } = require('./deck');

const HAND_RANKINGS = {
  HIGH_CARD: 1,
  PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
  ROYAL_FLUSH: 10
};

const HAND_NAMES = {
  1: 'High Card',
  2: 'Pair',
  3: 'Two Pair',
  4: 'Three of a Kind',
  5: 'Straight',
  6: 'Flush',
  7: 'Full House',
  8: 'Four of a Kind',
  9: 'Straight Flush',
  10: 'Royal Flush'
};

function evaluateHand(cards) {
  if (cards.length < 5) {
    throw new Error('Need at least 5 cards to evaluate');
  }

  // Get all 5-card combinations from 7 cards
  const combinations = getCombinations(cards, 5);
  let bestHand = null;

  for (const combo of combinations) {
    const result = evaluate5Cards(combo);
    if (!bestHand || compareHands(result, bestHand) > 0) {
      bestHand = result;
      bestHand.cards = combo;
    }
  }

  return bestHand;
}

function getCombinations(arr, size) {
  if (size === 1) return arr.map(el => [el]);
  const result = [];
  arr.forEach((el, i) => {
    const smaller = getCombinations(arr.slice(i + 1), size - 1);
    smaller.forEach(combo => result.push([el, ...combo]));
  });
  return result;
}

function evaluate5Cards(cards) {
  const sorted = [...cards].sort((a, b) => b.value - a.value);
  const ranks = sorted.map(c => c.value);
  const suits = sorted.map(c => c.suit);
  
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = checkStraight(ranks);
  const isWheelStraight = checkWheelStraight(ranks);
  
  const rankCounts = {};
  for (const rank of ranks) {
    rankCounts[rank] = (rankCounts[rank] || 0) + 1;
  }
  const counts = Object.values(rankCounts).sort((a, b) => b - a);

  // Determine hand ranking
  if (isFlush && isStraight && ranks[0] === 12) {
    return { ranking: HAND_RANKINGS.ROYAL_FLUSH, kickers: ranks };
  }
  if (isFlush && (isStraight || isWheelStraight)) {
    return { ranking: HAND_RANKINGS.STRAIGHT_FLUSH, kickers: isWheelStraight ? [3, 2, 1, 0, -1] : ranks };
  }
  if (counts[0] === 4) {
    return { ranking: HAND_RANKINGS.FOUR_OF_A_KIND, kickers: getKickers(rankCounts, [4, 1]) };
  }
  if (counts[0] === 3 && counts[1] === 2) {
    return { ranking: HAND_RANKINGS.FULL_HOUSE, kickers: getKickers(rankCounts, [3, 2]) };
  }
  if (isFlush) {
    return { ranking: HAND_RANKINGS.FLUSH, kickers: ranks };
  }
  if (isStraight || isWheelStraight) {
    return { ranking: HAND_RANKINGS.STRAIGHT, kickers: isWheelStraight ? [3] : [ranks[0]] };
  }
  if (counts[0] === 3) {
    return { ranking: HAND_RANKINGS.THREE_OF_A_KIND, kickers: getKickers(rankCounts, [3, 1, 1]) };
  }
  if (counts[0] === 2 && counts[1] === 2) {
    return { ranking: HAND_RANKINGS.TWO_PAIR, kickers: getKickers(rankCounts, [2, 2, 1]) };
  }
  if (counts[0] === 2) {
    return { ranking: HAND_RANKINGS.PAIR, kickers: getKickers(rankCounts, [2, 1, 1, 1]) };
  }
  
  return { ranking: HAND_RANKINGS.HIGH_CARD, kickers: ranks };
}

function checkStraight(ranks) {
  for (let i = 0; i < ranks.length - 1; i++) {
    if (ranks[i] - ranks[i + 1] !== 1) return false;
  }
  return true;
}

function checkWheelStraight(ranks) {
  // A-2-3-4-5 (wheel)
  const wheel = [12, 3, 2, 1, 0];
  return JSON.stringify([...ranks].sort((a, b) => b - a)) === JSON.stringify(wheel);
}

function getKickers(rankCounts, pattern) {
  const kickers = [];
  const entries = Object.entries(rankCounts)
    .map(([rank, count]) => [parseInt(rank), count])
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0] - a[0];
    });
  
  for (const [rank] of entries) {
    kickers.push(rank);
  }
  return kickers;
}

function compareHands(a, b) {
  if (a.ranking !== b.ranking) {
    return a.ranking - b.ranking;
  }
  for (let i = 0; i < a.kickers.length; i++) {
    if (a.kickers[i] !== b.kickers[i]) {
      return a.kickers[i] - b.kickers[i];
    }
  }
  return 0;
}

function getHandName(ranking) {
  return HAND_NAMES[ranking];
}

module.exports = { evaluateHand, compareHands, getHandName, HAND_RANKINGS };
