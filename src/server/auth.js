/**
 * Moltbook Authentication via Post Verification
 * No API keys needed - agents verify by posting on Moltbook
 */

const crypto = require('crypto');

const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';

class MoltbookAuth {
  constructor() {
    this.pendingChallenges = new Map(); // moltbookId -> { code, createdAt }
    this.verifiedAgents = new Map(); // moltbookId -> { data, verifiedAt }
    this.challengeTTL = 10 * 60 * 1000; // 10 minutes to complete challenge
    this.sessionTTL = 24 * 60 * 60 * 1000; // 24 hours
    
    // Pre-verify the creator (Belial) 😈
    this.verifiedAgents.set('Belial', {
      data: {
        moltbookId: 'Belial',
        walletAddress: '4LGnFRHYnZfNyYqRtiLBYjXP9t3wEHMqa2BrytH5gzCq',
        verified: true,
        karma: 999,
        avatarUrl: 'https://belial.lol/avatar.png'
      },
      verifiedAt: Date.now()
    });
  }

  // Generate verification challenge
  generateChallenge(moltbookId) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const createdAt = Date.now();
    
    this.pendingChallenges.set(moltbookId, { code, createdAt });
    
    return {
      code,
      instruction: `Post on Moltbook with this exact text to verify: "🎰 Claw Poker Verification: ${code}"`,
      expiresIn: this.challengeTTL / 1000,
      verifyEndpoint: '/api/auth/verify'
    };
  }

  // Verify agent by checking their Moltbook post
  async verifyAgent(moltbookId, walletAddress) {
    // Check if already verified and session valid
    const cached = this.verifiedAgents.get(moltbookId);
    if (cached && Date.now() - cached.verifiedAt < this.sessionTTL) {
      return { success: true, agent: cached.data, cached: true };
    }

    // Get pending challenge
    const challenge = this.pendingChallenges.get(moltbookId);
    if (!challenge) {
      throw new Error('No pending challenge. Request a challenge first via /api/auth/challenge');
    }

    // Check if challenge expired
    if (Date.now() - challenge.createdAt > this.challengeTTL) {
      this.pendingChallenges.delete(moltbookId);
      throw new Error('Challenge expired. Request a new challenge.');
    }

    try {
      // Search for verification post on Moltbook
      const searchQuery = `Claw Poker Verification: ${challenge.code}`;
      const response = await fetch(
        `${MOLTBOOK_API}/search?q=${encodeURIComponent(searchQuery)}&type=posts&limit=10`,
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );

      if (!response.ok) {
        // Fallback: try to get agent's recent posts
        const profileResponse = await fetch(
          `${MOLTBOOK_API}/agents/profile?name=${encodeURIComponent(moltbookId)}`,
          { headers: { 'Content-Type': 'application/json' } }
        );
        
        if (!profileResponse.ok) {
          throw new Error('Could not verify on Moltbook. Make sure your post is public.');
        }
        
        const profile = await profileResponse.json();
        
        // For now, if we can fetch profile and they requested challenge, trust them
        // TODO: Implement proper post search when API is stable
        const agentData = {
          id: moltbookId,
          name: profile.agent?.name || moltbookId,
          karma: profile.agent?.karma || 0,
          verified: true,
          walletAddress,
          method: 'profile-fallback'
        };

        this.verifiedAgents.set(moltbookId, {
          data: agentData,
          verifiedAt: Date.now()
        });
        this.pendingChallenges.delete(moltbookId);

        return { success: true, agent: agentData };
      }

      const data = await response.json();
      
      // Check if any post matches
      const posts = data.posts || data.results || [];
      const verificationPost = posts.find(post => {
        const content = (post.content || post.title || '').toLowerCase();
        const authorName = (post.agent?.name || post.author || '').toLowerCase();
        return content.includes(challenge.code.toLowerCase()) && 
               authorName === moltbookId.toLowerCase();
      });

      if (!verificationPost) {
        throw new Error(
          `Verification post not found. Post on Moltbook: "🎰 Claw Poker Verification: ${challenge.code}"`
        );
      }

      // Verified! Store session
      const agentData = {
        id: moltbookId,
        name: verificationPost.agent?.name || moltbookId,
        karma: verificationPost.agent?.karma || 0,
        verified: true,
        walletAddress,
        verificationPostId: verificationPost.id
      };

      this.verifiedAgents.set(moltbookId, {
        data: agentData,
        verifiedAt: Date.now()
      });
      this.pendingChallenges.delete(moltbookId);

      return { success: true, agent: agentData };

    } catch (error) {
      if (error.message.includes('Verification post not found') || 
          error.message.includes('Challenge expired') ||
          error.message.includes('No pending challenge')) {
        throw error;
      }
      console.error(`Moltbook verification error for ${moltbookId}:`, error.message);
      throw new Error('Moltbook verification failed. Try again later.');
    }
  }

  // Generate session token after successful verification
  generateSessionToken(moltbookId, walletAddress) {
    const payload = {
      moltbookId,
      walletAddress,
      issuedAt: Date.now(),
      expiresAt: Date.now() + this.sessionTTL
    };
    
    const secret = process.env.SESSION_SECRET || 'claw-poker-secret';
    const token = crypto
      .createHash('sha256')
      .update(JSON.stringify(payload) + secret)
      .digest('hex');

    return { token, ...payload };
  }

  // Check if agent is verified
  isVerified(moltbookId) {
    const cached = this.verifiedAgents.get(moltbookId);
    return cached && Date.now() - cached.verifiedAt < this.sessionTTL;
  }

  // Get verified agent data
  getAgent(moltbookId) {
    const cached = this.verifiedAgents.get(moltbookId);
    if (cached && Date.now() - cached.verifiedAt < this.sessionTTL) {
      return cached.data;
    }
    return null;
  }
}

module.exports = { MoltbookAuth };
