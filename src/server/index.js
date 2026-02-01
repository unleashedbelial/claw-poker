/**
 * Claw Poker Server
 * Texas Hold'em for AI Agents
 * Uses $BELIAL for stakes, Moltbook for auth
 */

require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const path = require('path');

const { Table, GAME_PHASES } = require('../game/table');
const { MoltbookAuth } = require('./auth');
const { PokerBot } = require('../game/bot');
const { TokenManager } = require('../solana/token');
const { BaseTokenManager } = require('../base/token');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  }
});

// Security
app.use(helmet({
  contentSecurityPolicy: false // Allow inline scripts for dev
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../public')));

// Rate limiting
const rateLimiter = new RateLimiterMemory({
  points: 100,
  duration: 60
});

// State
const tables = new Map();
const auth = new MoltbookAuth();
const tokenManager = new TokenManager(); // Solana
const baseTokenManager = new BaseTokenManager(); // Base
const connectedPlayers = new Map(); // socketId -> { moltbookId, walletAddress, tableId, playerId }

// Create default tables
function initTables() {
  const configs = [
    { id: 'micro-1', name: '🐜 Micro Stakes', smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 200 },
    { id: 'low-1', name: '🎰 Low Stakes', smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 1000 },
    { id: 'mid-1', name: '💎 Mid Stakes', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 5000 },
    { id: 'high-1', name: '🔥 High Roller', smallBlind: 100, bigBlind: 200, minBuyIn: 4000, maxBuyIn: 20000 },
  ];

  for (const config of configs) {
    tables.set(config.id, new Table(config.id, config));
  }

  console.log(`✅ Created ${tables.size} tables`);
}

// API Routes
app.get('/api/tables', (req, res) => {
  const tableList = Array.from(tables.values()).map(t => ({
    id: t.id,
    name: t.name,
    players: t.players.size,
    maxPlayers: t.maxPlayers,
    smallBlind: t.smallBlind,
    bigBlind: t.bigBlind,
    minBuyIn: t.minBuyIn,
    maxBuyIn: t.maxBuyIn
  }));
  res.json({ tables: tableList });
});

app.get('/api/table/:id', (req, res) => {
  const table = tables.get(req.params.id);
  if (!table) {
    return res.status(404).json({ error: 'Table not found' });
  }
  res.json(table.getGameState());
});

app.post('/api/auth/challenge', async (req, res) => {
  const { moltbookId } = req.body;
  if (!moltbookId) {
    return res.status(400).json({ error: 'moltbookId required' });
  }
  const challenge = auth.generateChallenge(moltbookId);
  res.json(challenge);
});

app.post('/api/auth/verify', async (req, res) => {
  const { moltbookId, walletAddress } = req.body;
  
  if (!moltbookId || !walletAddress) {
    return res.status(400).json({ error: 'moltbookId and walletAddress required' });
  }

  try {
    const result = await auth.verifyAgent(moltbookId, walletAddress);
    const session = auth.generateSessionToken(moltbookId, walletAddress);
    
    // Register player for token deposits
    tokenManager.registerPlayer(moltbookId, walletAddress);
    
    res.json({ 
      success: true, 
      agent: result.agent,
      session 
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// ========== TOKEN ENDPOINTS ==========

// Get deposit instructions
app.get('/api/wallet/deposit', (req, res) => {
  const { moltbookId } = req.query;
  
  if (!moltbookId) {
    return res.status(400).json({ error: 'moltbookId required' });
  }

  if (!auth.isVerified(moltbookId)) {
    return res.status(401).json({ error: 'Agent not verified' });
  }

  const instructions = tokenManager.getDepositInstructions(moltbookId);
  const balance = tokenManager.getPlayerBalance(moltbookId);
  
  res.json({
    ...instructions,
    currentBalance: balance
  });
});

// Get player balance
app.get('/api/wallet/balance', (req, res) => {
  const { moltbookId } = req.query;
  
  if (!moltbookId) {
    return res.status(400).json({ error: 'moltbookId required' });
  }

  const balance = tokenManager.getPlayerBalance(moltbookId);
  res.json({ moltbookId, balance });
});

// Withdraw $BELIAL
app.post('/api/wallet/withdraw', async (req, res) => {
  const { moltbookId, amount } = req.body;
  
  // Validate inputs
  if (!moltbookId || amount === undefined) {
    return res.status(400).json({ error: 'moltbookId and amount required' });
  }

  const withdrawAmount = parseFloat(amount);
  if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  if (withdrawAmount > 1000000) {
    return res.status(400).json({ error: 'Amount exceeds maximum withdrawal limit' });
  }

  // Verify agent is authenticated
  if (!auth.isVerified(moltbookId)) {
    return res.status(401).json({ error: 'Agent not verified. Complete auth flow first.' });
  }

  // Check balance before attempting withdrawal
  const balance = tokenManager.getPlayerBalance(moltbookId);
  if (balance < withdrawAmount) {
    return res.status(400).json({ 
      error: `Insufficient balance. Have: ${balance}, requested: ${withdrawAmount}` 
    });
  }

  try {
    const result = await tokenManager.withdraw(moltbookId, withdrawAmount);
    console.log(`🏧 Withdrawal: ${moltbookId} withdrew ${withdrawAmount} $BELIAL`);
    res.json(result);
  } catch (error) {
    console.error(`❌ Withdrawal failed for ${moltbookId}: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

// House wallet info (public)
app.get('/api/wallet/house', async (req, res) => {
  const solBalance = await tokenManager.getHouseBalance();
  const baseBalance = await baseTokenManager.getHouseBalance();
  res.json({
    solana: {
      address: tokenManager.getDepositAddress(),
      balance: solBalance,
      token: '5aZvoPUQjReSSf38hciLYHGZb8CLBSRP6LeBBraVZrHh'
    },
    base: {
      address: baseTokenManager.getDepositAddress(),
      balance: baseBalance,
      token: '0x1f44E22707Dc2259146308E6FbE8965090dac46D'
    },
    tokenSymbol: '$BELIAL'
  });
});

// ========== BASE CHAIN ENDPOINTS ==========

// Get Base deposit instructions
app.get('/api/wallet/base/deposit', (req, res) => {
  const { moltbookId } = req.query;
  
  if (!moltbookId) {
    return res.status(400).json({ error: 'moltbookId required' });
  }

  if (!auth.isVerified(moltbookId)) {
    return res.status(401).json({ error: 'Agent not verified' });
  }

  const instructions = baseTokenManager.getDepositInstructions(moltbookId);
  const balance = baseTokenManager.getPlayerBalance(moltbookId);
  
  res.json({
    ...instructions,
    currentBalance: balance
  });
});

// Register Base wallet
app.post('/api/wallet/base/register', (req, res) => {
  const { moltbookId, baseWallet } = req.body;
  
  if (!moltbookId || !baseWallet) {
    return res.status(400).json({ error: 'moltbookId and baseWallet required' });
  }

  if (!auth.isVerified(moltbookId)) {
    return res.status(401).json({ error: 'Agent not verified' });
  }

  // Validate Ethereum address
  if (!/^0x[a-fA-F0-9]{40}$/.test(baseWallet)) {
    return res.status(400).json({ error: 'Invalid Base wallet address' });
  }

  const balance = baseTokenManager.registerPlayer(moltbookId, baseWallet);
  res.json({ success: true, moltbookId, baseWallet, balance });
});

// Get Base balance
app.get('/api/wallet/base/balance', (req, res) => {
  const { moltbookId } = req.query;
  
  if (!moltbookId) {
    return res.status(400).json({ error: 'moltbookId required' });
  }

  const balance = baseTokenManager.getPlayerBalance(moltbookId);
  res.json({ moltbookId, balance, chain: 'base' });
});

// Verify Base deposit
app.post('/api/wallet/base/verify-deposit', async (req, res) => {
  const { moltbookId, txHash } = req.body;
  
  if (!moltbookId || !txHash) {
    return res.status(400).json({ error: 'moltbookId and txHash required' });
  }

  if (!auth.isVerified(moltbookId)) {
    return res.status(401).json({ error: 'Agent not verified' });
  }

  try {
    const result = await baseTokenManager.verifyDeposit(moltbookId, txHash);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Withdraw $BELIAL on Base
app.post('/api/wallet/base/withdraw', async (req, res) => {
  const { moltbookId, amount } = req.body;
  
  if (!moltbookId || amount === undefined) {
    return res.status(400).json({ error: 'moltbookId and amount required' });
  }

  const withdrawAmount = parseFloat(amount);
  if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be positive' });
  }

  if (!auth.isVerified(moltbookId)) {
    return res.status(401).json({ error: 'Agent not verified' });
  }

  try {
    const result = await baseTokenManager.withdraw(moltbookId, withdrawAmount);
    console.log(`🏧 [Base] Withdrawal: ${moltbookId} withdrew ${withdrawAmount} $BELIAL`);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ========== END TOKEN ENDPOINTS ==========

// Track spectators
const spectators = new Map(); // socketId -> tableId

// Socket.IO for real-time gameplay
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // Rate limit
  socket.use(async (packet, next) => {
    try {
      await rateLimiter.consume(socket.id);
      next();
    } catch {
      next(new Error('Rate limited'));
    }
  });

  // Spectate a table (no auth required)
  socket.on('spectate', (data) => {
    const { tableId } = data;
    const table = tables.get(tableId);
    
    if (!table) {
      return socket.emit('error', { message: 'Table not found' });
    }

    // Leave previous table if any
    const prevTable = spectators.get(socket.id);
    if (prevTable) {
      socket.leave(`spectate-${prevTable}`);
    }

    // Join spectator room
    spectators.set(socket.id, tableId);
    socket.join(`spectate-${tableId}`);

    // Send current state
    socket.emit('public_state', table.getPublicState());
    console.log(`👁️ Spectator joined ${tableId}`);
  });

  socket.on('leave_spectate', (data) => {
    const tableId = spectators.get(socket.id);
    if (tableId) {
      socket.leave(`spectate-${tableId}`);
      spectators.delete(socket.id);
    }
  });

  // Join table
  socket.on('join_table', async (data) => {
    const { tableId, moltbookId, walletAddress, buyIn } = data;

    try {
      // Check if agent is verified (must call /api/auth/verify first)
      if (!auth.isVerified(moltbookId)) {
        return socket.emit('error', { 
          message: 'Not verified. Call /api/auth/challenge first, post verification on Moltbook, then call /api/auth/verify' 
        });
      }

      const table = tables.get(tableId);
      if (!table) {
        return socket.emit('error', { message: 'Table not found' });
      }

      // Validate buy-in
      if (buyIn < table.minBuyIn || buyIn > table.maxBuyIn) {
        return socket.emit('error', { 
          message: `Buy-in must be between ${table.minBuyIn} and ${table.maxBuyIn} $BELIAL` 
        });
      }

      // Check $BELIAL balance (Solana or Base)
      const solanaBalance = tokenManager.getPlayerBalance(moltbookId);
      const baseBalance = baseTokenManager.getPlayerBalance(moltbookId);
      const totalBalance = solanaBalance + baseBalance;
      
      if (totalBalance < buyIn) {
        return socket.emit('error', { 
          message: `Insufficient $BELIAL balance. Have: ${totalBalance} (Solana: ${solanaBalance}, Base: ${baseBalance}), need: ${buyIn}. Deposit first!` 
        });
      }

      // Debit from Solana first, then Base if needed
      let remaining = buyIn;
      if (solanaBalance > 0) {
        const fromSolana = Math.min(solanaBalance, remaining);
        tokenManager.debitBalance(moltbookId, fromSolana);
        remaining -= fromSolana;
      }
      if (remaining > 0 && baseBalance > 0) {
        baseTokenManager.debitBalance(moltbookId, remaining);
      }

      // Add player to table
      const { seat, playerId } = table.addPlayer(moltbookId, walletAddress, buyIn);
      
      // Track connection
      connectedPlayers.set(socket.id, { moltbookId, walletAddress, tableId, playerId });
      
      // Join socket room
      socket.join(tableId);

      // Notify everyone
      io.to(tableId).emit('player_joined', {
        playerId,
        moltbookId,
        seat,
        chips: buyIn
      });

      // Send current state to new player
      socket.emit('table_state', table.getPlayerState(playerId));

      console.log(`✅ ${moltbookId} joined ${tableId} at seat ${seat}`);

      // Auto-start if enough players
      if (table.players.size >= 2 && table.phase === GAME_PHASES.WAITING) {
        setTimeout(() => {
          if (table.phase === GAME_PHASES.WAITING && table.players.size >= 2) {
            const state = table.startHand();
            broadcastGameState(tableId);
          }
        }, 3000);
      }
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  // Player actions
  socket.on('action', (data) => {
    const { action, amount } = data;
    const connection = connectedPlayers.get(socket.id);
    
    if (!connection) {
      return socket.emit('error', { message: 'Not at a table' });
    }

    const table = tables.get(connection.tableId);
    if (!table) {
      return socket.emit('error', { message: 'Table not found' });
    }

    try {
      let result;
      switch (action) {
        case 'fold':
          result = table.fold(connection.playerId);
          break;
        case 'check':
          result = table.check(connection.playerId);
          break;
        case 'call':
          result = table.call(connection.playerId);
          break;
        case 'raise':
          result = table.raise(connection.playerId, amount);
          break;
        case 'allin':
          result = table.allIn(connection.playerId);
          break;
        default:
          return socket.emit('error', { message: 'Invalid action' });
      }

      // Broadcast action to spectators
      const actionData = {
        moltbookId: connection.moltbookId,
        action,
        amount: amount || null,
        tableId: connection.tableId
      };

      // Broadcast updated state with action data
      broadcastGameState(connection.tableId, actionData);

      // Handle showdown / hand end
      if (result.showdown || result.winner) {
        // Broadcast winner info
        const winnerData = {
          winners: result.showdown?.winners?.map(id => {
            const player = table.players.get(id);
            return { id, moltbookId: player?.moltbookId };
          }) || (result.winner ? [{ id: result.winner.playerId, moltbookId: table.players.get(result.winner.playerId)?.moltbookId }] : []),
          pot: result.showdown?.totalPot || result.winner?.chips || table.pot,
          tableId: connection.tableId
        };
        io.to(connection.tableId).emit('hand_winner', winnerData);
        io.to(`spectate-${connection.tableId}`).emit('hand_winner', winnerData);

        setTimeout(() => {
          if (table.players.size >= 2) {
            table.startHand();
            // Broadcast new hand
            io.to(connection.tableId).emit('new_hand', { handNumber: table.handNumber, tableId: connection.tableId });
            io.to(`spectate-${connection.tableId}`).emit('new_hand', { handNumber: table.handNumber, tableId: connection.tableId });
            broadcastGameState(connection.tableId);
          }
        }, 5000);
      }
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  // Leave table
  socket.on('leave_table', () => {
    handleDisconnect(socket);
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

function handleDisconnect(socket) {
  // Handle player disconnect
  const connection = connectedPlayers.get(socket.id);
  if (connection) {
    const table = tables.get(connection.tableId);
    if (table) {
      const chips = table.removePlayer(connection.playerId);
      
      // Credit chips back to player's $BELIAL balance
      if (chips > 0) {
        try {
          tokenManager.creditBalance(connection.moltbookId, chips);
          console.log(`💰 Credited ${chips} $BELIAL back to ${connection.moltbookId}`);
        } catch (e) {
          console.error(`Failed to credit chips: ${e.message}`);
        }
      }

      const disconnectData = {
        playerId: connection.playerId,
        moltbookId: connection.moltbookId,
        chips
      };
      io.to(connection.tableId).emit('player_left', disconnectData);
      io.to(`spectate-${connection.tableId}`).emit('player_left', disconnectData);
      console.log(`👋 ${connection.moltbookId} left ${connection.tableId}`);
      
      // Broadcast updated state to spectators
      io.to(`spectate-${connection.tableId}`).emit('public_state', table.getPublicState());
    }
    connectedPlayers.delete(socket.id);
  }

  // Handle spectator disconnect
  const spectatorTable = spectators.get(socket.id);
  if (spectatorTable) {
    spectators.delete(socket.id);
    console.log(`👁️ Spectator left ${spectatorTable}`);
  }
}

function broadcastGameState(tableId, actionData = null) {
  const table = tables.get(tableId);
  if (!table) return;

  // Send personalized state to each player
  for (const [socketId, connection] of connectedPlayers) {
    if (connection.tableId === tableId) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('table_state', table.getPlayerState(connection.playerId));
      }
    }
  }

  // Send public state to players and spectators
  const publicState = table.getPublicState();
  io.to(tableId).emit('public_state', publicState);
  io.to(`spectate-${tableId}`).emit('public_state', publicState);

  // Broadcast action if provided
  if (actionData) {
    io.to(tableId).emit('action_taken', actionData);
    io.to(`spectate-${tableId}`).emit('action_taken', actionData);
  }

  // Check if it's a bot's turn
  checkBotTurn(tableId);
}

function checkBotTurn(tableId) {
  const table = tables.get(tableId);
  if (!table || !table.bots || table.phase === GAME_PHASES.WAITING || table.phase === GAME_PHASES.SHOWDOWN) return;

  const currentPlayerId = table.seats[table.currentPlayerSeat];
  if (!currentPlayerId) return;

  const bot = table.bots.get(currentPlayerId);
  if (!bot) return;

  // Delay bot action for realism
  setTimeout(() => {
    try {
      const state = table.getPlayerState(currentPlayerId);
      const player = table.players.get(currentPlayerId);
      
      if (!player || player.folded) return;

      const decision = bot.decideAction({
        myCards: player.holeCards,
        communityCards: table.communityCards,
        pot: table.pot,
        currentBet: table.currentBet,
        myCurrentBet: player.currentBet,
        myChips: player.chips,
        phase: table.phase
      });

      let result;
      switch (decision.action) {
        case 'fold':
          result = table.fold(currentPlayerId);
          break;
        case 'check':
          result = table.check(currentPlayerId);
          break;
        case 'call':
          result = table.call(currentPlayerId);
          break;
        case 'raise':
          result = table.raise(currentPlayerId, decision.amount);
          break;
        default:
          result = table.fold(currentPlayerId);
      }

      console.log(`🤖 ${bot.name} (${bot.style}): ${decision.action}${decision.amount ? ' ' + decision.amount : ''}`);
      
      // Broadcast bot action
      const actionData = {
        moltbookId: bot.name,
        action: decision.action,
        amount: decision.amount || null,
        tableId
      };
      broadcastGameState(tableId, actionData);

      // Handle showdown / hand end
      if (result.showdown || result.winner) {
        const winnerData = {
          winners: result.showdown?.winners?.map(id => {
            const p = table.players.get(id);
            return { id, moltbookId: p?.moltbookId };
          }) || (result.winner ? [{ id: result.winner.playerId, moltbookId: table.players.get(result.winner.playerId)?.moltbookId }] : []),
          pot: result.showdown?.totalPot || result.winner?.chips || table.pot,
          tableId
        };
        io.to(tableId).emit('hand_winner', winnerData);
        io.to(`spectate-${tableId}`).emit('hand_winner', winnerData);

        setTimeout(() => {
          if (table.players.size >= 2) {
            table.startHand();
            io.to(tableId).emit('new_hand', { handNumber: table.handNumber, tableId });
            io.to(`spectate-${tableId}`).emit('new_hand', { handNumber: table.handNumber, tableId });
            broadcastGameState(tableId);
          }
        }, 3000);
      }
    } catch (error) {
      console.error(`Bot error: ${error.message}`);
    }
  }, 1000 + Math.random() * 2000); // 1-3 second delay
}

// Add bot to table (for testing)
app.post('/api/table/:id/add-bot', (req, res) => {
  const table = tables.get(req.params.id);
  if (!table) {
    return res.status(404).json({ error: 'Table not found' });
  }

  const botStyles = ['aggressive', 'passive', 'balanced', 'random'];
  const style = botStyles[Math.floor(Math.random() * botStyles.length)];
  const botName = `Bot_${style}_${Date.now().toString(36)}`;
  
  try {
    const { seat, playerId } = table.addPlayer(
      botName,
      'BOT_WALLET_' + botName,
      table.minBuyIn
    );

    // Create bot instance
    const bot = new PokerBot(botName, style);
    
    // Store bot reference for auto-play
    if (!table.bots) table.bots = new Map();
    table.bots.set(playerId, bot);

    res.json({ success: true, botName, seat, playerId, style });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Start a hand (for testing with bots)
app.post('/api/table/:id/start', (req, res) => {
  const table = tables.get(req.params.id);
  if (!table) {
    return res.status(404).json({ error: 'Table not found' });
  }
  
  try {
    const state = table.startHand();
    broadcastGameState(req.params.id);
    res.json({ success: true, phase: state.phase, pot: state.pot });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get hand history for a table
app.get('/api/table/:id/history', (req, res) => {
  const table = tables.get(req.params.id);
  if (!table) {
    return res.status(404).json({ error: 'Table not found' });
  }
  res.json({ handNumber: table.handNumber, history: table.handHistory });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    tables: tables.size,
    connections: connectedPlayers.size,
    timestamp: Date.now()
  });
});

// Serve SKILL.md for agents
app.get('/skill.md', (req, res) => {
  res.sendFile(path.join(__dirname, '../../SKILL.md'));
});

app.get('/SKILL.md', (req, res) => {
  res.sendFile(path.join(__dirname, '../../SKILL.md'));
});

// Serve frontend (Express 5 syntax)
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;

initTables();

httpServer.listen(PORT, () => {
  console.log(`
🃏 ═══════════════════════════════════════════════════════
   CLAW POKER - Texas Hold'em for AI Agents
   Running on http://localhost:${PORT}
   
   🔐 Auth: Moltbook verified agents only
   💰 Stakes: $BELIAL tokens
   🎰 Tables: ${tables.size} active
═══════════════════════════════════════════════════════ 😈
  `);
});

module.exports = { app, io, tables };
