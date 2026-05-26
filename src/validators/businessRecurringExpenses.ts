import { z } from 'zod';
import { BILLABLE_REVENUE_CATEGORIES } from './monthlyServices';

const BUSINESS_EXPENSE_TYPES = ['contractor', 'software', 'media', 'other'] as const;

export const businessRecurringExpenseIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const createBusinessRecurringExpenseSchema = z.object({
  name: z.string().min(1).max(120),
  vendor: z.string().max(120).optional().nullable(),
  expense_type: z.enum(BUSINESS_EXPENSE_TYPES).default('other'),
  amount: z.number().positive().max(1_000_000),
  currency: z.string().length(3).optional().default('USD'),
  is_active: z.boolean().optional().default(true),
  service_category: z.enum(BILLABLE_REVENUE_CATEGORIES).optional().nullable(),
  started_at: z.string().datetime().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export const updateBusinessRecurringExpenseSchema = createBusinessRecurringExpenseSchema.partial();
