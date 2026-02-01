/**
 * $BELIAL Token Integration
 * Handles deposits, withdrawals, and balance tracking
 */

const { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction,
  sendAndConfirmTransaction
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

// Constants
const BELIAL_TOKEN = new PublicKey('5aZvoPUQjReSSf38hciLYHGZb8CLBSRP6LeBBraVZrHh');
const RPC_URL = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const DECIMALS = 6; // $BELIAL has 6 decimals

class TokenManager {
  constructor() {
    this.connection = new Connection(RPC_URL, 'confirmed');
    this.houseWallet = this._loadHouseWallet();
    this.houseTokenAccount = null;
    this.playerBalances = new Map(); // moltbookId -> { walletAddress, balance, pendingDeposits }
    this.depositWatchers = new Map(); // signature -> callback
    
    // Pre-fund Belial for testing 😈
    this.playerBalances.set('Belial', {
      walletAddress: '4LGnFRHYnZfNyYqRtiLBYjXP9t3wEHMqa2BrytH5gzCq',
      balance: 10000, // Starting balance for testing
      pendingDeposits: []
    });
    
    // Initialize
    this._init();
  }

  _loadHouseWallet() {
    const walletPath = path.join(__dirname, '../../config/house-wallet.json');
    const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
  }

  async _init() {
    try {
      // Get or create house token account
      this.houseTokenAccount = await getAssociatedTokenAddress(
        BELIAL_TOKEN,
        this.houseWallet.publicKey
      );
      
      console.log(`💰 House wallet: ${this.houseWallet.publicKey.toBase58()}`);
      console.log(`💰 House token account: ${this.houseTokenAccount.toBase58()}`);
      
      // Check if token account exists
      try {
        const account = await getAccount(this.connection, this.houseTokenAccount);
        console.log(`💰 House balance: ${Number(account.amount) / Math.pow(10, DECIMALS)} $BELIAL`);
      } catch (e) {
        console.log('⚠️ House token account not initialized (needs first deposit)');
      }

      // Start watching for deposits
      this._startDepositWatcher();
    } catch (error) {
      console.error('Token manager init error:', error.message);
    }
  }

  // Register a player's wallet for deposits/withdrawals
  registerPlayer(moltbookId, walletAddress) {
    if (!this.playerBalances.has(moltbookId)) {
      this.playerBalances.set(moltbookId, {
        walletAddress,
        balance: 0,
        pendingDeposits: []
      });
    } else {
      // Update wallet address if changed
      this.playerBalances.get(moltbookId).walletAddress = walletAddress;
    }
    return this.getPlayerBalance(moltbookId);
  }

  // Get player's poker balance
  getPlayerBalance(moltbookId) {
    const player = this.playerBalances.get(moltbookId);
    return player ? player.balance : 0;
  }

  // Get deposit address (the house wallet)
  getDepositAddress() {
    return this.houseWallet.publicKey.toBase58();
  }

  // Get deposit instructions for a player
  getDepositInstructions(moltbookId, amount) {
    return {
      tokenAddress: BELIAL_TOKEN.toBase58(),
      depositTo: this.houseWallet.publicKey.toBase58(),
      amount: amount,
      memo: `POKER:${moltbookId}`, // Include moltbookId in memo for tracking
      note: 'Send $BELIAL to this address. Include the memo to credit your account.'
    };
  }

  // Credit player balance (after confirmed deposit)
  creditBalance(moltbookId, amount) {
    const player = this.playerBalances.get(moltbookId);
    if (!player) {
      throw new Error('Player not registered');
    }
    player.balance += amount;
    console.log(`💰 Credited ${amount} to ${moltbookId}. New balance: ${player.balance}`);
    return player.balance;
  }

  // Debit player balance (for buy-ins)
  debitBalance(moltbookId, amount) {
    const player = this.playerBalances.get(moltbookId);
    if (!player) {
      throw new Error('Player not registered');
    }
    if (player.balance < amount) {
      throw new Error(`Insufficient balance. Have: ${player.balance}, need: ${amount}`);
    }
    player.balance -= amount;
    console.log(`💸 Debited ${amount} from ${moltbookId}. New balance: ${player.balance}`);
    return player.balance;
  }

  // Withdraw $BELIAL to player's wallet
  async withdraw(moltbookId, amount) {
    const player = this.playerBalances.get(moltbookId);
    if (!player) {
      throw new Error('Player not registered');
    }
    if (player.balance < amount) {
      throw new Error(`Insufficient balance. Have: ${player.balance}, need: ${amount}`);
    }

    const destinationWallet = new PublicKey(player.walletAddress);
    const destinationATA = await getAssociatedTokenAddress(BELIAL_TOKEN, destinationWallet);

    try {
      // Check if destination ATA exists
      let createATA = false;
      try {
        await getAccount(this.connection, destinationATA);
      } catch (e) {
        createATA = true;
      }

      const transaction = new Transaction();

      // Create ATA if needed
      if (createATA) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            this.houseWallet.publicKey,
            destinationATA,
            destinationWallet,
            BELIAL_TOKEN
          )
        );
      }

      // Add transfer instruction
      const amountInSmallestUnit = Math.floor(amount * Math.pow(10, DECIMALS));
      transaction.add(
        createTransferInstruction(
          this.houseTokenAccount,
          destinationATA,
          this.houseWallet.publicKey,
          amountInSmallestUnit
        )
      );

      // Send transaction
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.houseWallet]
      );

      // Debit balance
      player.balance -= amount;

      console.log(`✅ Withdrew ${amount} $BELIAL to ${player.walletAddress}`);
      console.log(`📝 Tx: ${signature}`);

      return {
        success: true,
        signature,
        amount,
        newBalance: player.balance
      };
    } catch (error) {
      console.error('Withdrawal error:', error.message);
      throw new Error(`Withdrawal failed: ${error.message}`);
    }
  }

  // Watch for incoming deposits
  _startDepositWatcher() {
    // Poll for new transactions every 10 seconds
    setInterval(async () => {
      try {
        await this._checkDeposits();
      } catch (error) {
        console.error('Deposit watcher error:', error.message);
      }
    }, 10000);
  }

  async _checkDeposits() {
    if (!this.houseTokenAccount) return;

    try {
      // Get recent token transactions to house account
      const signatures = await this.connection.getSignaturesForAddress(
        this.houseTokenAccount,
        { limit: 10 }
      );

      for (const sig of signatures) {
        // Skip if already processed
        if (this.depositWatchers.has(sig.signature)) continue;
        
        // Mark as processed
        this.depositWatchers.set(sig.signature, true);

        // Get transaction details
        const tx = await this.connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0
        });

        if (!tx || !tx.meta) continue;

        // Look for memo with POKER: prefix
        const memoInstruction = tx.transaction.message.instructions.find(
          i => i.program === 'spl-memo' || i.programId?.toBase58() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
        );

        if (memoInstruction && memoInstruction.parsed) {
          const memo = memoInstruction.parsed;
          if (memo.startsWith('POKER:')) {
            const moltbookId = memo.replace('POKER:', '');
            
            // Find the transfer amount
            for (const innerIx of tx.meta.innerInstructions || []) {
              for (const ix of innerIx.instructions) {
                if (ix.parsed?.type === 'transfer' && ix.parsed?.info?.destination === this.houseTokenAccount.toBase58()) {
                  const amount = parseInt(ix.parsed.info.amount) / Math.pow(10, DECIMALS);
                  
                  // Credit the player
                  if (this.playerBalances.has(moltbookId)) {
                    this.creditBalance(moltbookId, amount);
                    console.log(`🎰 Deposit detected: ${amount} $BELIAL from ${moltbookId}`);
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      // Silently fail for RPC issues
    }
  }

  // Get house wallet balance
  async getHouseBalance() {
    try {
      const account = await getAccount(this.connection, this.houseTokenAccount);
      return Number(account.amount) / Math.pow(10, DECIMALS);
    } catch (e) {
      return 0;
    }
  }

  // Export state for persistence
  exportState() {
    const state = {};
    for (const [id, data] of this.playerBalances) {
      state[id] = data;
    }
    return state;
  }

  // Import state from persistence
  importState(state) {
    for (const [id, data] of Object.entries(state)) {
      this.playerBalances.set(id, data);
    }
  }
}

module.exports = { TokenManager, BELIAL_TOKEN, DECIMALS };
