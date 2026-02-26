import { sql } from "drizzle-orm";
import { db } from "./db";
import { eq, desc, and } from "drizzle-orm";
import {
  users, bots, trades
} from "@shared/schema";

export class AnalyticsService {
  /**
   * Get 24h trading volume for a specific bot
   */
  async get24hVolume(botId: number): Promise<{ buyVolume: number; sellVolume: number; totalVolume: number }> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const botTrades = await db.select()
      .from(trades)
      .where(
        and(
          eq(trades.botId, botId),
          eq(trades.status, "completed"),
          sql`${trades.createdAt} >= ${twentyFourHoursAgo}`
        )
      );

    let buyVolume = 0;
    let sellVolume = 0;

    for (const trade of botTrades) {
      const amount = parseFloat(trade.amountSol || "0");
      if (trade.tradeType === "buy") {
        buyVolume += amount;
      } else {
        sellVolume += amount;
      }
    }

    return {
      buyVolume,
      sellVolume,
      totalVolume: buyVolume + sellVolume
    };
  }

  /**
   * Get bot performance metrics
   */
  async getBotPerformance(botId: number) {
    const botTrades = await db.select()
      .from(trades)
      .where(eq(trades.botId, botId))
      .orderBy(desc(trades.createdAt));

    const totalTrades = botTrades.length;
    const successfulTrades = botTrades.filter(t => t.status === "completed").length;
    const failedTrades = botTrades.filter(t => t.status === "failed").length;

    return {
      totalTrades,
      successfulTrades,
      failedTrades,
      successRate: totalTrades > 0 ? (successfulTrades / totalTrades) * 100 : 0,
    };
  }

  /**
   * Get aggregate platform stats
   */
  async getPlatformStats() {
    const [allBots, allTrades, allUsers] = await Promise.all([
      db.select().from(bots),
      db.select().from(trades).where(eq(trades.status, "completed")),
      db.select().from(users),
    ]);

    const totalSolVolume = allTrades.reduce((acc, t) => acc + parseFloat(t.amountSol || "0"), 0);

    return {
      totalAgents: allBots.length,
      activeAgents: allBots.filter(b => b.status === "active").length,
      totalTrades: allTrades.length,
      totalSolVolume,
      totalUsers: allUsers.length,
    };
  }
}

export const analyticsService = new AnalyticsService();
