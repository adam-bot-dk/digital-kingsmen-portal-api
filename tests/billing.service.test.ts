import { describe, expect, it } from 'vitest';
import {
  BillingPaymentStatus,
  BillingAllocationLineStatus,
} from '@prisma/client';
import {
  clampBillingDueDay,
  computeBillingPeriodBounds,
  derivePaymentStatus,
  sumBillableAllocations,
  startOfUtcDay,
} from '../src/services/billing.service';

describe('clampBillingDueDay', () => {
  it('clamps to 1–28', () => {
    expect(clampBillingDueDay(0)).toBe(1);
    expect(clampBillingDueDay(15)).toBe(15);
    expect(clampBillingDueDay(31)).toBe(28);
  });
});

describe('computeBillingPeriodBounds', () => {
  it('anchors period ending day before due date on the 5th', () => {
    const ref = new Date('2026-05-10T12:00:00Z');
    const { periodStart, periodEnd, dueDate } = computeBillingPeriodBounds(5, ref);

    expect(startOfUtcDay(periodStart).toISOString().slice(0, 10)).toBe('2026-05-05');
    expect(startOfUtcDay(periodEnd).toISOString().slice(0, 10)).toBe('2026-06-04');
    expect(startOfUtcDay(dueDate).toISOString().slice(0, 10)).toBe('2026-06-05');
  });

  it('uses current month due date when reference is before due day', () => {
    const ref = new Date('2026-05-03T12:00:00Z');
    const { dueDate } = computeBillingPeriodBounds(5, ref);
    expect(startOfUtcDay(dueDate).toISOString().slice(0, 10)).toBe('2026-05-05');
  });
});

describe('derivePaymentStatus', () => {
  const dueFuture = new Date('2099-01-15T00:00:00Z');
  const duePast = new Date('2020-01-15T00:00:00Z');

  it('returns paid when paid meets expected', () => {
    expect(
      derivePaymentStatus({
        expectedAmountCents: 100_00,
        paidAmountCents: 100_00,
        dueDate: duePast,
        waivedAt: null,
        paymentStatus: BillingPaymentStatus.unpaid,
      }),
    ).toBe(BillingPaymentStatus.paid);
  });

  it('returns partial before due date', () => {
    expect(
      derivePaymentStatus({
        expectedAmountCents: 100_00,
        paidAmountCents: 50_00,
        dueDate: dueFuture,
        waivedAt: null,
        paymentStatus: BillingPaymentStatus.unpaid,
      }),
    ).toBe(BillingPaymentStatus.partial);
  });

  it('returns overdue when unpaid after due date', () => {
    expect(
      derivePaymentStatus({
        expectedAmountCents: 100_00,
        paidAmountCents: 0,
        dueDate: duePast,
        waivedAt: null,
        paymentStatus: BillingPaymentStatus.unpaid,
      }),
    ).toBe(BillingPaymentStatus.overdue);
  });

  it('returns waived when waivedAt is set', () => {
    expect(
      derivePaymentStatus({
        expectedAmountCents: 100_00,
        paidAmountCents: 0,
        dueDate: duePast,
        waivedAt: new Date(),
        paymentStatus: BillingPaymentStatus.unpaid,
      }),
    ).toBe(BillingPaymentStatus.waived);
  });
});

describe('sumBillableAllocations', () => {
  it('sums only billable lines', () => {
    expect(
      sumBillableAllocations([
        { expectedAmountCents: 100, lineStatus: BillingAllocationLineStatus.billable },
        { expectedAmountCents: 50, lineStatus: BillingAllocationLineStatus.waived },
        { expectedAmountCents: 25, lineStatus: BillingAllocationLineStatus.billable },
      ]),
    ).toBe(125);
  });
});
