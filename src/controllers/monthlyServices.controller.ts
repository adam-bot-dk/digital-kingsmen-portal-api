import { Request, Response, NextFunction } from 'express';
import { MonthlyServiceStatus, Prisma } from '@prisma/client';
import { getParam } from '../lib/params';
import { prisma } from '../lib/prisma';
import { success, created } from '../lib/apiResponse';
import { AppError, ErrorCodes } from '../lib/errors';
import { assertCanAccessCompany, assertNotClient } from '../permissions/access';
import { monthlyServiceWhereForUser as monthlyServiceScopeForUser } from '../permissions/filters';
import { textContains } from '../lib/searchFilter';
import {
  BILLABLE_REVENUE_CATEGORIES,
  DEFAULT_SALESMAN_SPLIT_PERCENT,
} from '../validators/monthlyServices';
import {
  computeDefaultPayoutCents,
  sumRecurringExpenseCents,
} from '../services/businessFinance.service';
import { mapNestedCompanyLogo } from '../lib/companyResponse';
import {
  assertCanManageMonthlyServices,
  canViewMonthlyServiceFinancials,
} from '../lib/monthlyServicePermissions';
import { canViewBilling } from '../lib/billingPermissions';
import {
  getBillingSummariesForCompanies,
  onMonthlyServiceStatusChange,
} from '../services/billing.service';
import type { UserRole } from '@prisma/client';
import { BillingPaymentStatus } from '@prisma/client';

const includeCompany = {
  company: {
    select: {
      id: true,
      name: true,
      logoUrl: true,
      status: true,
      assignedSalesman: { select: { id: true, fullName: true, email: true } },
    },
  },
  expenses: {
    orderBy: { name: 'asc' as const },
  },
} as const;

