import {
  BillingAllocationLineStatus,
  BillingPaymentStatus,
  MonthlyServiceStatus,
  Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma';

export const MIN_BILLING_DUE_DAY = 1;
export const MAX_BILLING_DUE_DAY = 28;

export type BillingPeriodBounds = {
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
};

export function clampBillingDueDay(day: number): number {
  if (!Number.isFinite(day)) return 1;
  return Math.min(MAX_BILLING_DUE_DAY, Math.max(MIN_BILLING_DUE_DAY, Math.round(day)));
}

/** UTC date at 00:00:00.000 */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** UTC date at 23:59:59.999 */
export function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

function utcDate(y: number, m: number, day: number): Date {
  const clamped = Math.min(day, daysInUtcMonth(y, m));
  return new Date(Date.UTC(y, m, clamped));
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function addUtcMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  return utcDate(y + Math.floor(m / 12), ((m % 12) + 12) % 12, day);
}

function addUtcDays(d: Date, days: number): Date {
  const next = new Date(d.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return startOfUtcDay(next);
}

/**
 * Billing period anchored on company due day D:
 * - dueDate = next occurrence of day D on/after reference (end of that day)
 * - periodEnd = day before dueDate
 * - periodStart = periodEnd minus one month plus one day
 */
export function computeBillingPeriodBounds(
  billingDueDay: number,
  referenceDate: Date = new Date(),
): BillingPeriodBounds {
  const dueDay = clampBillingDueDay(billingDueDay);
  const ref = startOfUtcDay(referenceDate);
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();

  let dueDate = utcDate(y, m, dueDay);
  if (ref.getTime() > endOfUtcDay(dueDate).getTime()) {
    const next = addUtcMonths(dueDate, 1);
    dueDate = utcDate(next.getUTCFullYear(), next.getUTCMonth(), dueDay);
  }

  const periodEnd = endOfUtcDay(addUtcDays(dueDate, -1));
  const periodStart = startOfUtcDay(addUtcDays(addUtcMonths(periodEnd, -1), 1));

  return { periodStart, periodEnd, dueDate: endOfUtcDay(dueDate) };
}

export function periodStartKey(d: Date): string {
  return startOfUtcDay(d).toISOString().slice(0, 10);
}

type PeriodRow = {
  id: string;
  expectedAmountCents: number;
  paidAmountCents: number;
  dueDate: Date;
  waivedAt: Date | null;
  paymentStatus: BillingPaymentStatus;
};

export function derivePaymentStatus(
  row: Pick<PeriodRow, 'expectedAmountCents' | 'paidAmountCents' | 'dueDate' | 'waivedAt' | 'paymentStatus'>,
  now: Date = new Date(),
): BillingPaymentStatus {
  if (row.paymentStatus === BillingPaymentStatus.failed) {
    return BillingPaymentStatus.failed;
  }
  if (row.waivedAt || row.paymentStatus === BillingPaymentStatus.waived) {
    return BillingPaymentStatus.waived;
  }
  const expected = row.expectedAmountCents;
  const paid = row.paidAmountCents;
  if (expected <= 0 && paid <= 0) {
    return BillingPaymentStatus.waived;
  }
  if (paid >= expected && expected > 0) {
    return BillingPaymentStatus.paid;
  }
  if (paid > 0 && paid < expected) {
    return startOfUtcDay(row.dueDate) < startOfUtcDay(now)
      ? BillingPaymentStatus.overdue
      : BillingPaymentStatus.partial;
  }
  if (startOfUtcDay(row.dueDate) < startOfUtcDay(now)) {
    return BillingPaymentStatus.overdue;
  }
  return BillingPaymentStatus.unpaid;
}

export function sumBillableAllocations(
  allocations: { expectedAmountCents: number; lineStatus: BillingAllocationLineStatus }[],
): number {
  return allocations
    .filter((a) => a.lineStatus === BillingAllocationLineStatus.billable)
    .reduce((sum, a) => sum + a.expectedAmountCents, 0);
}

const billingPeriodInclude = {
  company: {
    select: {
      id: true,
      name: true,
      logoUrl: true,
      billingDueDayOfMonth: true,
      assignedSalesman: { select: { id: true, fullName: true, email: true } },
    },
  },
  allocations: {
    include: {
      monthlyService: {
        select: {
          id: true,
          serviceCategory: true,
          label: true,
          monthlyAmountCents: true,
          status: true,
          currency: true,
        },
      },
    },
  },
} satisfies Prisma.CompanyBillingPeriodInclude;

export type BillingPeriodWithRelations = Prisma.CompanyBillingPeriodGetPayload<{
  include: typeof billingPeriodInclude;
}>;

export async function refreshBillingPeriodStatus(periodId: string): Promise<void> {
  const period = await prisma.companyBillingPeriod.findUnique({ where: { id: periodId } });
  if (!period) return;
  const status = derivePaymentStatus(period);
  if (status !== period.paymentStatus) {
    await prisma.companyBillingPeriod.update({
      where: { id: periodId },
      data: { paymentStatus: status },
    });
  }
}

export async function recomputePeriodExpectedAmount(periodId: string): Promise<void> {
  const allocations = await prisma.companyBillingAllocation.findMany({
    where: { billingPeriodId: periodId },
  });
  const expected = sumBillableAllocations(allocations);
  const period = await prisma.companyBillingPeriod.findUnique({ where: { id: periodId } });
  if (!period) return;

  const status = derivePaymentStatus({
    ...period,
    expectedAmountCents: expected,
  });

  await prisma.companyBillingPeriod.update({
    where: { id: periodId },
    data: {
      expectedAmountCents: expected,
      paymentStatus: status,
      ...(expected === 0 && !period.waivedAt
        ? { waivedAt: new Date(), paymentStatus: BillingPaymentStatus.waived }
        : {}),
    },
  });
}

function serviceEligibleForPeriod(
  service: { status: MonthlyServiceStatus; startedAt: Date | null },
  periodEnd: Date,
): boolean {
  if (service.status !== MonthlyServiceStatus.active) return false;
  if (service.startedAt && service.startedAt > periodEnd) return false;
  return true;
}

export async function ensureBillingPeriodForCompany(
  companyId: string,
  referenceDate: Date = new Date(),
  createdById?: string,
): Promise<BillingPeriodWithRelations | null> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      monthlyServices: true,
    },
  });
  if (!company) return null;

  const bounds = computeBillingPeriodBounds(company.billingDueDayOfMonth, referenceDate);
  const eligible = company.monthlyServices.filter((s) =>
    serviceEligibleForPeriod(s, bounds.periodEnd),
  );
  if (eligible.length === 0) return null;

  const currency = eligible[0]?.currency ?? 'USD';

  const existing = await prisma.companyBillingPeriod.findUnique({
    where: {
      companyId_periodStart: {
        companyId,
        periodStart: bounds.periodStart,
      },
    },
    include: billingPeriodInclude,
  });

  if (existing) {
    await syncAllocationsForPeriod(existing.id, company.monthlyServices, bounds.periodEnd);
    await recomputePeriodExpectedAmount(existing.id);
    await refreshBillingPeriodStatus(existing.id);
    return prisma.companyBillingPeriod.findUnique({
      where: { id: existing.id },
      include: billingPeriodInclude,
    });
  }

  const period = await prisma.companyBillingPeriod.create({
    data: {
      companyId,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
      dueDate: bounds.dueDate,
      expectedAmountCents: 0,
      paidAmountCents: 0,
      paymentStatus: BillingPaymentStatus.unpaid,
      currency,
      createdById: createdById ?? null,
      updatedById: createdById ?? null,
    },
  });

  await syncAllocationsForPeriod(period.id, company.monthlyServices, bounds.periodEnd);
  await recomputePeriodExpectedAmount(period.id);

  return prisma.companyBillingPeriod.findUnique({
    where: { id: period.id },
    include: billingPeriodInclude,
  });
}

