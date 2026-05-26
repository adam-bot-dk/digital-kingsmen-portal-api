import { NextFunction, Request, Response } from 'express';
import { getParam } from '../lib/params';
import { prisma } from '../lib/prisma';
import { created, success } from '../lib/apiResponse';
import { AppError, ErrorCodes } from '../lib/errors';
import { assertSuperAdmin } from '../permissions/access';
import {
  buildBusinessFinanceSummary,
  serializeBusinessRecurringExpense,
} from '../services/businessFinance.service';

function dollarsToCents(amount: number): number {
  return Math.round(amount * 100);
}

async function getRecurringExpenseOrThrow(id: string) {
  const row = await prisma.businessRecurringExpense.findUnique({ where: { id } });
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 'Business subscription not found', 404);
  return row;
}

export async function getSummary(req: Request, res: Response, next: NextFunction) {
  try {
    assertSuperAdmin(req.user!);

    const [monthlyServices, businessRecurringExpenses] = await Promise.all([
      prisma.companyMonthlyService.findMany({
        where: { status: 'active' },
        include: {
          company: {
            select: {
              id: true,
              assignedSalesman: { select: { id: true, fullName: true, email: true } },
            },
          },
          expenses: { orderBy: { name: 'asc' } },
        },
        orderBy: [{ serviceCategory: 'asc' }, { company: { name: 'asc' } }],
      }),
      prisma.businessRecurringExpense.findMany({
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      }),
    ]);

    return success(
      res,
      buildBusinessFinanceSummary({
        monthlyServices,
        businessRecurringExpenses,
      }),
    );
  } catch (err) {
    next(err);
  }
}

export async function listBusinessRecurringExpenses(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    assertSuperAdmin(req.user!);
    const rows = await prisma.businessRecurringExpense.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return success(res, rows.map(serializeBusinessRecurringExpense));
  } catch (err) {
    next(err);
  }
}

export async function createBusinessRecurringExpense(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    assertSuperAdmin(req.user!);
    const { name, vendor, expense_type, amount, currency, is_active, service_category, started_at, notes } =
      req.body as {
        name: string;
        vendor?: string | null;
        expense_type: string;
        amount: number;
        currency?: string;
        is_active?: boolean;
        service_category?: string | null;
        started_at?: string | null;
        notes?: string | null;
      };

    const row = await prisma.businessRecurringExpense.create({
      data: {
        name: name.trim(),
        vendor: vendor?.trim() || null,
        expenseType: expense_type,
        amountCents: dollarsToCents(amount),
        currency: (currency ?? 'USD').toUpperCase(),
        isActive: is_active ?? true,
        serviceCategory: service_category ?? null,
        startedAt: started_at ? new Date(started_at) : null,
        notes: notes?.trim() || null,
      },
    });

    return created(res, serializeBusinessRecurringExpense(row));
  } catch (err) {
    next(err);
  }
}

export async function updateBusinessRecurringExpense(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    assertSuperAdmin(req.user!);
    const id = getParam(req, 'id');
    await getRecurringExpenseOrThrow(id);

    const { name, vendor, expense_type, amount, currency, is_active, service_category, started_at, notes } =
      req.body as {
        name?: string;
        vendor?: string | null;
        expense_type?: string;
        amount?: number;
        currency?: string;
        is_active?: boolean;
        service_category?: string | null;
        started_at?: string | null;
        notes?: string | null;
      };

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name.trim();
    if (vendor !== undefined) data.vendor = vendor?.trim() || null;
    if (expense_type !== undefined) data.expenseType = expense_type;
    if (amount !== undefined) data.amountCents = dollarsToCents(amount);
    if (currency !== undefined) data.currency = currency.toUpperCase();
    if (is_active !== undefined) data.isActive = is_active;
    if (service_category !== undefined) data.serviceCategory = service_category ?? null;
    if (started_at !== undefined) data.startedAt = started_at ? new Date(started_at) : null;
    if (notes !== undefined) data.notes = notes?.trim() || null;

    const row = await prisma.businessRecurringExpense.update({
      where: { id },
      data,
    });
    return success(res, serializeBusinessRecurringExpense(row));
  } catch (err) {
    next(err);
  }
}

export async function deleteBusinessRecurringExpense(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    assertSuperAdmin(req.user!);
    const id = getParam(req, 'id');
    await getRecurringExpenseOrThrow(id);
    await prisma.businessRecurringExpense.delete({ where: { id } });
    return success(res, { deleted: true });
  } catch (err) {
    next(err);
  }
}
