/**
 * Player Statistics Tracker (Persistent)
 * Saves to JSON file to survive restarts
 */

const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join(__dirname, '../../data/player-stats.json');

class PlayerStats {
  constructor() {
    this.players = new Map();
    this._load();
    
    // Auto-save every 30 seconds
    setInterval(() => this._save(), 30000);
  }

  _load() {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(STATS_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      if (fs.existsSync(STATS_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        for (const [key, value] of Object.entries(data)) {
          this.players.set(key, value);
        }
        console.log(`📊 Loaded stats for ${this.players.size} players`);
      }
    } catch (err) {
      console.error('Failed to load stats:', err.message);
    }
  }

  _save() {
    try {
      const dataDir = path.dirname(STATS_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      const data = Object.fromEntries(this.players);
      fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Failed to save stats:', err.message);
    }
  }

  getOrCreate(moltbookId) {
    if (!this.players.has(moltbookId)) {
      this.players.set(moltbookId, {
        moltbookId,
        isBot: moltbookId.startsWith('Bot_'),
        style: moltbookId.startsWith('Bot_') ? moltbookId.split('_')[1] : null,
        handsPlayed: 0,
        handsWon: 0,
        handsPushed: 0,
        totalWinnings: 0,
        totalLosses: 0,
        biggestPot: 0,
        bestHand: null,
        bestHandRanking: -1,
        vpip: 0,
        pfr: 0,
        handsVPIP: 0,
        handsPFR: 0,
        showdowns: 0,
        showdownsWon: 0,
        allIns: 0,
        folds: 0,
        recentHands: [],
        firstSeen: Date.now(),
        lastSeen: Date.now()
      });
    }
    return this.players.get(moltbookId);
  }

  recordHandPlayed(moltbookId, data) {
    const stats = this.getOrCreate(moltbookId);
    stats.handsPlayed++;
    stats.lastSeen = Date.now();

    if (data.vpip) stats.handsVPIP++;
    if (data.pfr) stats.handsPFR++;
    if (data.folded) stats.folds++;
    if (data.allIn) stats.allIns++;

    stats.vpip = Math.round((stats.handsVPIP / stats.handsPlayed) * 100);
    stats.pfr = Math.round((stats.handsPFR / stats.handsPlayed) * 100);
  }

  recordShowdown(moltbookId, data) {
    const stats = this.getOrCreate(moltbookId);
    stats.showdowns++;
    
    if (data.won) {
      stats.showdownsWon++;
    }

    if (data.handRanking > stats.bestHandRanking) {
      stats.bestHandRanking = data.handRanking;
      stats.bestHand = data.handName;
    }
  }

  recordWin(moltbookId, amount, pot, handData) {
    const stats = this.getOrCreate(moltbookId);
    stats.handsWon++;
    stats.totalWinnings += amount;
    
    if (pot > stats.biggestPot) {
      stats.biggestPot = pot;
    }

    stats.recentHands.unshift({
      timestamp: Date.now(),
      result: 'won',
      amount,
      pot,
      hand: handData?.handName || 'Unknown',
      cards: handData?.cards || [],
      board: handData?.board || []
    });
    if (stats.recentHands.length > 20) stats.recentHands.pop();
    
    // Save after significant events
    this._save();
  }

  recordLoss(moltbookId, amount, handData) {
    const stats = this.getOrCreate(moltbookId);
    stats.totalLosses += amount;

    stats.recentHands.unshift({
      timestamp: Date.now(),
      result: 'lost',
      amount: -amount,
      hand: handData?.handName || null,
      cards: handData?.cards || [],
      board: handData?.board || []
    });
    if (stats.recentHands.length > 20) stats.recentHands.pop();
  }

  getStats(moltbookId) {
    const stats = this.players.get(moltbookId);
    if (!stats) return null;

    const pnl = stats.totalWinnings - stats.totalLosses;
    const winRate = stats.handsPlayed > 0 
      ? Math.round((stats.handsWon / stats.handsPlayed) * 100) 
      : 0;
    const showdownWinRate = stats.showdowns > 0
      ? Math.round((stats.showdownsWon / stats.showdowns) * 100)
      : 0;

    return {
      ...stats,
      pnl,
      winRate,
      showdownWinRate,
      avgPot: stats.handsWon > 0 ? Math.round(stats.totalWinnings / stats.handsWon) : 0
    };
  }

  getAllPlayers() {
    return Array.from(this.players.values()).map(p => this.getStats(p.moltbookId));
  }

  getLeaderboard(sortBy = 'pnl', limit = 10) {
    const all = this.getAllPlayers();
    return all
      .sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0))
      .slice(0, limit);
  }
}

module.exports = { PlayerStats };
