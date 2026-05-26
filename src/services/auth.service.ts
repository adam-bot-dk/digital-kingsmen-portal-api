import { User } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { hashPassword, comparePassword } from '../lib/password';
import { signToken, getExpiresInSeconds } from '../lib/jwt';
import { sanitizeUser } from '../lib/sanitize';
import { AppError, ErrorCodes } from '../lib/errors';
import {
  consumeInvite,
  inviteEmailMatches,
  inviteRoleLabel,
  requireValidInviteDetails,
} from './invite.service';
import { syncCompanyLegacyStaffFields } from './companyStaffAssignments';

function resolvedInviteAssignments(invite: Awaited<ReturnType<typeof requireValidInviteDetails>>) {
  if (invite.assignments.length > 0) return invite.assignments;
  if (invite.companyId && invite.role === 'client') {
    return [
      {
        id: `legacy-${invite.id}`,
        inviteId: invite.id,
        companyId: invite.companyId,
        relationshipType: 'primary_contact',
        staffTagId: null,
        createdAt: invite.createdAt,
        company: invite.company ?? null,
        staffTag: null,
      },
    ];
  }
  return [];
}

async function provisionInviteAccess(
  invite: Awaited<ReturnType<typeof requireValidInviteDetails>>,
  userId: string,
): Promise<void> {
  const assignments = resolvedInviteAssignments(invite);
  if (assignments.length === 0) return;

  if (invite.role === 'client') {
    for (const assignment of assignments) {
      await prisma.companyUser.create({
        data: {
          companyId: assignment.companyId,
          userId,
          relationshipType: assignment.relationshipType ?? 'contact',
        },
      });
    }
    return;
  }

  if (invite.role === 'salesman' || invite.role === 'employee' || invite.role === 'contractor') {
    const touchedCompanyIds = new Set<string>();
    for (const assignment of assignments) {
      if (!assignment.staffTagId) continue;
      await prisma.companyStaffAssignment.create({
        data: {
          companyId: assignment.companyId,
          userId,
          staffTagId: assignment.staffTagId,
        },
      });
      touchedCompanyIds.add(assignment.companyId);
    }
    for (const companyId of touchedCompanyIds) {
      await syncCompanyLegacyStaffFields(companyId);
    }
  }
}

function serializeInvitePreview(invite: Awaited<ReturnType<typeof requireValidInviteDetails>>) {
  return {
    token: invite.token,
    email: invite.reusable || invite.email === '*' ? null : invite.email,
    emailLocked: !invite.reusable && invite.email !== '*',
    reusable: invite.reusable,
    role: invite.role,
    roleLabel: inviteRoleLabel(invite.role),
    expiresAt: invite.expiresAt,
    assignments: resolvedInviteAssignments(invite).map((assignment) => ({
      companyId: assignment.companyId,
      companyName: assignment.company?.name ?? null,
      relationshipType: assignment.relationshipType ?? null,
      staffTagId: assignment.staffTagId ?? null,
      staffTagLabel: assignment.staffTag?.label ?? null,
      staffTagSlug: assignment.staffTag?.slug ?? null,
    })),
  };
}

export async function register(data: {
  email: string;
  password: string;
  full_name: string;
  invite_token: string;
}) {
  const invite = await requireValidInviteDetails(data.invite_token.trim());

  if (!inviteEmailMatches(invite, data.email)) {
    throw new AppError(ErrorCodes.INVALID_INVITE, 'Email does not match invite', 400);
  }

  const existing = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
  if (existing) {
    throw new AppError(ErrorCodes.CONFLICT, 'User already exists', 409);
  }

  const passwordHash = await hashPassword(data.password);
  const user = await prisma.user.create({
    data: {
      email: data.email.toLowerCase(),
      passwordHash,
      fullName: data.full_name,
      role: invite.role,
    },
  });

  await provisionInviteAccess(invite, user.id);

  await consumeInvite(invite);

  const token = signToken({ sub: user.id, email: user.email, role: user.role });
  return {
    accessToken: token,
    expiresIn: getExpiresInSeconds(),
    user: sanitizeUser(user),
  };
}

export async function previewInvite(token: string) {
  const invite = await requireValidInviteDetails(token);
  return serializeInvitePreview(invite);
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!user || !user.isActive) {
    throw new AppError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid email or password', 401);
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    throw new AppError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid email or password', 401);
  }

  const token = signToken({ sub: user.id, email: user.email, role: user.role });
  return {
    accessToken: token,
    expiresIn: getExpiresInSeconds(),
    user: sanitizeUser(user),
  };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      companyUsers: {
        include: { company: { select: { id: true, name: true } } },
      },
    },
  });
  if (!user) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'User not found', 404);
  }
  const { passwordHash: _, ...safe } = user;
  return safe;
}

export function createInviteToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
