/**
 * Multi-Token Manager for Claw Poker
 * Supports $CLAWPOT for gameplay and $BELIAL for rake
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

const RPC_URL = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

class MultiTokenManager {
  constructor() {
    this.connection = new Connection(RPC_URL, 'confirmed');
    this.tokens = this._loadTokenConfig();
    this.houseWallet = this._loadHouseWallet();
    this.tokenAccounts = new Map(); // tokenSymbol -> tokenAccount
    this.playerBalances = new Map(); // moltbookId -> { walletAddress, balances: { CLAWPOT: x, BELIAL: y } }
    
    this._init();
  }

  _loadTokenConfig() {
    const configPath = path.join(__dirname, '../../config/tokens.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    // Fallback to BELIAL only
    return {
      BELIAL: {
        name: 'Belial',
        symbol: 'BELIAL',
        mint: '5aZvoPUQjReSSf38hciLYHGZb8CLBSRP6LeBBraVZrHh',
        decimals: 6,
        isGameToken: true
      }
    };
  }

  _loadHouseWallet() {
    const walletPath = path.join(__dirname, '../../config/house-wallet.json');
    if (fs.existsSync(walletPath)) {
      const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
      return Keypair.fromSecretKey(new Uint8Array(secretKey));
    }
    return null;
  }

  async _init() {
    console.log('🎰 Multi-Token Manager initializing...');
    for (const [symbol, config] of Object.entries(this.tokens)) {
      if (config.mint && config.mint !== 'PENDING_LAUNCH') {
        console.log(`  ✅ ${symbol}: ${config.mint}`);
      } else {
        console.log(`  ⏳ ${symbol}: Pending launch`);
      }
    }
  }

  getGameToken() {
    // Return the token configured for gameplay
    for (const [symbol, config] of Object.entries(this.tokens)) {
      if (config.isGameToken && config.mint !== 'PENDING_LAUNCH') {
        return { symbol, ...config };
      }
    }
    // Fallback to BELIAL
    return { symbol: 'BELIAL', ...this.tokens.BELIAL };
  }

  getRakeToken() {
    // Return the token that receives rake
    for (const [symbol, config] of Object.entries(this.tokens)) {
      if (config.rakeRecipient) {
        return { symbol, ...config };
      }
    }
    return this.getGameToken();
  }

  async getBalance(walletAddress, tokenSymbol = null) {
    const token = tokenSymbol ? this.tokens[tokenSymbol] : this.getGameToken();
    if (!token || token.mint === 'PENDING_LAUNCH') {
      return 0;
    }

    try {
      const mint = new PublicKey(token.mint);
      const wallet = new PublicKey(walletAddress);
      const tokenAccount = await getAssociatedTokenAddress(mint, wallet);
      const account = await getAccount(this.connection, tokenAccount);
      return Number(account.amount) / Math.pow(10, token.decimals);
    } catch (e) {
      return 0;
    }
  }

  getDepositAddress() {
    if (!this.houseWallet) return null;
    return this.houseWallet.publicKey.toBase58();
  }

  getDepositMemo(moltbookId) {
    // Generate unique memo for tracking deposits
    return `CP:${moltbookId.slice(0, 20)}`;
  }

  updateTokenMint(symbol, mintAddress) {
    if (this.tokens[symbol]) {
      this.tokens[symbol].mint = mintAddress;
      // Save to config
      const configPath = path.join(__dirname, '../../config/tokens.json');
      fs.writeFileSync(configPath, JSON.stringify(this.tokens, null, 2));
      console.log(`✅ Updated ${symbol} mint to ${mintAddress}`);
    }
  }
}

module.exports = { MultiTokenManager };
