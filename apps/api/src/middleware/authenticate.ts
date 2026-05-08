import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '@clerk/backend';
import { prisma } from '../lib/prisma';
import { verifyJwt } from '../lib/jwt';
import { Plan } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    userPlan: Plan;
    clerkUserId: string;
  }
}

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  // ── Path 1: our own JWT (VS Code extension after /auth/exchange) ──────────
  try {
    const payload = verifyJwt(token);
    const user = await prisma.user.findUnique({
      where:  { id: payload.userId },
      select: { id: true, plan: true, clerkId: true, trialEndsAt: true },
    });
    if (user) {
      const effectivePlan = (user.trialEndsAt && user.trialEndsAt > new Date() && user.plan === Plan.FREE)
        ? Plan.PRO
        : user.plan;
      req.userId      = user.id;
      req.userPlan    = effectivePlan;
      req.clerkUserId = user.clerkId;
      return;
    }
  } catch {
    // Not our JWT — fall through to Clerk verification
  }

  // ── Path 2: Clerk session token (web dashboard) ───────────────────────────
  try {
    const clerkPayload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
      authorizedParties: [process.env.APP_BASE!, 'http://localhost:3000', 'http://localhost:3001'],
    });
    const clerkUserId  = clerkPayload.sub;

    let user = await prisma.user.findUnique({
      where:  { clerkId: clerkUserId },
      select: { id: true, plan: true, clerkId: true, trialEndsAt: true },
    });

    // Auto-provision user if they signed in via Clerk but the webhook hasn't fired yet
    if (!user) {
      const claims = clerkPayload as any;
      const email: string = claims.email ?? claims.primary_email_address ?? '';
      const name: string  = claims.name ?? claims.full_name ?? ([claims.first_name, claims.last_name].filter(Boolean).join(' ') || 'User');
      const avatarUrl: string | null = claims.image_url ?? claims.profile_image_url ?? null;

      user = await prisma.user.upsert({
        where:  { clerkId: clerkUserId },
        update: {},
        create: { clerkId: clerkUserId, email, name, avatarUrl, trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
        select: { id: true, plan: true, clerkId: true, trialEndsAt: true },
      });
    }

    if (!user) return reply.status(401).send({ error: 'User not found' });

    // Active trial → treat as PRO
    const effectivePlan = (user.trialEndsAt && user.trialEndsAt > new Date() && user.plan === Plan.FREE)
      ? Plan.PRO
      : user.plan;

    req.userId      = user.id;
    req.userPlan    = effectivePlan;
    req.clerkUserId = user.clerkId;
  } catch (err) {
    console.error('[auth] Clerk token verification failed:', err);
    return reply.status(401).send({ error: 'Invalid token' });
  }
}

// All features are free — plan checks are disabled
export function requirePlan(_minPlan: Plan) {
  return async (_req: FastifyRequest, _reply: FastifyReply) => {};
}
