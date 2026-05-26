import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { success, created } from '../lib/apiResponse';
import { assertRole } from '../permissions/access';
import { createInviteToken } from '../services/auth.service';
import { appBaseUrl, buildRegisterUrl, isEmailConfigured, sendInviteEmail } from '../services/email.service';
import {
  inviteRoleLabel,
  listRegistrationTokens,
  normalizeInviteToken,
} from '../services/invite.service';
import { validateAssignmentRoleMatch } from '../services/companyStaffAssignments';
import { AppError, ErrorCodes } from '../lib/errors';

type InviteAssignmentInput = {
  company_id: string;
  relationship_type?: string;
  staff_tag_id?: string;
};

async function resolveInviteAssignments(
  role: UserRole,
  body: Record<string, unknown>,
): Promise<Array<{ companyId: string; relationshipType: string | null; staffTagId: string | null }>> {
  const rawAssignments = Array.isArray(body.assignments)
    ? (body.assignments as InviteAssignmentInput[])
    : [];
  const assignments =
    rawAssignments.length > 0
      ? rawAssignments
      : body.company_id
        ? [
            {
              company_id: String(body.company_id),
              relationship_type: (body.relationship_type as string | undefined) ?? 'primary_contact',
            },
          ]
        : [];

  const seen = new Set<string>();
  for (const assignment of assignments) {
    const key = `${assignment.company_id}:${assignment.relationship_type ?? ''}:${assignment.staff_tag_id ?? ''}`;
    if (seen.has(key)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Duplicate invite assignment', 400);
    }
    seen.add(key);
  }

  const companyIds = [...new Set(assignments.map((assignment) => assignment.company_id))];
  if (companyIds.length > 0) {
    const companies = await prisma.company.findMany({
      where: { id: { in: companyIds } },
      select: { id: true },
    });
    if (companies.length !== companyIds.length) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'One or more invite companies were not found', 404);
    }
  }

  const staffTagIds = [...new Set(assignments.map((assignment) => assignment.staff_tag_id).filter(Boolean))] as string[];
  const staffTagsById = new Map<string, { id: string; slug: string }>();
  if (staffTagIds.length > 0) {
    const staffTags = await prisma.staffTag.findMany({
      where: { id: { in: staffTagIds } },
      select: { id: true, slug: true },
    });
    if (staffTags.length !== staffTagIds.length) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'One or more invite staff tags were not found', 404);
    }
    for (const tag of staffTags) {
      staffTagsById.set(tag.id, tag);
    }
  }

  if (role === 'salesman' || role === 'employee' || role === 'contractor') {
    for (const assignment of assignments) {
      const staffTagId = assignment.staff_tag_id;
      if (!staffTagId) continue;
      const staffTag = staffTagsById.get(staffTagId);
      if (!staffTag) continue;
      await validateAssignmentRoleMatch(role, staffTag.slug);
    }
  }

  return assignments.map((assignment) => ({
    companyId: assignment.company_id,
    relationshipType: assignment.relationship_type ?? null,
    staffTagId: assignment.staff_tag_id ?? null,
  }));
}

function serializeInvite(invite: {
  id: string;
  token: string;
  email: string;
  role: UserRole;
  reusable: boolean;
  companyId: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  assignments?: Array<{
    companyId: string;
    relationshipType: string | null;
    staffTagId: string | null;
    company: { id: string; name: string } | null;
    staffTag: { id: string; slug: string; label: string } | null;
  }>;
}) {
  return {
    id: invite.id,
    token: invite.token,
    email: invite.email,
    role: invite.role,
    role_label: inviteRoleLabel(invite.role),
    reusable: invite.reusable,
    company_id: invite.companyId,
    expires_at: invite.expiresAt,
    used_at: invite.usedAt,
    created_at: invite.createdAt,
    register_url: buildRegisterUrl(invite.token),
    assignments:
      invite.assignments?.map((assignment) => ({
        company_id: assignment.companyId,
        company_name: assignment.company?.name ?? null,
        relationship_type: assignment.relationshipType,
        staff_tag_id: assignment.staffTagId,
        staff_tag_label: assignment.staffTag?.label ?? null,
        staff_tag_slug: assignment.staffTag?.slug ?? null,
      })) ?? [],
  };
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    assertRole(req.user!, 'admin');
    const body = req.body;
    const expiresInDays = body.expires_in_days ?? 7;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);
    const role = body.role as UserRole;
    const assignmentRows = await resolveInviteAssignments(role, body);
    const token = normalizeInviteToken(
      typeof body.token === 'string' && body.token.trim() ? body.token : createInviteToken(),
    );
    const primaryCompanyId =
      typeof body.company_id === 'string'
        ? body.company_id
        : assignmentRows.length === 1
          ? assignmentRows[0].companyId
          : null;
    const invite = await prisma.invite.create({
      data: {
        token,
        email: body.email.toLowerCase(),
        role,
        reusable: false,
        companyId: primaryCompanyId,
        expiresAt,
        createdBy: req.user!.id,
        assignments:
          assignmentRows.length > 0
            ? {
                create: assignmentRows.map((assignment) => ({
                  companyId: assignment.companyId,
                  relationshipType: assignment.relationshipType,
                  staffTagId: assignment.staffTagId,
                })),
              }
            : undefined,
      },
      include: {
        assignments: {
          include: {
            company: { select: { id: true, name: true } },
            staffTag: { select: { id: true, slug: true, label: true } },
          },
          orderBy: [{ companyId: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    const sendEmail = body.send_email === true;
    let emailSent = false;
    let emailReason: string | undefined;

    if (sendEmail) {
      try {
        const result = await sendInviteEmail({
          to: invite.email,
          token: invite.token,
          role: invite.role,
          expiresAt: invite.expiresAt,
        });
        emailSent = result.sent;
        emailReason = result.reason;
      } catch (emailErr) {
        console.error('Invite email failed:', emailErr);
        emailReason = 'send_failed';
      }
    }

    return created(res, {
      ...serializeInvite(invite),
      email_sent: emailSent,
      email_configured: isEmailConfigured(),
      email_reason: emailReason,
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return next(new AppError(ErrorCodes.CONFLICT, 'Invite token already exists', 409));
    }
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    assertRole(req.user!, 'admin');
    const invites = await prisma.invite.findMany({
      where: { reusable: false },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        assignments: {
          include: {
            company: { select: { id: true, name: true } },
            staffTag: { select: { id: true, slug: true, label: true } },
          },
          orderBy: [{ companyId: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    return success(res, invites.map(serializeInvite));
  } catch (err) {
    next(err);
  }
}

export async function registrationTokens(req: Request, res: Response, next: NextFunction) {
  try {
    assertRole(req.user!, 'admin');
    const tokens = await listRegistrationTokens();
    return success(res, {
      email_configured: isEmailConfigured(),
      tokens: tokens.map((t) => ({
        ...t,
        register_url: buildRegisterUrl(t.token),
        label: inviteRoleLabel(t.role),
      })),
    });
  } catch (err) {
    next(err);
  }
}

export async function emailStatus(req: Request, res: Response, next: NextFunction) {
  try {
    assertRole(req.user!, 'admin');
    return success(res, {
      configured: isEmailConfigured(),
      app_url: appBaseUrl(),
    });
  } catch (err) {
    next(err);
  }
}
