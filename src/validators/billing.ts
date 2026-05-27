import { z } from 'zod';

export const BILLING_PAYMENT_STATUSES = [
  'unpaid',
  'partial',
  'paid',
  'overdue',
  'waived',
  'failed',
] as const;

export const billingDueDaySchema = z.number().int().min(1).max(28);

export const listBillingPeriodsQuerySchema = z.object({
  period_start: z.string().optional(),
  payment_status: z.enum(BILLING_PAYMENT_STATUSES).optional(),
  company_id: z.string().uuid().optional(),
  salesman_id: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
});

export const createBillingPeriodSchema = z.object({
  period_start: z.string().datetime(),
  period_end: z.string().datetime().optional(),
  due_date: z.string().datetime().optional(),
  expected_amount: z.number().min(0).max(10_000_000),
  paid_amount: z.number().min(0).max(10_000_000).optional(),
  payment_status: z.enum(BILLING_PAYMENT_STATUSES).optional(),
  currency: z.string().length(3).optional(),
  paid_at: z.string().datetime().optional().nullable(),
  waived_at: z.string().datetime().optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  external_reference: z.string().max(200).optional().nullable(),
});

export const updateBillingPeriodSchema = z.object({
  expected_amount: z.number().min(0).max(10_000_000).optional(),
  paid_amount: z.number().min(0).max(10_000_000).optional(),
  payment_status: z.enum(BILLING_PAYMENT_STATUSES).optional(),
  due_date: z.string().datetime().optional(),
  paid_at: z.string().datetime().optional().nullable(),
  waived_at: z.string().datetime().optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  external_reference: z.string().max(200).optional().nullable(),
});

export const bulkBillingPeriodRowSchema = z.object({
  company_id: z.string().uuid(),
  period_start: z.string().datetime(),
  period_end: z.string().datetime().optional(),
  due_date: z.string().datetime().optional(),
  expected_amount: z.number().min(0).max(10_000_000),
  paid_amount: z.number().min(0).max(10_000_000).optional(),
  payment_status: z.enum(BILLING_PAYMENT_STATUSES).optional(),
  currency: z.string().length(3).optional(),
  paid_at: z.string().datetime().optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
});

export const bulkBillingPeriodsSchema = z.object({
  rows: z.array(bulkBillingPeriodRowSchema).min(1).max(500),
});