async function syncAllocationsForPeriod(
  periodId: string,
  services: {
    id: string;
    monthlyAmountCents: number;
    status: MonthlyServiceStatus;
    startedAt: Date | null;
  }[],
  periodEnd: Date,
): Promise<void> {
  const period = await prisma.companyBillingPeriod.findUnique({ where: { id: periodId } });
  if (!period) return;

  for (const service of services) {
    const eligible = serviceEligibleForPeriod(service, periodEnd);
    const existing = await prisma.companyBillingAllocation.findUnique({
      where: {
        billingPeriodId_monthlyServiceId: {
          billingPeriodId: periodId,
          monthlyServiceId: service.id,
        },
      },
    });

    if (!eligible) {
      if (existing && existing.lineStatus === BillingAllocationLineStatus.billable) {
        await prisma.companyBillingAllocation.update({
          where: { id: existing.id },
          data: { lineStatus: BillingAllocationLineStatus.waived },
        });
      }
      continue;
    }

    if (existing) {
      if (existing.lineStatus === BillingAllocationLineStatus.waived) {
        continue;
      }
      await prisma.companyBillingAllocation.update({
        where: { id: existing.id },
        data: { expectedAmountCents: service.monthlyAmountCents },
      });
    } else {
      await prisma.companyBillingAllocation.create({
        data: {
          billingPeriodId: periodId,
          monthlyServiceId: service.id,
          expectedAmountCents: service.monthlyAmountCents,
          lineStatus: BillingAllocationLineStatus.billable,
        },
      });
    }
  }
}

