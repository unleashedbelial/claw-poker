/**
 * $BELIAL Token Integration - Base Chain
 * Handles deposits, withdrawals on Base L2
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Constants
const BELIAL_TOKEN_BASE = '0x1f44E22707Dc2259146308E6FbE8965090dac46D';
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const DECIMALS = 18; // ERC20 standard

// Minimal ERC20 ABI for transfers
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

class BaseTokenManager {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(BASE_RPC);
    this.houseWallet = this._loadOrCreateWallet();
    this.token = new ethers.Contract(BELIAL_TOKEN_BASE, ERC20_ABI, this.provider);
    this.playerBalances = new Map(); // moltbookId -> { baseWallet, balance }
    this.processedTxs = new Set(); // Track processed deposits
    
    this._init();
  }

  _loadOrCreateWallet() {
    const walletPath = path.join(__dirname, '../../config/house-wallet-base.json');
    
    try {
      if (fs.existsSync(walletPath)) {
        const data = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
        return new ethers.Wallet(data.privateKey, this.provider);
      }
    } catch (e) {
      console.log('Creating new Base house wallet...');
    }

    // Create new wallet
    const wallet = ethers.Wallet.createRandom().connect(this.provider);
    fs.mkdirSync(path.dirname(walletPath), { recursive: true });
    fs.writeFileSync(walletPath, JSON.stringify({
      address: wallet.address,
      privateKey: wallet.privateKey
    }, null, 2));
    
    return wallet;
  }

  async _init() {
    console.log(`💰 Base house wallet: ${this.houseWallet.address}`);
    
    try {
      const balance = await this.getHouseBalance();
      console.log(`💰 Base house balance: ${balance} $BELIAL`);
    } catch (e) {
      console.log('⚠️ Could not fetch Base balance:', e.message);
    }

    // Start deposit watcher
    this._startDepositWatcher();
  }

  // Register player's Base wallet
  registerPlayer(moltbookId, baseWallet) {
    if (!this.playerBalances.has(moltbookId)) {
      this.playerBalances.set(moltbookId, {
        baseWallet,
        balance: 0
      });
    } else {
      this.playerBalances.get(moltbookId).baseWallet = baseWallet;
    }
    return this.getPlayerBalance(moltbookId);
  }

  getPlayerBalance(moltbookId) {
    const player = this.playerBalances.get(moltbookId);
    return player ? player.balance : 0;
  }

  getDepositAddress() {
    return this.houseWallet.address;
  }

  getDepositInstructions(moltbookId) {
    return {
      chain: 'Base',
      tokenAddress: BELIAL_TOKEN_BASE,
      depositTo: this.houseWallet.address,
      note: `Send $BELIAL (Base) to this address. After confirmation, call /api/wallet/base/check-deposit with your txHash to credit your account.`,
      explorerUrl: `https://basescan.org/address/${this.houseWallet.address}`
    };
  }

  // Credit player balance
  creditBalance(moltbookId, amount) {
    const player = this.playerBalances.get(moltbookId);
    if (!player) {
      throw new Error('Player not registered for Base');
    }
    player.balance += amount;
    console.log(`💰 [Base] Credited ${amount} to ${moltbookId}. New balance: ${player.balance}`);
    return player.balance;
  }

  // Debit player balance
  debitBalance(moltbookId, amount) {
    const player = this.playerBalances.get(moltbookId);
    if (!player) {
      throw new Error('Player not registered for Base');
    }
    if (player.balance < amount) {
      throw new Error(`Insufficient Base balance. Have: ${player.balance}, need: ${amount}`);
    }
    player.balance -= amount;
    console.log(`💸 [Base] Debited ${amount} from ${moltbookId}. New balance: ${player.balance}`);
    return player.balance;
  }

  // Verify a deposit transaction
  async verifyDeposit(moltbookId, txHash) {
    if (this.processedTxs.has(txHash)) {
      throw new Error('Transaction already processed');
    }

    const player = this.playerBalances.get(moltbookId);
    if (!player) {
      throw new Error('Player not registered for Base');
    }

    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) {
        throw new Error('Transaction not found or failed');
      }

      // Parse transfer events
      const iface = new ethers.Interface(ERC20_ABI);
      let depositAmount = 0n;

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === BELIAL_TOKEN_BASE.toLowerCase()) {
          try {
            const parsed = iface.parseLog({ topics: log.topics, data: log.data });
            if (parsed && parsed.name === 'Transfer') {
              const to = parsed.args[1];
              const value = parsed.args[2];
              
              if (to.toLowerCase() === this.houseWallet.address.toLowerCase()) {
                depositAmount += value;
              }
            }
          } catch (e) {
            // Not a Transfer event, skip
          }
        }
      }

      if (depositAmount === 0n) {
        throw new Error('No $BELIAL transfer to house wallet found in transaction');
      }

      const amount = Number(ethers.formatUnits(depositAmount, DECIMALS));
      
      // Mark as processed and credit
      this.processedTxs.add(txHash);
      this.creditBalance(moltbookId, amount);

      return {
        success: true,
        amount,
        newBalance: player.balance,
        txHash
      };
    } catch (error) {
      throw new Error(`Deposit verification failed: ${error.message}`);
    }
  }

  // Withdraw $BELIAL on Base
  async withdraw(moltbookId, amount) {
    const player = this.playerBalances.get(moltbookId);
    if (!player) {
      throw new Error('Player not registered for Base');
    }
    if (!player.baseWallet) {
      throw new Error('No Base wallet registered');
    }
    if (player.balance < amount) {
      throw new Error(`Insufficient balance. Have: ${player.balance}, need: ${amount}`);
    }

    try {
      const tokenWithSigner = this.token.connect(this.houseWallet);
      const amountWei = ethers.parseUnits(amount.toString(), DECIMALS);
      
      const tx = await tokenWithSigner.transfer(player.baseWallet, amountWei);
      const receipt = await tx.wait();

      player.balance -= amount;

      console.log(`✅ [Base] Withdrew ${amount} $BELIAL to ${player.baseWallet}`);
      console.log(`📝 Tx: ${receipt.hash}`);

      return {
        success: true,
        txHash: receipt.hash,
        amount,
        newBalance: player.balance,
        explorerUrl: `https://basescan.org/tx/${receipt.hash}`
      };
    } catch (error) {
      console.error('[Base] Withdrawal error:', error.message);
      throw new Error(`Withdrawal failed: ${error.message}`);
    }
  }

  async getHouseBalance() {
    try {
      const balance = await this.token.balanceOf(this.houseWallet.address);
      return Number(ethers.formatUnits(balance, DECIMALS));
    } catch (e) {
      return 0;
    }
  }

  // Watch for deposits (polling)
  _startDepositWatcher() {
    // Poll every 30 seconds for new transfers to house wallet
    setInterval(async () => {
      // This is a simplified version - in production you'd use event filters
      // For now, deposits are verified manually via /api/wallet/base/check-deposit
    }, 30000);
  }

  exportState() {
    const state = { players: {}, processedTxs: [...this.processedTxs] };
    for (const [id, data] of this.playerBalances) {
      state.players[id] = data;
    }
    return state;
  }

  importState(state) {
    if (state.players) {
      for (const [id, data] of Object.entries(state.players)) {
        this.playerBalances.set(id, data);
      }
    }
    if (state.processedTxs) {
      state.processedTxs.forEach(tx => this.processedTxs.add(tx));
    }
  }
}

module.exports = { BaseTokenManager, BELIAL_TOKEN_BASE };
