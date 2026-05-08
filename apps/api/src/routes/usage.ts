import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma';
import { authenticate, requirePlan } from '../middleware/authenticate';
import { Plan } from '@prisma/client';
import { calcCost, PRICING } from '../lib/pricing';
import { recalcDailyStats } from '../services/statsService';
import { getInsight } from '../services/insightService';
import { getWeeklySummary } from '../services/weeklyDigest';

export const usageRoutes: FastifyPluginAsync = async (app) => {

  // POST /usage/sync — called from extension every ~10s, idempotent
  app.post<{
    Body: {
      sessions: Array<{
        sessionId: string;
        model: string;
        aiProvider?: string;
        projectName: string;
        workspacePath?: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        turns: number;
        vsCodeVersion?: string;
        extensionVersion?: string;
        osType?: string;
        timestamp: number;
      }>;
    };
  }>('/sync', { preHandler: authenticate }, async (req, reply) => {
    const { sessions } = req.body;
    const userId = req.userId;

    await Promise.all(sessions.map(async (s) => {
      const cost = calcCost({
        model: s.model,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheWriteTokens: s.cacheWriteTokens,
      });

      await prisma.usageSession.upsert({
        where: { id: s.sessionId },
        update: {
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          cacheReadTokens: s.cacheReadTokens,
          cacheWriteTokens: s.cacheWriteTokens,
          totalTokens: s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens,
          inputCostUsd: cost.input,
          outputCostUsd: cost.output,
          cacheReadCostUsd: cost.cacheRead,
          cacheWriteCostUsd: cost.cacheWrite,
          totalCostUsd: cost.total,
          turnCount: s.turns,
          lastUpdatedAt: new Date(),
        },
        create: {
          id: s.sessionId,
          userId,
          model: s.model,
          aiProvider: s.aiProvider || 'claude',
          projectName: s.projectName || 'Unknown',
          workspacePath: s.workspacePath,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          cacheReadTokens: s.cacheReadTokens,
          cacheWriteTokens: s.cacheWriteTokens,
          totalTokens: s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens,
          inputCostUsd: cost.input,
          outputCostUsd: cost.output,
          cacheReadCostUsd: cost.cacheRead,
          cacheWriteCostUsd: cost.cacheWrite,
          totalCostUsd: cost.total,
          turnCount: s.turns,
          vsCodeVersion: s.vsCodeVersion,
          extensionVersion: s.extensionVersion,
          osType: s.osType,
          sessionStartedAt: new Date(s.timestamp),
        },
      });

      const date = new Date(s.timestamp).toISOString().slice(0, 10);
      recalcDailyStats(userId, date).catch(console.error);
    }));

    checkBudgetAlerts(userId).catch(console.error);

    return reply.send({ ok: true, synced: sessions.length });
  });

  // GET /usage/summary
  app.get('/summary', { preHandler: authenticate }, async (req, reply) => {
    const userId = req.userId;
    const historyDays = getHistoryDays(req.userPlan);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - historyDays);

    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);

    const [totalAgg, sessionCount, todayStats, monthCost] = await Promise.all([
      prisma.usageSession.aggregate({
        where: { userId, sessionStartedAt: { gte: cutoff } },
        _sum: { totalCostUsd: true, totalTokens: true, inputTokens: true, outputTokens: true },
        _count: true,
      }),
      prisma.usageSession.count({ where: { userId } }),
      prisma.dailyStats.aggregate({
        where: { userId, date: today },
        _sum: { totalCostUsd: true, inputTokens: true, outputTokens: true },
      }),
      prisma.dailyStats.aggregate({
        where: { userId, date: { startsWith: month } },
        _sum: { totalCostUsd: true },
      }),
    ]);

    const userRecord = await prisma.user.findUnique({
      where: { id: userId },
      select: { trialEndsAt: true, plan: true },
    });
    const isOnTrial = userRecord?.plan === 'FREE' && userRecord?.trialEndsAt && userRecord.trialEndsAt > new Date();
    const trialDaysLeft = isOnTrial
      ? Math.ceil((userRecord!.trialEndsAt!.getTime() - Date.now()) / 86_400_000)
      : null;

    return reply.send({
      totalCostUsd:      totalAgg._sum.totalCostUsd    || 0,
      totalTokens:       totalAgg._sum.totalTokens     || 0,
      totalInputTokens:  totalAgg._sum.inputTokens     || 0,
      totalOutputTokens: totalAgg._sum.outputTokens    || 0,
      sessionCount,
      todayCostUsd:      todayStats._sum.totalCostUsd  || 0,
      todayInputTokens:  todayStats._sum.inputTokens   || 0,
      todayOutputTokens: todayStats._sum.outputTokens  || 0,
      monthCostUsd:      monthCost._sum.totalCostUsd   || 0,
      plan:              req.userPlan,
      historyDays,
      trialDaysLeft,
    });
  });

  // GET /usage/daily?from=2025-04-01&to=2025-05-01
  app.get<{ Querystring: { from?: string; to?: string; projectName?: string } }>(
    '/daily',
    { preHandler: authenticate },
    async (req, reply) => {
      const userId = req.userId;
      const historyDays = getHistoryDays(req.userPlan);
      const maxFrom = new Date();
      maxFrom.setDate(maxFrom.getDate() - historyDays);

      const from = req.query.from
        ? new Date(Math.max(new Date(req.query.from).getTime(), maxFrom.getTime())).toISOString().slice(0, 10)
        : maxFrom.toISOString().slice(0, 10);

      const to = req.query.to || new Date().toISOString().slice(0, 10);

      const stats = await prisma.dailyStats.findMany({
        where: {
          userId,
          date: { gte: from, lte: to },
          ...(req.query.projectName ? { projectName: req.query.projectName } : {}),
        },
        orderBy: { date: 'asc' },
      });

      return reply.send(stats);
    }
  );

  // GET /usage/sessions
  app.get<{ Querystring: { limit?: string; offset?: string; projectName?: string } }>(
    '/sessions',
    { preHandler: authenticate },
    async (req, reply) => {
      const userId = req.userId;
      const limit = Math.min(parseInt(req.query.limit || '20'), 100);
      const offset = parseInt(req.query.offset || '0');
      const historyDays = getHistoryDays(req.userPlan);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - historyDays);

      const [sessions, total] = await Promise.all([
        prisma.usageSession.findMany({
          where: {
            userId,
            sessionStartedAt: { gte: cutoff },
            ...(req.query.projectName ? { projectName: req.query.projectName } : {}),
          },
          orderBy: { sessionStartedAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.usageSession.count({
          where: { userId, sessionStartedAt: { gte: cutoff } },
        }),
      ]);

      return reply.send({ sessions, total, limit, offset });
    }
  );

  // GET /usage/projects
  app.get('/projects', { preHandler: authenticate }, async (req, reply) => {
    const projects = await prisma.usageSession.groupBy({
      by: ['projectName'],
      where: { userId: req.userId },
      _sum: { totalCostUsd: true, totalTokens: true },
      _count: true,
      orderBy: { _sum: { totalCostUsd: 'desc' } },
    });
    return reply.send(projects);
  });

  // GET /usage/export (Pro+)
  app.get(
    '/export',
    { preHandler: [authenticate, requirePlan(Plan.PRO)] },
    async (req, reply) => {
      const sessions = await prisma.usageSession.findMany({
        where: { userId: req.userId },
        orderBy: { sessionStartedAt: 'desc' },
      });

      const csv = [
        'date,project,model,inputTokens,outputTokens,cacheReadTokens,totalCost,turns',
        ...sessions.map(s => [
          s.sessionStartedAt.toISOString(),
          s.projectName,
          s.model,
          s.inputTokens,
          s.outputTokens,
          s.cacheReadTokens,
          s.totalCostUsd.toFixed(6),
          s.turnCount,
        ].join(',')),
      ].join('\n');

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', 'attachment; filename="token-usage.csv"');
      return reply.send(csv);
    }
  );
  // ── POST /usage/pre-send-count ────────────────────────────────────────────
  // Called by SDK/extension before sending a prompt. Logs the pre-send count
  // and returns whether to show a warning.
  app.post<{
    Body: {
      sessionId?: string;
      model: string;
      inputTokens: number;
    };
  }>('/pre-send-count', { preHandler: authenticate }, async (req, reply) => {
    const { sessionId, model, inputTokens } = req.body;
    const userId = req.userId;

    // Calc cost for this input
    const { input: inputCost } = calcCost({
      model, inputTokens, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    });

    // Get user's average input cost over last 30 sessions
    const recent = await prisma.usageSession.aggregate({
      where: { userId, sessionStartedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      _avg: { inputCostUsd: true },
      _count: true,
    });
    const avgInputCost = recent._avg.inputCostUsd ?? 0.01;
    const warningThreshold = Math.max(avgInputCost * 4, 0.05);
    const shouldWarn = inputCost > warningThreshold;

    // Persist on the session row if we have one
    if (sessionId) {
      await prisma.usageSession.updateMany({
        where: { id: sessionId, userId },
        data: { preSendInputTokens: inputTokens, preSendInputCost: inputCost, warningShown: shouldWarn },
      });
    }

    return reply.send({ inputTokens, inputCost, warningThreshold, shouldWarn });
  });

  // ── GET /usage/model-comparison/:sessionId ────────────────────────────────
  // Returns what the same tokens would have cost on every other model.
  app.get<{ Params: { sessionId: string } }>(
    '/model-comparison/:sessionId',
    { preHandler: [authenticate, requirePlan(Plan.PRO)] },
    async (req, reply) => {
      const session = await prisma.usageSession.findFirst({
        where: { id: req.params.sessionId, userId: req.userId },
      });
      if (!session) return reply.status(404).send({ error: 'Session not found' });

      const tokens = {
        inputTokens:      session.inputTokens,
        outputTokens:     session.outputTokens,
        cacheReadTokens:  session.cacheReadTokens,
        cacheWriteTokens: session.cacheWriteTokens,
      };

      const models = Object.keys(PRICING).filter(m => m !== session.model);
      const comparisons = models.map(m => {
        const cost = calcCost({ model: m, ...tokens });
        const actualCost = session.totalCostUsd;
        return {
          model:     m,
          totalCost: cost.total,
          savingPct: actualCost > 0
            ? Math.round((1 - cost.total / actualCost) * 100)
            : 0,
        };
      }).sort((a, b) => a.totalCost - b.totalCost);

      return reply.send({
        actualModel:  session.model,
        actualCost:   session.totalCostUsd,
        inputTokens:  session.inputTokens,
        outputTokens: session.outputTokens,
        comparisons,
      });
    }
  );

  // ── GET /usage/weekly-summary ─────────────────────────────────────────────
  app.get('/weekly-summary', { preHandler: [authenticate, requirePlan(Plan.PRO)] }, async (req, reply) => {
    const summary = await getWeeklySummary(req.userId);
    return reply.send(summary);
  });

  // ── GET /usage/insights ───────────────────────────────────────────────────
  app.get('/insights', { preHandler: [authenticate, requirePlan(Plan.PRO)] }, async (req, reply) => {
    const insight = await getInsight(req.userId);
    return reply.send({ insight });
  });

};

function getHistoryDays(_plan: Plan): number {
  return 9999; // All plans get full history
}

async function checkBudgetAlerts(userId: string) {
  const budget = await prisma.budget.findUnique({
    where: { userId_type: { userId, type: 'daily' } },
  });
  if (!budget || !budget.active) return;

  const today = new Date().toISOString().slice(0, 10);
  const todaySpend = await prisma.dailyStats.aggregate({
    where: { userId, date: today },
    _sum: { totalCostUsd: true },
  });

  const spent = todaySpend._sum.totalCostUsd || 0;
  const alertThreshold = budget.limitUsd * budget.alertAt;

  if (spent >= alertThreshold && spent < budget.limitUsd) {
    // TODO: send email via Resend + create in-app notification
    console.log(`Budget alert for user ${userId}: $${spent.toFixed(4)} of $${budget.limitUsd}`);
  }
}