export async function generateBillingPeriodsForAllCompanies(
  referenceDate: Date = new Date(),
  createdById?: string,
): Promise<{ created: number; skipped: number }> {
  const companies = await prisma.company.findMany({
    where: {
      monthlyServices: {
        some: { status: MonthlyServiceStatus.active },
      },
    },
    select: { id: true },
  });

  let created = 0;
  let skipped = 0;

  for (const { id } of companies) {
    const before = await prisma.companyBillingPeriod.count({
      where: { companyId: id },
    });
    const result = await ensureBillingPeriodForCompany(id, referenceDate, createdById);
    if (result) {
      const after = await prisma.companyBillingPeriod.count({
        where: { companyId: id },
      });
      if (after > before) created += 1;
      else skipped += 1;
    } else {
      skipped += 1;
    }
  }

  return { created, skipped };
}

export async function waiveFutureAllocationsForService(monthlyServiceId: string): Promise<void> {
  const service = await prisma.companyMonthlyService.findUnique({
    where: { id: monthlyServiceId },
    include: { company: true },
  });
  if (!service) return;

  const { periodStart: currentStart } = computeBillingPeriodBounds(
    service.company.billingDueDayOfMonth,
    new Date(),
  );

  const futureAllocations = await prisma.companyBillingAllocation.findMany({
    where: {
      monthlyServiceId,
      billingPeriod: {
        periodStart: { gt: currentStart },
      },
      lineStatus: BillingAllocationLineStatus.billable,
    },
    select: { billingPeriodId: true },
  });

  if (futureAllocations.length === 0) return;

  await prisma.companyBillingAllocation.updateMany({
    where: {
      monthlyServiceId,
      billingPeriod: { periodStart: { gt: currentStart } },
    },
    data: { lineStatus: BillingAllocationLineStatus.waived },
  });

  const periodIds = [...new Set(futureAllocations.map((a) => a.billingPeriodId))];
  for (const periodId of periodIds) {
    await recomputePeriodExpectedAmount(periodId);
  }
}

export async function onMonthlyServiceStatusChange(
  monthlyServiceId: string,
  newStatus: MonthlyServiceStatus,
): Promise<void> {
  if (newStatus === MonthlyServiceStatus.paused || newStatus === MonthlyServiceStatus.cancelled) {
    await waiveFutureAllocationsForService(monthlyServiceId);
  }
}

