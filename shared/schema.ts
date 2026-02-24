import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, boolean, timestamp, jsonb, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 30 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const bots = pgTable("bots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  botName: varchar("bot_name", { length: 100 }).notNull(),
  personalityPrompt: text("personality_prompt").notNull(),
  personalityConfig: jsonb("personality_config").default({}),
  personalityPreset: varchar("personality_preset", { length: 50 }).default("custom"),
  postingIntervalMinutes: integer("posting_interval_minutes").default(120),
  mentionCheckIntervalSeconds: integer("mention_check_interval_seconds").default(60),
  transactionCommanderX: varchar("transaction_commander_x", { length: 100 }).notNull(),
  status: varchar("status", { length: 20 }).default("paused"),
  lastMentionId: varchar("last_mention_id", { length: 100 }),
  lastPostAt: timestamp("last_post_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const botXAccounts = pgTable("bot_x_accounts", {
  id: serial("id").primaryKey(),
  botId: integer("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }).unique(),
  xUserId: varchar("x_user_id", { length: 100 }),
  xUsername: varchar("x_username", { length: 100 }),
  xProfileImageUrl: text("x_profile_image_url"),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  tokenExpiresAt: timestamp("token_expires_at"),
  connectedAt: timestamp("connected_at").defaultNow(),
});

export const botWallets = pgTable("bot_wallets", {
  id: serial("id").primaryKey(),
  botId: integer("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }).unique(),
  chain: varchar("chain", { length: 20 }).default("solana"),
  publicAddress: varchar("public_address", { length: 100 }).notNull(),
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  botId: integer("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  tradeType: varchar("trade_type", { length: 10 }).notNull(),
  tokenMint: varchar("token_mint", { length: 100 }).notNull(),
  tokenSymbol: varchar("token_symbol", { length: 20 }),
  amountSol: numeric("amount_sol", { precision: 20, scale: 9 }),
  amountTokens: numeric("amount_tokens", { precision: 30, scale: 9 }),
  txHash: varchar("tx_hash", { length: 200 }),
  triggeredBy: varchar("triggered_by", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).default("pending"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const withdrawals = pgTable("withdrawals", {
  id: serial("id").primaryKey(),
  botId: integer("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  destinationAddress: varchar("destination_address", { length: 100 }).notNull(),
  amountSol: numeric("amount_sol", { precision: 20, scale: 9 }).notNull(),
  txHash: varchar("tx_hash", { length: 200 }),
  triggeredBy: varchar("triggered_by", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).default("pending"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const botPosts = pgTable("bot_posts", {
  id: serial("id").primaryKey(),
  botId: integer("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  tweetId: varchar("tweet_id", { length: 100 }),
  postType: varchar("post_type", { length: 20 }).default("auto"),
  status: varchar("status", { length: 20 }).default("pending"),
  errorMessage: text("error_message"),
  postedAt: timestamp("posted_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const botMentions = pgTable("bot_mentions", {
  id: serial("id").primaryKey(),
  botId: integer("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  mentionTweetId: varchar("mention_tweet_id", { length: 100 }).notNull().unique(),
  authorXId: varchar("author_x_id", { length: 100 }).notNull(),
  authorXUsername: varchar("author_x_username", { length: 100 }).notNull(),
  mentionText: text("mention_text").notNull(),
  isCommand: boolean("is_command").default(false),
  commandType: varchar("command_type", { length: 20 }),
  commandParsed: jsonb("command_parsed"),
  replyTweetId: varchar("reply_tweet_id", { length: 100 }),
  replyText: text("reply_text"),
  replyStatus: varchar("reply_status", { length: 20 }).default("pending"),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  botId: integer("bot_id"),
  action: varchar("action", { length: 100 }).notNull(),
  details: jsonb("details"),
  source: varchar("source", { length: 20 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  passwordHash: true,
});

export const insertBotSchema = createInsertSchema(bots).pick({
  userId: true,
  botName: true,
  personalityPrompt: true,
  personalityConfig: true,
  personalityPreset: true,
  postingIntervalMinutes: true,
  mentionCheckIntervalSeconds: true,
  transactionCommanderX: true,
});

export const insertTradeSchema = createInsertSchema(trades).pick({
  botId: true,
  tradeType: true,
  tokenMint: true,
  tokenSymbol: true,
  amountSol: true,
  amountTokens: true,
  triggeredBy: true,
});

export const insertWithdrawalSchema = createInsertSchema(withdrawals).pick({
  botId: true,
  destinationAddress: true,
  amountSol: true,
  triggeredBy: true,
});

export const insertAuditLogSchema = createInsertSchema(auditLogs).pick({
  userId: true,
  botId: true,
  action: true,
  details: true,
  source: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertBot = z.infer<typeof insertBotSchema>;
export type Bot = typeof bots.$inferSelect;
export type BotXAccount = typeof botXAccounts.$inferSelect;
export type BotWallet = typeof botWallets.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type Withdrawal = typeof withdrawals.$inferSelect;
export type BotPost = typeof botPosts.$inferSelect;
export type BotMention = typeof botMentions.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type InsertWithdrawal = z.infer<typeof insertWithdrawalSchema>;
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;

export const registerSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(8),
});

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const createBotSchema = z.object({
  botName: z.string().min(1).max(100),
  personalityPrompt: z.string().min(1),
  personalityConfig: z.any().optional(),
  personalityPreset: z.string().optional(),
  postingIntervalMinutes: z.number().min(30).max(240).optional(),
  mentionCheckIntervalSeconds: z.number().optional(),
  transactionCommanderX: z.string().min(1).max(100),
});

export const updateBotSchema = z.object({
  botName: z.string().min(1).max(100).optional(),
  personalityPrompt: z.string().min(1).optional(),
  personalityConfig: z.any().optional(),
  personalityPreset: z.string().optional(),
  postingIntervalMinutes: z.number().min(30).max(240).optional(),
  mentionCheckIntervalSeconds: z.number().optional(),
  transactionCommanderX: z.string().min(1).max(100).optional(),
  status: z.string().optional(),
});

export const withdrawSchema = z.object({
  destinationAddress: z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "Invalid Solana address"),
  amountSol: z.coerce.number().positive().max(1000000),
});

export const tradeSchema = z.object({
  action: z.enum(["buy", "sell"]),
  tokenMint: z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "Invalid token mint address"),
  amountSol: z.coerce.number().positive().max(1000000).optional(),
  amountTokens: z.coerce.number().positive().optional(),
  tokenSymbol: z.string().max(20).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export const APP_NAME = "Moltcook";

export const PERSONALITY_PRESETS = [
  {
    id: "degen_trader",
    name: "Degen Trader",
    description: "Aggressive crypto bro, uses slang, hypes everything",
    prompt: "You are a degen crypto trader bot. You speak in internet slang, use emojis heavily, and always shill SOL ecosystem tokens. You're bullish on everything. Your catchphrase is 'wagmi frens'. You never give financial advice but you hype everything. Keep tweets under 280 chars.",
    config: { tone: "aggressive, hyped", emoji_usage: "heavy", topics: ["solana", "defi", "memes"] },
  },
  {
    id: "wise_analyst",
    name: "Wise Analyst",
    description: "Calm, analytical, uses data and chart references",
    prompt: "You are a wise crypto analyst bot. You speak calmly and analytically, referencing data and charts. You provide balanced takes on the market. You use professional language and avoid hype. Keep tweets under 280 chars.",
    config: { tone: "calm, analytical", emoji_usage: "light", topics: ["analysis", "market", "data"] },
  },
  {
    id: "meme_lord",
    name: "Meme Lord",
    description: "Pure meme energy, jokes about everything",
    prompt: "You are a meme lord crypto bot. Everything is a joke or a meme reference. You reference crypto culture heavily. You're funny, self-deprecating, and never serious. Keep tweets under 280 chars.",
    config: { tone: "funny, memey", emoji_usage: "heavy", topics: ["memes", "crypto culture", "jokes"] },
  },
  {
    id: "news_reporter",
    name: "News Reporter",
    description: "Professional tone, reports crypto news objectively",
    prompt: "You are a professional crypto news reporter bot. You report news objectively with a professional tone. You cite sources when possible and avoid speculation. Keep tweets under 280 chars.",
    config: { tone: "professional, objective", emoji_usage: "none", topics: ["news", "updates", "regulation"] },
  },
  {
    id: "community_builder",
    name: "Community Builder",
    description: "Friendly, supportive, engages with everyone",
    prompt: "You are a friendly community builder bot. You're supportive, encouraging, and engage positively with everyone. You celebrate wins and support during losses. Keep tweets under 280 chars.",
    config: { tone: "friendly, supportive", emoji_usage: "moderate", topics: ["community", "support", "growth"] },
  },
  {
    id: "alpha_hunter",
    name: "Alpha Hunter",
    description: "Mysterious, drops alpha hints, speaks in riddles",
    prompt: "You are a mysterious alpha hunter bot. You drop cryptic hints about potential opportunities. You speak in riddles and metaphors. You're enigmatic and create FOMO. Keep tweets under 280 chars.",
    config: { tone: "mysterious, cryptic", emoji_usage: "light", topics: ["alpha", "opportunities", "hidden gems"] },
  },
  {
    id: "custom",
    name: "Custom",
    description: "Write your own personality prompt",
    prompt: "",
    config: {},
  },
];