function serializeExpense(
  row: {
    id: string;
    monthlyServiceId: string;
    name: string;
    vendor: string | null;
    expenseType: string;
    amountCents: number;
    currency: string;
    isRecurring: boolean;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  includeFinancials: boolean,
) {
  return {
    id: row.id,
    monthlyServiceId: row.monthlyServiceId,
    name: row.name,
    vendor: row.vendor,
    expenseType: row.expenseType,
    amountCents: includeFinancials ? row.amountCents : null,
    amount: includeFinancials ? row.amountCents / 100 : null,
    currency: row.currency,
    isRecurring: row.isRecurring,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function dollarsToCents(amount: number): number {
  return Math.round(amount * 100);
}

function payoutCentsFromBody(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return dollarsToCents(value as number);
}

function parseBillableOnly(query: unknown): boolean {
  if (query === undefined || query === null || query === '') return true;
  return query === 'true' || query === '1';
}

function resolvePayoutOnWrite(
  monthlyAmountCents: number,
  override: boolean,
  explicitPayoutCents: number | null | undefined,
  hasAssignedSalesman: boolean,
): { salesmanPayoutCents: number | null; salesmanPayoutOverride: boolean } {
  if (!hasAssignedSalesman) {
    return {
      salesmanPayoutCents: null,
      salesmanPayoutOverride: false,
    };
  }
  if (override) {
    return {
      salesmanPayoutCents: explicitPayoutCents ?? null,
      salesmanPayoutOverride: true,
    };
  }
  return {
    salesmanPayoutCents: computeDefaultPayoutCents(monthlyAmountCents),
    salesmanPayoutOverride: false,
  };
}

function serializeMonthlyService(
  row: {
  id: string;
  companyId: string;
  serviceCategory: string;
  label: string | null;
  monthlyAmountCents: number;
  salesmanPayoutCents: number | null;
  salesmanPayoutOverride: boolean;
  currency: string;
  status: MonthlyServiceStatus;
  description: string | null;
  startedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  company?: {
    id: string;
    name: string;
    logoUrl: string | null;
    status: string;
    assignedSalesman?: { id: string; fullName: string; email: string } | null;
  };
  expenses?: {
    id: string;
    monthlyServiceId: string;
    name: string;
    vendor: string | null;
    expenseType: string;
    amountCents: number;
    currency: string;
    isRecurring: boolean;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
  }[];
  },
  viewerRole: UserRole,
) {
  const includeFinancials = canViewMonthlyServiceFinancials(viewerRole);
  const hasAssignedSalesman = Boolean(row.company?.assignedSalesman?.id);
  const monthlyAmount = row.monthlyAmountCents / 100;
  const defaultSalesmanPayout = hasAssignedSalesman
    ? computeDefaultPayoutCents(row.monthlyAmountCents) / 100
    : 0;
  const salesmanPayout = !hasAssignedSalesman
    ? null
    : row.salesmanPayoutOverride
      ? row.salesmanPayoutCents != null
        ? row.salesmanPayoutCents / 100
        : null
      : defaultSalesmanPayout;
  const effectivePayout = salesmanPayout ?? 0;
  const expenses = row.expenses ?? [];
  const totalExpensesCents = sumRecurringExpenseCents(expenses);
  const totalExpenses = totalExpensesCents / 100;
  const salesmanSplitPercent =
    !hasAssignedSalesman
      ? 0
      : row.salesmanPayoutOverride && monthlyAmount > 0 && salesmanPayout != null
      ? Math.round((salesmanPayout / monthlyAmount) * 1000) / 10
      : DEFAULT_SALESMAN_SPLIT_PERCENT;

  const { expenses: _rawExpenses, company, ...rest } = row;

  const payload = {
    ...rest,
    company: mapNestedCompanyLogo(company),
    monthlyAmount: includeFinancials ? monthlyAmount : null,
    salesmanPayoutCents:
      includeFinancials && hasAssignedSalesman ? row.salesmanPayoutCents : null,
    defaultSalesmanPayout: includeFinancials ? defaultSalesmanPayout : null,
    salesmanPayout: includeFinancials ? salesmanPayout : null,
    salesmanPayoutOverride:
      includeFinancials && hasAssignedSalesman ? row.salesmanPayoutOverride : false,
    salesmanSplitPercent: includeFinancials ? salesmanSplitPercent : null,
    expenses: expenses.map((expense) => serializeExpense(expense, includeFinancials)),
    totalExpensesCents: includeFinancials ? totalExpensesCents : null,
    totalExpenses: includeFinancials ? totalExpenses : null,
    netAmount: includeFinancials ? monthlyAmount - effectivePayout - totalExpenses : null,
  };

  return payload;
}

async function getMonthlyServiceIfAccessible(req: Request, id: string) {
  const scope = await monthlyServiceScopeForUser(req.user!);
  const existing = await prisma.companyMonthlyService.findFirst({
    where: { AND: [{ id }, scope] },
    include: includeCompany,
  });
  if (!existing) throw new AppError(ErrorCodes.NOT_FOUND, 'Monthly service not found', 404);
  return existing;
}

export async function listAll(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    const where: Prisma.CompanyMonthlyServiceWhereInput = await monthlyServiceScopeForUser(req.user!);

    const category = req.query.category as string | undefined;
    const categoriesRaw = req.query.categories as string | undefined;
    const categoryIds = categoriesRaw
      ? categoriesRaw
          .split(',')
          .map((s) => s.trim())
          .filter((id): id is (typeof BILLABLE_REVENUE_CATEGORIES)[number] =>
            (BILLABLE_REVENUE_CATEGORIES as readonly string[]).includes(id),
          )
      : [];
    const status = req.query.status as MonthlyServiceStatus | undefined;
    const companyId = req.query.company_id as string | undefined;
    const salesmanId = req.query.salesman_id as string | undefined;
    const search = req.query.search as string | undefined;
    const billableOnly = parseBillableOnly(req.query.billable_only);

    if (status) where.status = status;
    if (companyId) where.companyId = companyId;
    if (categoryIds.length > 0) {
      where.serviceCategory = { in: categoryIds };
    } else if (category) {
      where.serviceCategory = category;
    } else if (billableOnly) {
      where.serviceCategory = { in: [...BILLABLE_REVENUE_CATEGORIES] };
    }
    if (salesmanId) {
      const companyWhere =
        typeof where.company === 'object' && where.company
          ? ({ ...(where.company as Prisma.CompanyWhereInput) } satisfies Prisma.CompanyWhereInput)
          : ({} satisfies Prisma.CompanyWhereInput);
      where.company = {
        ...companyWhere,
        assignedSalesmanId: salesmanId,
      };
    }
    if (search) {
      const companyWhere =
        typeof where.company === 'object' && where.company
          ? ({ ...(where.company as Prisma.CompanyWhereInput) } satisfies Prisma.CompanyWhereInput)
          : ({} satisfies Prisma.CompanyWhereInput);
      where.company = {
        ...companyWhere,
        name: textContains(search),
      };
    }

    const paymentStatusFilter = req.query.payment_status as BillingPaymentStatus | undefined;
    const billingPeriodStartRaw = req.query.billing_period_start as string | undefined;

    const rows = await prisma.companyMonthlyService.findMany({
      where,
      include: includeCompany,
      orderBy: [{ company: { name: 'asc' } }, { serviceCategory: 'asc' }],
    });

    const billingByCompany = new Map<
      string,
      {
        paymentStatus: BillingPaymentStatus;
        expectedAmount: number | null;
        paidAmount: number | null;
        periodStart: string;
        dueDate: string;
      } | null
    >();

    if (canViewBilling(req.user!.role)) {
      const companyIds = [...new Set(rows.map((r) => r.companyId))];
      const summaries = await getBillingSummariesForCompanies(
        companyIds,
        billingPeriodStartRaw ? new Date(billingPeriodStartRaw) : undefined,
      );
      const includeFinancials = canViewMonthlyServiceFinancials(req.user!.role);
      for (const [companyId, summary] of summaries) {
        billingByCompany.set(companyId, {
          paymentStatus: summary.paymentStatus,
          expectedAmount: includeFinancials ? summary.expectedAmountCents / 100 : null,
          paidAmount: includeFinancials ? summary.paidAmountCents / 100 : null,
          periodStart: summary.periodStart.toISOString(),
          dueDate: summary.dueDate.toISOString(),
        });
      }
    }

    let serialized = rows.map((row) => {
      const base = serializeMonthlyService(row, req.user!.role);
      const billing = billingByCompany.get(row.companyId);
      return billing ? { ...base, companyBilling: billing } : base;
    });

    if (paymentStatusFilter) {
      serialized = serialized.filter((row) => {
        const billing = (row as { companyBilling?: { paymentStatus: BillingPaymentStatus } })
          .companyBilling;
        return billing?.paymentStatus === paymentStatusFilter;
      });
    }

    return success(res, serialized);
  } catch (err) {
    next(err);
  }
}

export async function listForCompany(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    const companyId = getParam(req, 'companyId');
    await assertCanAccessCompany(req.user!, companyId);

    const billableOnly = parseBillableOnly(req.query.billable_only);
    const scope = await monthlyServiceScopeForUser(req.user!);

    const rows = await prisma.companyMonthlyService.findMany({
      where: {
        AND: [
          scope,
          {
            companyId,
            ...(billableOnly
              ? { serviceCategory: { in: [...BILLABLE_REVENUE_CATEGORIES] } }
              : {}),
          },
        ],
      },
      include: includeCompany,
      orderBy: [{ status: 'asc' }, { serviceCategory: 'asc' }],
    });

    return success(res, rows.map((row) => serializeMonthlyService(row, req.user!.role)));
  } catch (err) {
    next(err);
  }
}

export async function createForCompany(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    assertCanManageMonthlyServices(req.user!);
    const companyId = getParam(req, 'companyId');
    await assertCanAccessCompany(req.user!, companyId);
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { assignedSalesmanId: true },
    });
    if (!company) throw new AppError(ErrorCodes.NOT_FOUND, 'Company not found', 404);

    const {
      service_category: serviceCategory,
      label,
      monthly_amount: monthlyAmount,
      salesman_payout: salesmanPayout,
      salesman_payout_override: payoutOverride = false,
      currency = 'USD',
      status = 'active',
      description,
      started_at: startedAtRaw,
    } = req.body;

    const monthlyAmountCents = dollarsToCents(monthlyAmount);
    const payout = resolvePayoutOnWrite(
      monthlyAmountCents,
      !!payoutOverride,
      payoutCentsFromBody(salesmanPayout),
      Boolean(company.assignedSalesmanId),
    );

    const row = await prisma.companyMonthlyService.create({
      data: {
        companyId,
        serviceCategory,
        label: label ?? null,
        monthlyAmountCents,
        salesmanPayoutCents: payout.salesmanPayoutCents,
        salesmanPayoutOverride: payout.salesmanPayoutOverride,
        currency: currency.toUpperCase(),
        status: status as MonthlyServiceStatus,
        description: description ?? null,
        startedAt: startedAtRaw ? new Date(startedAtRaw) : null,
      },
      include: includeCompany,
    });

    return created(res, serializeMonthlyService(row, req.user!.role));
  } catch (err) {
    next(err);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    assertCanManageMonthlyServices(req.user!);
    const id = getParam(req, 'id');
    const existing = await getMonthlyServiceIfAccessible(req, id);

    const body = req.body;
    const monthlyAmountCents =
      body.monthly_amount !== undefined
        ? dollarsToCents(body.monthly_amount)
        : existing.monthlyAmountCents;

    let payoutOverride = existing.salesmanPayoutOverride;
    if (body.salesman_payout_override !== undefined) {
      payoutOverride = !!body.salesman_payout_override;
    }

    let salesmanPayoutCents = existing.salesmanPayoutCents;
    if (body.salesman_payout !== undefined) {
      salesmanPayoutCents = payoutCentsFromBody(body.salesman_payout) ?? null;
      payoutOverride = true;
    } else if (
      body.monthly_amount !== undefined ||
      body.salesman_payout_override === false
    ) {
      if (!payoutOverride || body.salesman_payout_override === false) {
        payoutOverride = false;
        salesmanPayoutCents = computeDefaultPayoutCents(monthlyAmountCents);
      }
    }

    const payout = resolvePayoutOnWrite(
      monthlyAmountCents,
      payoutOverride,
      salesmanPayoutCents,
      Boolean(existing.company?.assignedSalesman?.id),
    );

    const data: Prisma.CompanyMonthlyServiceUpdateInput = {
      ...(body.service_category !== undefined && { serviceCategory: body.service_category }),
      ...(body.label !== undefined && { label: body.label }),
      ...(body.monthly_amount !== undefined && { monthlyAmountCents }),
      salesmanPayoutCents: payout.salesmanPayoutCents,
      salesmanPayoutOverride: payout.salesmanPayoutOverride,
      ...(body.currency !== undefined && { currency: body.currency.toUpperCase() }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.started_at !== undefined && {
        startedAt: body.started_at ? new Date(body.started_at) : null,
      }),
    };

    const row = await prisma.companyMonthlyService.update({
      where: { id },
      data,
      include: includeCompany,
    });

    if (body.status !== undefined && body.status !== existing.status) {
      await onMonthlyServiceStatusChange(id, body.status as MonthlyServiceStatus);
    }

    return success(res, serializeMonthlyService(row, req.user!.role));
  } catch (err) {
    next(err);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    assertCanManageMonthlyServices(req.user!);
    const id = getParam(req, 'id');
    await getMonthlyServiceIfAccessible(req, id);

    await prisma.companyMonthlyService.delete({ where: { id } });
    return success(res, { deleted: true });
  } catch (err) {
    next(err);
  }
}

