import { Request, Response, NextFunction } from 'express';
import { BillingPaymentStatus, Prisma } from '@prisma/client';
import { getParam } from '../lib/params';
import { prisma } from '../lib/prisma';
import { success, created } from '../lib/apiResponse';
import { AppError, ErrorCodes } from '../lib/errors';
import { assertCanAccessCompany, assertNotClient } from '../permissions/access';
import { billingPeriodWhereForUser } from '../permissions/billingFilters';
import { textContains } from '../lib/searchFilter';
import {
  assertCanManageBilling,
  assertCanViewBilling,
  canViewBilling,
} from '../lib/billingPermissions';
import { canViewMonthlyServiceFinancials } from '../lib/monthlyServicePermissions';
import {
  billingPeriodInclude,
  computeBillingPeriodBounds,
  derivePaymentStatus,
  ensureBillingPeriodForCompany,
  generateBillingPeriodsForAllCompanies,
  refreshBillingPeriodStatus,
  recomputePeriodExpectedAmount,
  serializeBillingPeriod,
  startOfUtcDay,
  sweepOverdueBillingPeriods,
} from '../services/billing.service';

function dollarsToCents(amount: number): number {
  return Math.round(amount * 100);
}

async function getBillingPeriodIfAccessible(req: Request, id: string) {
  const scope = await billingPeriodWhereForUser(req.user!);
  const row = await prisma.companyBillingPeriod.findFirst({
    where: { AND: [{ id }, scope] },
    include: billingPeriodInclude,
  });
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 'Billing period not found', 404);
  return row;
}

function includeFinancials(role: string): boolean {
  return canViewMonthlyServiceFinancials(role as 'admin');
}

export async function listPeriods(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    assertCanViewBilling(req.user!);

    await sweepOverdueBillingPeriods();

    const scope = await billingPeriodWhereForUser(req.user!);
    const periodStartRaw = req.query.period_start as string | undefined;
    const paymentStatus = req.query.payment_status as BillingPaymentStatus | undefined;
    const companyId = req.query.company_id as string | undefined;
    const salesmanId = req.query.salesman_id as string | undefined;
    const search = req.query.search as string | undefined;

    const where: Prisma.CompanyBillingPeriodWhereInput = { ...scope };
    if (periodStartRaw) {
      where.periodStart = startOfUtcDay(new Date(periodStartRaw));
    }
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (companyId) where.companyId = companyId;
    if (salesmanId || search) {
      const baseCompany =
        typeof where.company === 'object' && where.company
          ? (where.company as Prisma.CompanyWhereInput)
          : {};
      where.company = {
        AND: [
          baseCompany,
          ...(salesmanId ? [{ assignedSalesmanId: salesmanId }] : []),
          ...(search ? [{ name: textContains(search) }] : []),
        ],
      };
    }

    const rows = await prisma.companyBillingPeriod.findMany({
      where,
      include: billingPeriodInclude,
      orderBy: [{ dueDate: 'desc' }, { company: { name: 'asc' } }],
    });

    const fin = includeFinancials(req.user!.role);
    return success(res, rows.map((row) => serializeBillingPeriod(row, fin)));
  } catch (err) {
    next(err);
  }
}

export async function listCompanyPeriods(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    assertCanViewBilling(req.user!);
    const companyId = getParam(req, 'companyId');
    await assertCanAccessCompany(req.user!, companyId);

    await sweepOverdueBillingPeriods();

    const scope = await billingPeriodWhereForUser(req.user!);
    const rows = await prisma.companyBillingPeriod.findMany({
      where: { AND: [scope, { companyId }] },
      include: billingPeriodInclude,
      orderBy: { periodStart: 'desc' },
    });

    const fin = includeFinancials(req.user!.role);
    return success(res, rows.map((row) => serializeBillingPeriod(row, fin)));
  } catch (err) {
    next(err);
  }
}