export async function sweepOverdueBillingPeriods(): Promise<number> {
  const periods = await prisma.companyBillingPeriod.findMany({
    where: {
      paymentStatus: {
        in: [BillingPaymentStatus.unpaid, BillingPaymentStatus.partial],
      },
    },
  });

  let updated = 0;
  for (const period of periods) {
    const next = derivePaymentStatus(period);
    if (next !== period.paymentStatus) {
      await prisma.companyBillingPeriod.update({
        where: { id: period.id },
        data: { paymentStatus: next },
      });
      updated += 1;
    }
  }
  return updated;
}

export function serializeBillingPeriod(
  row: BillingPeriodWithRelations,
  includeFinancials: boolean,
) {
  const allocationSum = sumBillableAllocations(row.allocations);
  return {
    id: row.id,
    companyId: row.companyId,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    dueDate: row.dueDate.toISOString(),
    expectedAmountCents: includeFinancials ? row.expectedAmountCents : null,
    expectedAmount: includeFinancials ? row.expectedAmountCents / 100 : null,
    paidAmountCents: includeFinancials ? row.paidAmountCents : null,
    paidAmount: includeFinancials ? row.paidAmountCents / 100 : null,
    paymentStatus: row.paymentStatus,
    currency: row.currency,
    paidAt: row.paidAt?.toISOString() ?? null,
    waivedAt: row.waivedAt?.toISOString() ?? null,
    notes: row.notes,
    externalReference: row.externalReference,
    allocationSumCents: includeFinancials ? allocationSum : null,
    allocationMismatch: includeFinancials ? allocationSum !== row.expectedAmountCents : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    company: row.company
      ? {
          id: row.company.id,
          name: row.company.name,
          billingDueDayOfMonth: row.company.billingDueDayOfMonth,
          assignedSalesman: row.company.assignedSalesman,
        }
      : undefined,
    allocations: row.allocations.map((a) => ({
      id: a.id,
      billingPeriodId: a.billingPeriodId,
      monthlyServiceId: a.monthlyServiceId,
      expectedAmountCents: includeFinancials ? a.expectedAmountCents : null,
      expectedAmount: includeFinancials ? a.expectedAmountCents / 100 : null,
      lineStatus: a.lineStatus,
      monthlyService: a.monthlyService,
    })),
  };
}

export async function getBillingSummariesForCompanies(
  companyIds: string[],
  periodStartOverride?: Date,
): Promise<
  Map<
    string,
    {
      paymentStatus: BillingPaymentStatus;
      expectedAmountCents: number;
      paidAmountCents: number;
      periodStart: Date;
      dueDate: Date;
    }
  >
> {
  const result = new Map<
    string,
    {
      paymentStatus: BillingPaymentStatus;
      expectedAmountCents: number;
      paidAmountCents: number;
      periodStart: Date;
      dueDate: Date;
    }
  >();
  if (companyIds.length === 0) return result;

  if (periodStartOverride) {
    const periods = await prisma.companyBillingPeriod.findMany({
      where: {
        companyId: { in: companyIds },
        periodStart: startOfUtcDay(periodStartOverride),
      },
    });
    for (const p of periods) {
      result.set(p.companyId, {
        paymentStatus: derivePaymentStatus(p),
        expectedAmountCents: p.expectedAmountCents,
        paidAmountCents: p.paidAmountCents,
        periodStart: p.periodStart,
        dueDate: p.dueDate,
      });
    }
    return result;
  }

  const companies = await prisma.company.findMany({
    where: { id: { in: companyIds } },
    select: { id: true, billingDueDayOfMonth: true },
  });

  const periodStarts = companies.map((c) => ({
    companyId: c.id,
    periodStart: computeBillingPeriodBounds(c.billingDueDayOfMonth).periodStart,
  }));

  const periods = await prisma.companyBillingPeriod.findMany({
    where: {
      OR: periodStarts.map((ps) => ({
        companyId: ps.companyId,
        periodStart: ps.periodStart,
      })),
    },
  });

  for (const p of periods) {
    result.set(p.companyId, {
      paymentStatus: derivePaymentStatus(p),
      expectedAmountCents: p.expectedAmountCents,
      paidAmountCents: p.paidAmountCents,
      periodStart: p.periodStart,
      dueDate: p.dueDate,
    });
  }

  return result;
}

export { billingPeriodInclude };
