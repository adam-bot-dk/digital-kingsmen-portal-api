import type { Invite, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError, ErrorCodes } from '../lib/errors';

const inviteDetailsInclude = {
  company: { select: { id: true, name: true } },
  assignments: {
    include: {
      company: { select: { id: true, name: true } },
      staffTag: { select: { id: true, slug: true, label: true, singular: true } },
    },
    orderBy: [{ companyId: 'asc' as const }, { createdAt: 'asc' as const }],
  },
} satisfies Prisma.InviteInclude;

export type InviteDetails = Prisma.InviteGetPayload<{
  include: typeof inviteDetailsInclude;
}>;

export function normalizeInviteToken(token: string): string {
  return token.trim().toLowerCase();
}

export function isInviteValid<T extends { expiresAt: Date; reusable: boolean; usedAt: Date | null }>(
  invite: T | null,
): invite is T {
  if (!invite) return false;
  if (invite.expiresAt < new Date()) return false;
  if (!invite.reusable && invite.usedAt) return false;
  return true;
}

export function inviteEmailMatches(invite: Pick<Invite, 'reusable' | 'email'>, email: string): boolean {
  if (invite.reusable || invite.email === '*') return true;
  return invite.email.toLowerCase() === email.toLowerCase();
}

export function inviteRoleLabel(role: UserRole): string {
  switch (role) {
    case 'client':
      return 'client';
    case 'employee':
      return 'team member';
    case 'contractor':
      return 'contractor';
    case 'salesman':
      return 'sales';
    default:
      return 'admin';
  }
}

export async function consumeInvite(invite: Pick<Invite, 'id' | 'reusable'>): Promise<void> {
  if (invite.reusable) return;
  await prisma.invite.update({
    where: { id: invite.id },
    data: { usedAt: new Date() },
  });
}

/** Long-lived tokens for onboarding — any email can register with the matching role. */
export const REGISTRATION_TOKEN_SPECS: Array<{
  token: string;
  role: UserRole;
  label: string;
}> = [
  { token: 'dk-register-client', role: 'client', label: 'Client' },
  { token: 'dk-register-employee', role: 'employee', label: 'Team member' },
  { token: 'dk-register-salesman', role: 'salesman', label: 'Sales' },
  { token: 'dk-register-admin', role: 'admin', label: 'Admin' },
];

export async function ensureRegistrationTokens(createdByUserId: string): Promise<void> {
  const expiresAt = new Date('2099-12-31T23:59:59.000Z');

  for (const spec of REGISTRATION_TOKEN_SPECS) {
    await prisma.invite.upsert({
      where: { token: normalizeInviteToken(spec.token) },
      create: {
        token: normalizeInviteToken(spec.token),
        email: '*',
        role: spec.role,
        reusable: true,
        expiresAt,
        createdBy: createdByUserId,
      },
      update: {
        role: spec.role,
        reusable: true,
        expiresAt,
        usedAt: null,
      },
    });
  }
}

export async function listRegistrationTokens() {
  return prisma.invite.findMany({
    where: { reusable: true },
    orderBy: { role: 'asc' },
    select: {
      id: true,
      token: true,
      role: true,
      expiresAt: true,
      createdAt: true,
    },
  });
}

export async function getInviteByToken(token: string): Promise<Invite | null> {
  return prisma.invite.findUnique({ where: { token: normalizeInviteToken(token) } });
}

export async function getInviteDetailsByToken(token: string): Promise<InviteDetails | null> {
  return prisma.invite.findUnique({
    where: { token: normalizeInviteToken(token) },
    include: inviteDetailsInclude,
  });
}

export async function requireValidInvite(token: string): Promise<Invite> {
  const invite = await getInviteByToken(token);
  if (!isInviteValid(invite)) {
    throw new AppError(ErrorCodes.INVALID_INVITE, 'Invalid or expired invite token', 400);
  }
  return invite!;
}

export async function requireValidInviteDetails(token: string): Promise<InviteDetails> {
  const invite = await getInviteDetailsByToken(token);
  if (!isInviteValid(invite)) {
    throw new AppError(ErrorCodes.INVALID_INVITE, 'Invalid or expired invite token', 400);
  }
  return invite;
}