export async function createCompanyPeriod(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    assertCanManageBilling(req.user!);
    const companyId = getParam(req, 'companyId');
    await assertCanAccessCompany(req.user!, companyId);

    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new AppError(ErrorCodes.NOT_FOUND, 'Company not found', 404);

    const body = req.body;
    const periodStart = startOfUtcDay(new Date(body.period_start));
    let periodEnd = body.period_end ? new Date(body.period_end) : undefined;
    let dueDate = body.due_date ? new Date(body.due_date) : undefined;

    if (!periodEnd || !dueDate) {
      const bounds = computeBillingPeriodBounds(company.billingDueDayOfMonth, periodStart);
      periodEnd = periodEnd ?? bounds.periodEnd;
      dueDate = dueDate ?? bounds.dueDate;
    }

    const expectedAmountCents = dollarsToCents(body.expected_amount);
    const paidAmountCents =
      body.paid_amount !== undefined ? dollarsToCents(body.paid_amount) : 0;

    const existing = await prisma.companyBillingPeriod.findUnique({
      where: { companyId_periodStart: { companyId, periodStart } },
    });
    if (existing) {
      throw new AppError(ErrorCodes.CONFLICT, 'Billing period already exists for this start date', 409);
    }

    const paymentStatus =
      (body.payment_status as BillingPaymentStatus | undefined) ??
      derivePaymentStatus({
        expectedAmountCents,
        paidAmountCents,
        dueDate: dueDate!,
        waivedAt: body.waived_at ? new Date(body.waived_at) : null,
        paymentStatus: BillingPaymentStatus.unpaid,
      });

    const row = await prisma.companyBillingPeriod.create({
      data: {
        companyId,
        periodStart,
        periodEnd: periodEnd!,
        dueDate: dueDate!,
        expectedAmountCents,
        paidAmountCents,
        paymentStatus,
        currency: (body.currency ?? 'USD').toUpperCase(),
        paidAt: body.paid_at ? new Date(body.paid_at) : paidAmountCents > 0 ? new Date() : null,
        waivedAt: body.waived_at ? new Date(body.waived_at) : null,
        notes: body.notes ?? null,
        externalReference: body.external_reference ?? null,
        createdById: req.user!.id,
        updatedById: req.user!.id,
      },
      include: billingPeriodInclude,
    });

    const refreshed = await prisma.companyBillingPeriod.findUnique({
      where: { id: row.id },
      include: billingPeriodInclude,
    });

    return created(res, serializeBillingPeriod(refreshed!, true));
  } catch (err) {
    next(err);
  }
}

export async function updatePeriod(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    assertCanManageBilling(req.user!);
    const id = getParam(req, 'id');
    const existing = await getBillingPeriodIfAccessible(req, id);
    const body = req.body;

    const expectedAmountCents =
      body.expected_amount !== undefined
        ? dollarsToCents(body.expected_amount)
        : existing.expectedAmountCents;
    const paidAmountCents =
      body.paid_amount !== undefined
        ? dollarsToCents(body.paid_amount)
        : existing.paidAmountCents;

    let waivedAt = existing.waivedAt;
    if (body.waived_at !== undefined) {
      waivedAt = body.waived_at ? new Date(body.waived_at) : null;
    }

    let paidAt = existing.paidAt;
    if (body.paid_at !== undefined) {
      paidAt = body.paid_at ? new Date(body.paid_at) : null;
    } else if (body.paid_amount !== undefined && paidAmountCents > 0 && !paidAt) {
      paidAt = new Date();
    }

    const dueDate = body.due_date ? new Date(body.due_date) : existing.dueDate;

    let paymentStatus =
      (body.payment_status as BillingPaymentStatus | undefined) ?? existing.paymentStatus;

    if (body.payment_status === BillingPaymentStatus.waived) {
      waivedAt = waivedAt ?? new Date();
    }
    const derived = derivePaymentStatus({
      expectedAmountCents,
      paidAmountCents,
      dueDate,
      waivedAt,
      paymentStatus,
    });

    if (body.payment_status !== BillingPaymentStatus.failed) {
      paymentStatus = derived;
    }

    const finalPaid =
      body.payment_status === BillingPaymentStatus.paid && body.paid_amount === undefined
        ? expectedAmountCents
        : paidAmountCents;

    const row = await prisma.companyBillingPeriod.update({
      where: { id },
      data: {
        expectedAmountCents,
        paidAmountCents: finalPaid,
        paymentStatus,
        dueDate,
        paidAt:
          paymentStatus === BillingPaymentStatus.paid ||
          paymentStatus === BillingPaymentStatus.partial
            ? paidAt ?? new Date()
            : paidAt,
        waivedAt,
        notes: body.notes !== undefined ? body.notes : undefined,
        externalReference:
          body.external_reference !== undefined ? body.external_reference : undefined,
        updatedById: req.user!.id,
      },
      include: billingPeriodInclude,
    });

    return success(res, serializeBillingPeriod(row, true));
  } catch (err) {
    next(err);
  }
}

