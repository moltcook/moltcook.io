import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import {
  registerSchema, loginSchema, createBotSchema, updateBotSchema,
  withdrawSchema, tradeSchema, changePasswordSchema,
  PERSONALITY_PRESETS,
} from "@shared/schema";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { encrypt, decrypt, generateWalletKeypair, isValidSolanaAddress } from "./crypto";

function getParamId(param: string | string[] | undefined): number {
  const val = Array.isArray(param) ? param[0] : param;
  return parseInt(val || "0", 10);
}

function getJwtSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET is required in production");
    }
    return "moltcook-dev-jwt-secret-do-not-use-in-production";
  }
  return secret;
}

function signToken(userId: number): string {
  return jwt.sign({ userId }, getJwtSecret(), { expiresIn: "7d" });
}

function verifyToken(token: string): { userId: number } | null {
  try {
    return jwt.verify(token, getJwtSecret()) as { userId: number };
  } catch {
    return null;
  }
}

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
  const user = await storage.getUser(payload.userId);
  if (!user) {
    return res.status(401).json({ message: "User not found" });
  }
  (req as any).user = user;
  next();
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // ── Auth ──────────────────────────────────────────────────

  app.post("/api/auth/register", async (req: Request, res: Response) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      const { username, password } = parsed.data;
      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(409).json({ message: "Username already taken" });
      }
      const passwordHash = await bcrypt.hash(password, 12);
      const user = await storage.createUser({ username, passwordHash });
      const token = signToken(user.id);
      res.json({ token, user: { id: user.id, username: user.username } });
    } catch (err: any) {
      console.error("Register error:", err);
      res.status(500).json({ message: "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      const { username, password } = parsed.data;
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ message: "Invalid username or password" });
      }
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ message: "Invalid username or password" });
      }
      const token = signToken(user.id);
      res.json({ token, user: { id: user.id, username: user.username } });
    } catch (err: any) {
      console.error("Login error:", err);
      res.status(500).json({ message: "Login failed" });
    }
  });

  app.get("/api/auth/me", authMiddleware, async (req: Request, res: Response) => {
    const user = (req as any).user;
    res.json({ user: { id: user.id, username: user.username } });
  });

  app.put("/api/auth/password", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      const { currentPassword, newPassword } = parsed.data;
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ message: "Current password is incorrect" });
      }
      const newHash = await bcrypt.hash(newPassword, 12);
      await storage.updateUserPassword(user.id, newHash);
      res.json({ success: true });
    } catch (err: any) {
      console.error("Password change error:", err);
      res.status(500).json({ message: "Failed to change password" });
    }
  });

  app.delete("/api/auth/account", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { password } = req.body;
      if (!password) {
        return res.status(400).json({ message: "Password required" });
      }
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ message: "Invalid password" });
      }
      await storage.deleteUser(user.id);
      res.json({ success: true });
    } catch (err: any) {
      console.error("Account deletion error:", err);
      res.status(500).json({ message: "Failed to delete account" });
    }
  });

  // ── Presets ───────────────────────────────────────────────

  app.get("/api/presets", (_req: Request, res: Response) => {
    res.json({ presets: PERSONALITY_PRESETS });
  });

  // ── Bots CRUD ─────────────────────────────────────────────

  app.post("/api/bots", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const parsed = createBotSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }

      const existingBots = await storage.getBotsByUser(user.id);
      if (existingBots.length >= 1) {
        return res.status(403).json({ message: "You can only create one agent per account" });
      }

      const bot = await storage.createBot({
        userId: user.id,
        botName: parsed.data.botName,
        personalityPrompt: parsed.data.personalityPrompt,
        personalityConfig: parsed.data.personalityConfig || {},
        personalityPreset: parsed.data.personalityPreset || "custom",
        postingIntervalMinutes: parsed.data.postingIntervalMinutes || 120,
        mentionCheckIntervalSeconds: parsed.data.mentionCheckIntervalSeconds || 60,
        transactionCommanderX: parsed.data.transactionCommanderX,
      });

      const keypair = generateWalletKeypair();
      const encryptedKey = encrypt(keypair.privateKey);
      const wallet = await storage.createBotWallet({
        botId: bot.id,
        publicAddress: keypair.publicKey,
        encryptedPrivateKey: encryptedKey,
      });

      await storage.createAuditLog({
        userId: user.id,
        botId: bot.id,
        action: "bot_created",
        details: { botName: bot.botName },
        source: "web",
      });

      res.json({
        bot: {
          ...bot,
          walletAddress: wallet.publicAddress,
        },
      });
    } catch (err: any) {
      console.error("Create bot error:", err);
      res.status(500).json({ message: "Failed to create agent" });
    }
  });

  app.get("/api/bots", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botsWithDetails = await storage.getBotsByUserWithDetails(user.id);
      res.json({ bots: botsWithDetails });
    } catch (err: any) {
      console.error("Get bots error:", err);
      res.status(500).json({ message: "Failed to fetch agents" });
    }
  });

  app.get("/api/bots/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) {
        return res.status(400).json({ message: "Invalid bot ID" });
      }
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }
      const wallet = await storage.getBotWallet(bot.id);
      const xAccount = await storage.getBotXAccount(bot.id);
      res.json({
        bot: {
          ...bot,
          walletAddress: wallet?.publicAddress || null,
          xUsername: xAccount?.xUsername || null,
          xProfileImageUrl: xAccount?.xProfileImageUrl || null,
          solBalance: "0.000000000",
        },
      });
    } catch (err: any) {
      console.error("Get bot error:", err);
      res.status(500).json({ message: "Failed to fetch agent" });
    }
  });

  app.put("/api/bots/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) {
        return res.status(400).json({ message: "Invalid bot ID" });
      }
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }

      const parsed = updateBotSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }

      const updated = await storage.updateBot(botId, parsed.data as any);

      await storage.createAuditLog({
        userId: user.id,
        botId: bot.id,
        action: "settings_updated",
        details: parsed.data,
        source: "web",
      });

      res.json({ bot: updated });
    } catch (err: any) {
      console.error("Update bot error:", err);
      res.status(500).json({ message: "Failed to update agent" });
    }
  });

  app.delete("/api/bots/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) {
        return res.status(400).json({ message: "Invalid bot ID" });
      }
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }
      await storage.deleteBot(botId);
      await storage.createAuditLog({
        userId: user.id,
        botId: bot.id,
        action: "bot_deleted",
        details: { botName: bot.botName },
        source: "web",
      });
      res.json({ success: true });
    } catch (err: any) {
      console.error("Delete bot error:", err);
      res.status(500).json({ message: "Failed to delete agent" });
    }
  });

  // ── Bot Status ────────────────────────────────────────────

  app.post("/api/bots/:id/pause", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }
      if (bot.status === "paused") {
        return res.status(400).json({ message: "Bot is already paused" });
      }
      await storage.updateBot(botId, { status: "paused" } as any);
      await storage.createAuditLog({
        userId: user.id, botId: bot.id, action: "bot_paused", source: "web",
      });
      res.json({ success: true });
    } catch (err: any) {
      console.error("Pause bot error:", err);
      res.status(500).json({ message: "Failed to pause agent" });
    }
  });

  app.post("/api/bots/:id/resume", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }
      if (bot.status === "active") {
        return res.status(400).json({ message: "Bot is already active" });
      }
      const xAccount = await storage.getBotXAccount(botId);
      if (!xAccount) {
        return res.status(400).json({ message: "Connect an 𝕏 account before activating your agent" });
      }
      await storage.updateBot(botId, { status: "active" } as any);
      await storage.createAuditLog({
        userId: user.id, botId: bot.id, action: "bot_resumed", source: "web",
      });
      res.json({ success: true });
    } catch (err: any) {
      console.error("Resume bot error:", err);
      res.status(500).json({ message: "Failed to resume agent" });
    }
  });

  // ── Wallet ────────────────────────────────────────────────

  app.get("/api/bots/:id/wallet", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }
      const wallet = await storage.getBotWallet(botId);
      res.json({
        wallet: {
          publicAddress: wallet?.publicAddress || null,
          chain: wallet?.chain || "solana",
        },
      });
    } catch (err: any) {
      console.error("Get wallet error:", err);
      res.status(500).json({ message: "Failed to fetch wallet" });
    }
  });

  app.get("/api/bots/:id/wallet/balances", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }
      const wallet = await storage.getBotWallet(botId);
      if (!wallet) {
        return res.status(404).json({ message: "Wallet not found" });
      }

      const heliusApiKey = process.env.HELIUS_API_KEY;
      if (!heliusApiKey) {
        return res.json({
          solBalance: "0",
          solUsdValue: 0,
          tokens: [],
          lastUpdated: new Date().toISOString(),
          notice: "Helius API key not configured",
        });
      }

      const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
      const response = await fetch(heliusUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "moltcook-balance",
          method: "getAssetsByOwner",
          params: {
            ownerAddress: wallet.publicAddress,
            page: 1,
            limit: 100,
            displayOptions: {
              showFungible: true,
              showNativeBalance: true,
            },
          },
        }),
      });

      if (!response.ok) {
        console.error("Helius API error:", response.status, response.statusText);
        return res.json({
          solBalance: "0",
          solUsdValue: 0,
          tokens: [],
          lastUpdated: new Date().toISOString(),
          notice: "Balance service temporarily unavailable",
        });
      }

      const data = await response.json();
      const result = data.result || {};

      const nativeBalance = result.nativeBalance || {};
      const solLamports = nativeBalance.lamports || 0;
      const solBalance = (solLamports / 1e9).toFixed(9);
      const solUsdValue = nativeBalance.price_per_sol
        ? (solLamports / 1e9) * nativeBalance.price_per_sol
        : 0;

      const tokens: any[] = [];
      const items = result.items || [];
      for (const item of items) {
        if (item.interface === "FungibleToken" || item.interface === "FungibleAsset") {
          const tokenInfo = item.token_info || {};
          const content = item.content || {};
          const metadata = content.metadata || {};
          const links = content.links || {};
          const files = content.files || [];

          const logoUrl = links.image || (files.length > 0 ? files[0].uri : null);
          const decimals = tokenInfo.decimals || 0;
          const rawBalance = tokenInfo.balance || 0;
          const balance = rawBalance / Math.pow(10, decimals);
          const pricePerToken = tokenInfo.price_info?.price_per_token || 0;
          const usdValue = balance * pricePerToken;

          if (balance > 0) {
            tokens.push({
              mint: item.id,
              name: metadata.name || "Unknown Token",
              symbol: metadata.symbol || "???",
              logoUrl,
              balance: balance.toString(),
              decimals,
              usdValue,
              pricePerToken,
            });
          }
        }
      }

      tokens.sort((a, b) => b.usdValue - a.usdValue);

      res.json({
        solBalance,
        solUsdValue,
        tokens,
        lastUpdated: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("Get balances error:", err);
      res.status(500).json({ message: "Failed to fetch balances" });
    }
  });

  // ── Withdraw ──────────────────────────────────────────────

  app.post("/api/bots/:id/wallet/withdraw", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }

      const parsed = withdrawSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }

      const { destinationAddress, amountSol } = parsed.data;

      if (!isValidSolanaAddress(destinationAddress)) {
        return res.status(400).json({ message: "Invalid Solana destination address" });
      }

      const wallet = await storage.getBotWallet(botId);
      if (!wallet) {
        return res.status(404).json({ message: "Wallet not found" });
      }

      const withdrawal = await storage.createWithdrawal({
        botId,
        destinationAddress,
        amountSol: amountSol.toString(),
        triggeredBy: "dashboard",
      });

      await storage.createAuditLog({
        userId: user.id, botId, action: "withdrawal_requested",
        details: { amount: amountSol, destination: destinationAddress, withdrawalId: withdrawal.id },
        source: "web",
      });

      res.json({ withdrawal });
    } catch (err: any) {
      console.error("Withdraw error:", err);
      res.status(500).json({ message: "Failed to process withdrawal" });
    }
  });

  // ── Trading ───────────────────────────────────────────────

  app.post("/api/bots/:id/trade", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }

      const parsed = tradeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }

      const { action, tokenMint, amountSol, amountTokens, tokenSymbol } = parsed.data;

      const trade = await storage.createTrade({
        botId,
        tradeType: action,
        tokenMint,
        tokenSymbol: tokenSymbol || null,
        amountSol: amountSol?.toString(),
        amountTokens: amountTokens?.toString(),
        triggeredBy: "dashboard",
      });

      await storage.createAuditLog({
        userId: user.id, botId, action: `trade_${action}`,
        details: { tokenMint, amountSol, amountTokens, tradeId: trade.id },
        source: "web",
      });

      res.json({ trade });
    } catch (err: any) {
      console.error("Trade error:", err);
      res.status(500).json({ message: "Failed to process trade" });
    }
  });

  app.get("/api/bots/:id/trades", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }
      const botTrades = await storage.getTradesByBot(botId);
      res.json({ trades: botTrades });
    } catch (err: any) {
      console.error("Get trades error:", err);
      res.status(500).json({ message: "Failed to fetch trades" });
    }
  });

  // ── Posts & Mentions ──────────────────────────────────────

  app.get("/api/bots/:id/posts", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }
      const botPosts = await storage.getPostsByBot(botId);
      res.json({ posts: botPosts });
    } catch (err: any) {
      console.error("Get posts error:", err);
      res.status(500).json({ message: "Failed to fetch posts" });
    }
  });

  app.get("/api/bots/:id/mentions", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }
      const botMentions = await storage.getMentionsByBot(botId);
      res.json({ mentions: botMentions });
    } catch (err: any) {
      console.error("Get mentions error:", err);
      res.status(500).json({ message: "Failed to fetch mentions" });
    }
  });

  // ── Activity ──────────────────────────────────────────────

  app.get("/api/bots/:id/activity", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }
      const logs = await storage.getAuditLogsByBot(botId);
      res.json({ logs });
    } catch (err: any) {
      console.error("Get activity error:", err);
      res.status(500).json({ message: "Failed to fetch activity" });
    }
  });

  app.get("/api/activity/recent", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const logs = await storage.getRecentActivityByUser(user.id, 20);
      res.json({ logs });
    } catch (err: any) {
      console.error("Get recent activity error:", err);
      res.status(500).json({ message: "Failed to fetch activity" });
    }
  });

  app.get("/api/agents/all", authMiddleware, async (_req: Request, res: Response) => {
    try {
      const allBots = await storage.getAllBots(50);
      res.json({ bots: allBots });
    } catch (err: any) {
      console.error("Get all agents error:", err);
      res.status(500).json({ message: "Failed to fetch agents" });
    }
  });

  app.get("/api/activity/global", authMiddleware, async (_req: Request, res: Response) => {
    try {
      const items = await storage.getCombinedActivity(30);
      res.json({ items });
    } catch (err: any) {
      console.error("Get global activity error:", err);
      res.status(500).json({ message: "Failed to fetch activity" });
    }
  });

  app.get("/api/activity/public", async (_req: Request, res: Response) => {
    try {
      const items = await storage.getCombinedActivity(15);
      res.json({ items });
    } catch (err: any) {
      console.error("Get public activity error:", err);
      res.status(500).json({ message: "Failed to fetch activity" });
    }
  });

  // ── X OAuth Scaffolding ───────────────────────────────────

  app.post("/api/bots/:id/x/connect", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }

      const clientId = process.env.X_CLIENT_ID;
      const redirectUri = process.env.X_REDIRECT_URI;
      if (!clientId || !redirectUri) {
        return res.status(503).json({ message: "𝕏 integration not configured. Please set X_CLIENT_ID and X_REDIRECT_URI." });
      }

      const state = Buffer.from(JSON.stringify({ botId, userId: user.id })).toString("base64url");
      const scopes = "tweet.read tweet.write users.read offline.access";
      const authUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}&code_challenge=challenge&code_challenge_method=plain`;

      res.json({ authUrl });
    } catch (err: any) {
      console.error("X connect error:", err);
      res.status(500).json({ message: "Failed to initiate 𝕏 connection" });
    }
  });

  app.get("/api/x/callback", async (req: Request, res: Response) => {
    try {
      const { code, state } = req.query;
      if (!code || !state) {
        return res.status(400).json({ message: "Missing code or state" });
      }

      const clientId = process.env.X_CLIENT_ID;
      const clientSecret = process.env.X_CLIENT_SECRET;
      const redirectUri = process.env.X_REDIRECT_URI;
      if (!clientId || !clientSecret || !redirectUri) {
        return res.status(503).json({ message: "𝕏 integration not configured" });
      }

      let stateData: { botId: number; userId: number };
      try {
        stateData = JSON.parse(Buffer.from(state as string, "base64url").toString());
      } catch {
        return res.status(400).json({ message: "Invalid state parameter" });
      }

      const tokenResponse = await fetch("https://api.twitter.com/2/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          code: code as string,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          code_verifier: "challenge",
        }),
      });

      if (!tokenResponse.ok) {
        console.error("X token exchange failed:", await tokenResponse.text());
        return res.status(400).json({ message: "Failed to exchange authorization code" });
      }

      const tokenData = await tokenResponse.json();
      const { access_token, refresh_token, expires_in } = tokenData;

      const userResponse = await fetch("https://api.twitter.com/2/users/me?user.fields=profile_image_url", {
        headers: { Authorization: `Bearer ${access_token}` },
      });

      if (!userResponse.ok) {
        return res.status(400).json({ message: "Failed to fetch 𝕏 user info" });
      }

      const userData = await userResponse.json();
      const xUser = userData.data;

      const encryptedAccessToken = encrypt(access_token);
      const encryptedRefreshToken = encrypt(refresh_token);
      const tokenExpiresAt = new Date(Date.now() + (expires_in * 1000));

      await storage.upsertBotXAccount({
        botId: stateData.botId,
        xUserId: xUser.id,
        xUsername: xUser.username,
        xProfileImageUrl: xUser.profile_image_url || null,
        encryptedAccessToken,
        encryptedRefreshToken,
        tokenExpiresAt,
      });

      await storage.createAuditLog({
        userId: stateData.userId,
        botId: stateData.botId,
        action: "x_account_connected",
        details: { xUsername: xUser.username },
        source: "web",
      });

      res.redirect(`/#/bot/${stateData.botId}?x_connected=true`);
    } catch (err: any) {
      console.error("X callback error:", err);
      res.status(500).json({ message: "Failed to complete 𝕏 connection" });
    }
  });

  app.post("/api/bots/:id/x/disconnect", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const botId = getParamId(req.params.id);
      if (isNaN(botId)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = await storage.getBot(botId);
      if (!bot || bot.userId !== user.id) {
        return res.status(404).json({ message: "Bot not found" });
      }

      await storage.deleteBotXAccount(botId);

      if (bot.status === "active") {
        await storage.updateBot(botId, { status: "paused" } as any);
      }

      await storage.createAuditLog({
        userId: user.id,
        botId,
        action: "x_account_disconnected",
        source: "web",
      });

      res.json({ success: true });
    } catch (err: any) {
      console.error("X disconnect error:", err);
      res.status(500).json({ message: "Failed to disconnect 𝕏 account" });
    }
  });

  // ── Crypto Price Analysis (CoinGecko + DexScreener) ────────

  app.get("/api/crypto/search", authMiddleware, async (req: Request, res: Response) => {
    try {
      const query = (req.query.q as string || "").trim();
      if (!query || query.length < 2) {
        return res.status(400).json({ message: "Search query must be at least 2 characters" });
      }

      const response = await fetch(
        `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`,
        { headers: { "Accept": "application/json" } }
      );

      if (!response.ok) {
        return res.json({ coins: [] });
      }

      const data = await response.json();
      const coins = (data.coins || []).slice(0, 15).map((c: any) => ({
        id: c.id,
        name: c.name,
        symbol: c.symbol,
        thumb: c.thumb,
        marketCapRank: c.market_cap_rank,
      }));

      res.json({ coins });
    } catch (err: any) {
      console.error("Crypto search error:", err);
      res.status(500).json({ message: "Search failed" });
    }
  });

  app.get("/api/crypto/price/:coinId", authMiddleware, async (req: Request, res: Response) => {
    try {
      const coinId = Array.isArray(req.params.coinId) ? req.params.coinId[0] : req.params.coinId;
      if (!coinId) return res.status(400).json({ message: "Coin ID required" });

      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=true`,
        { headers: { "Accept": "application/json" } }
      );

      if (!response.ok) {
        return res.status(404).json({ message: "Token not found" });
      }

      const data = await response.json();
      const md = data.market_data || {};

      res.json({
        id: data.id,
        name: data.name,
        symbol: data.symbol,
        image: data.image?.small || data.image?.thumb,
        currentPrice: md.current_price?.usd || 0,
        marketCap: md.market_cap?.usd || 0,
        marketCapRank: data.market_cap_rank,
        totalVolume: md.total_volume?.usd || 0,
        high24h: md.high_24h?.usd || 0,
        low24h: md.low_24h?.usd || 0,
        priceChange24h: md.price_change_percentage_24h || 0,
        priceChange7d: md.price_change_percentage_7d || 0,
        priceChange30d: md.price_change_percentage_30d || 0,
        ath: md.ath?.usd || 0,
        athChangePercentage: md.ath_change_percentage?.usd || 0,
        circulatingSupply: md.circulating_supply || 0,
        totalSupply: md.total_supply || 0,
        sparkline7d: md.sparkline_7d?.price || [],
        lastUpdated: data.last_updated,
      });
    } catch (err: any) {
      console.error("Crypto price error:", err);
      res.status(500).json({ message: "Failed to fetch price data" });
    }
  });

  app.get("/api/crypto/trending", authMiddleware, async (req: Request, res: Response) => {
    try {
      const response = await fetch(
        "https://api.coingecko.com/api/v3/search/trending",
        { headers: { "Accept": "application/json" } }
      );

      if (!response.ok) {
        return res.json({ coins: [] });
      }

      const data = await response.json();
      const coins = (data.coins || []).slice(0, 10).map((c: any) => ({
        id: c.item?.id,
        name: c.item?.name,
        symbol: c.item?.symbol,
        thumb: c.item?.thumb,
        marketCapRank: c.item?.market_cap_rank,
        priceChange24h: c.item?.data?.price_change_percentage_24h?.usd,
        price: c.item?.data?.price,
        sparkline: c.item?.data?.sparkline,
      }));

      res.json({ coins });
    } catch (err: any) {
      console.error("Trending error:", err);
      res.status(500).json({ message: "Failed to fetch trending" });
    }
  });

  app.get("/api/crypto/dex/:tokenAddress", authMiddleware, async (req: Request, res: Response) => {
    try {
      const tokenAddress = Array.isArray(req.params.tokenAddress) ? req.params.tokenAddress[0] : req.params.tokenAddress;
      if (!tokenAddress) return res.status(400).json({ message: "Token address required" });

      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`,
        { headers: { "Accept": "application/json" } }
      );

      if (!response.ok) {
        return res.json({ pairs: [] });
      }

      const data = await response.json();
      const pairs = (data.pairs || []).slice(0, 10).map((p: any) => ({
        chainId: p.chainId,
        dexId: p.dexId,
        pairAddress: p.pairAddress,
        baseToken: {
          address: p.baseToken?.address,
          name: p.baseToken?.name,
          symbol: p.baseToken?.symbol,
        },
        quoteToken: {
          address: p.quoteToken?.address,
          name: p.quoteToken?.name,
          symbol: p.quoteToken?.symbol,
        },
        priceUsd: p.priceUsd,
        priceNative: p.priceNative,
        volume24h: p.volume?.h24 || 0,
        volume6h: p.volume?.h6 || 0,
        volume1h: p.volume?.h1 || 0,
        priceChange5m: p.priceChange?.m5 || 0,
        priceChange1h: p.priceChange?.h1 || 0,
        priceChange6h: p.priceChange?.h6 || 0,
        priceChange24h: p.priceChange?.h24 || 0,
        liquidity: p.liquidity?.usd || 0,
        fdv: p.fdv || 0,
        txns24h: {
          buys: p.txns?.h24?.buys || 0,
          sells: p.txns?.h24?.sells || 0,
        },
        url: p.url,
        info: p.info ? {
          imageUrl: p.info.imageUrl,
          websites: p.info.websites || [],
          socials: p.info.socials || [],
        } : null,
      }));

      res.json({ pairs });
    } catch (err: any) {
      console.error("DexScreener error:", err);
      res.status(500).json({ message: "Failed to fetch DEX data" });
    }
  });

  app.get("/api/crypto/dex/search/:query", authMiddleware, async (req: Request, res: Response) => {
    try {
      const query = Array.isArray(req.params.query) ? req.params.query[0] : req.params.query;
      if (!query || query.length < 2) return res.status(400).json({ message: "Query too short" });

      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
        { headers: { "Accept": "application/json" } }
      );

      if (!response.ok) {
        return res.json({ pairs: [] });
      }

      const data = await response.json();
      const pairs = (data.pairs || [])
        .filter((p: any) => p.chainId === "solana")
        .slice(0, 15)
        .map((p: any) => ({
          chainId: p.chainId,
          dexId: p.dexId,
          pairAddress: p.pairAddress,
          baseToken: {
            address: p.baseToken?.address,
            name: p.baseToken?.name,
            symbol: p.baseToken?.symbol,
          },
          quoteToken: {
            address: p.quoteToken?.address,
            name: p.quoteToken?.name,
            symbol: p.quoteToken?.symbol,
          },
          priceUsd: p.priceUsd,
          volume24h: p.volume?.h24 || 0,
          priceChange24h: p.priceChange?.h24 || 0,
          liquidity: p.liquidity?.usd || 0,
          fdv: p.fdv || 0,
          url: p.url,
          info: p.info ? { imageUrl: p.info.imageUrl } : null,
        }));

      res.json({ pairs });
    } catch (err: any) {
      console.error("DexScreener search error:", err);
      res.status(500).json({ message: "Failed to search DEX" });
    }
  });

  return httpServer;
}