export async function listExpenses(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    const service = await getMonthlyServiceIfAccessible(req, getParam(req, 'id'));
    const includeFinancials = canViewMonthlyServiceFinancials(req.user!.role);
    return success(res, service.expenses.map((expense) => serializeExpense(expense, includeFinancials)));
  } catch (err) {
    next(err);
  }
}

export async function createExpense(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    assertCanManageMonthlyServices(req.user!);
    const service = await getMonthlyServiceIfAccessible(req, getParam(req, 'id'));
    const {
      name,
      vendor,
      expense_type: expenseType = 'contractor',
      amount,
      currency = service.currency,
      is_recurring: isRecurring = true,
      notes,
    } = req.body;

    const row = await prisma.companyMonthlyServiceExpense.create({
      data: {
        monthlyServiceId: service.id,
        name,
        vendor: vendor ?? null,
        expenseType,
        amountCents: dollarsToCents(amount),
        currency: String(currency).toUpperCase(),
        isRecurring: !!isRecurring,
        notes: notes ?? null,
      },
    });

    return created(
      res,
      serializeExpense(row, canViewMonthlyServiceFinancials(req.user!.role)),
    );
  } catch (err) {
    next(err);
  }
}

export async function updateExpense(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    assertCanManageMonthlyServices(req.user!);
    await getMonthlyServiceIfAccessible(req, getParam(req, 'id'));
    const expenseId = getParam(req, 'expenseId');
    const existing = await prisma.companyMonthlyServiceExpense.findFirst({
      where: { id: expenseId, monthlyServiceId: getParam(req, 'id') },
    });
    if (!existing) throw new AppError(ErrorCodes.NOT_FOUND, 'Expense not found', 404);

    const body = req.body;
    const row = await prisma.companyMonthlyServiceExpense.update({
      where: { id: expenseId },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.vendor !== undefined && { vendor: body.vendor ?? null }),
        ...(body.expense_type !== undefined && { expenseType: body.expense_type }),
        ...(body.amount !== undefined && { amountCents: dollarsToCents(body.amount) }),
        ...(body.currency !== undefined && { currency: body.currency.toUpperCase() }),
        ...(body.is_recurring !== undefined && { isRecurring: !!body.is_recurring }),
        ...(body.notes !== undefined && { notes: body.notes ?? null }),
      },
    });

    return success(res, serializeExpense(row, canViewMonthlyServiceFinancials(req.user!.role)));
  } catch (err) {
    next(err);
  }
}

export async function removeExpense(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotClient(req.user!);
    assertCanManageMonthlyServices(req.user!);
    await getMonthlyServiceIfAccessible(req, getParam(req, 'id'));
    const expenseId = getParam(req, 'expenseId');
    const existing = await prisma.companyMonthlyServiceExpense.findFirst({
      where: { id: expenseId, monthlyServiceId: getParam(req, 'id') },
    });
    if (!existing) throw new AppError(ErrorCodes.NOT_FOUND, 'Expense not found', 404);

    await prisma.companyMonthlyServiceExpense.delete({ where: { id: expenseId } });
    return success(res, { deleted: true });
  } catch (err) {
    next(err);
  }
}