export async function bulkImport(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    assertCanManageBilling(req.user!);

    const { rows } = req.body as {
      rows: Array<{
        company_id: string;
        period_start: string;
        period_end?: string;
        due_date?: string;
        expected_amount: number;
        paid_amount?: number;
        payment_status?: BillingPaymentStatus;
        currency?: string;
        paid_at?: string | null;
        notes?: string | null;
      }>;
    };

    const results: { company_id: string; period_start: string; id: string; created: boolean }[] =
      [];

    for (const row of rows) {
      await assertCanAccessCompany(req.user!, row.company_id);
      const company = await prisma.company.findUnique({ where: { id: row.company_id } });
      if (!company) continue;

      const periodStart = startOfUtcDay(new Date(row.period_start));
      const bounds = computeBillingPeriodBounds(company.billingDueDayOfMonth, periodStart);
      const periodEnd = row.period_end ? new Date(row.period_end) : bounds.periodEnd;
      const dueDate = row.due_date ? new Date(row.due_date) : bounds.dueDate;
      const expectedAmountCents = dollarsToCents(row.expected_amount);
      const paidAmountCents =
        row.paid_amount !== undefined ? dollarsToCents(row.paid_amount) : 0;

      const paymentStatus =
        row.payment_status ??
        derivePaymentStatus({
          expectedAmountCents,
          paidAmountCents,
          dueDate,
          waivedAt: null,
          paymentStatus: BillingPaymentStatus.unpaid,
        });

      const existing = await prisma.companyBillingPeriod.findUnique({
        where: { companyId_periodStart: { companyId: row.company_id, periodStart } },
      });

      if (existing) {
        const updated = await prisma.companyBillingPeriod.update({
          where: { id: existing.id },
          data: {
            periodEnd,
            dueDate,
            expectedAmountCents,
            paidAmountCents,
            paymentStatus,
            currency: (row.currency ?? existing.currency).toUpperCase(),
            paidAt: row.paid_at ? new Date(row.paid_at) : existing.paidAt,
            notes: row.notes ?? existing.notes,
            updatedById: req.user!.id,
          },
        });
        results.push({
          company_id: row.company_id,
          period_start: periodStart.toISOString(),
          id: updated.id,
          created: false,
        });
      } else {
        const createdRow = await prisma.companyBillingPeriod.create({
          data: {
            companyId: row.company_id,
            periodStart,
            periodEnd,
            dueDate,
            expectedAmountCents,
            paidAmountCents,
            paymentStatus,
            currency: (row.currency ?? 'USD').toUpperCase(),
            paidAt: row.paid_at ? new Date(row.paid_at) : null,
            notes: row.notes ?? null,
            createdById: req.user!.id,
            updatedById: req.user!.id,
          },
        });
        await ensureBillingPeriodForCompany(row.company_id, periodStart, req.user!.id);
        results.push({
          company_id: row.company_id,
          period_start: periodStart.toISOString(),
          id: createdRow.id,
          created: true,
        });
      }
    }

    return success(res, { imported: results.length, results });
  } catch (err) {
    next(err);
  }
}

export async function generate(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    assertCanManageBilling(req.user!);
    const stats = await generateBillingPeriodsForAllCompanies(new Date(), req.user!.id);
    await sweepOverdueBillingPeriods();
    return success(res, stats);
  } catch (err) {
    next(err);
  }
}

export async function getCurrentPeriodForCompany(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    if (!canViewBilling(req.user!.role)) {
      throw new AppError(ErrorCodes.FORBIDDEN, 'Not allowed', 403);
    }
    const companyId = getParam(req, 'companyId');
    await assertCanAccessCompany(req.user!, companyId);

    const row = await ensureBillingPeriodForCompany(companyId, new Date(), req.user!.id);
    if (!row) return success(res, null);

    const fin = includeFinancials(req.user!.role);
    return success(res, serializeBillingPeriod(row, fin));
  } catch (err) {
    next(err);
  }
}
