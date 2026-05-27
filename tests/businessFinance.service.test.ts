import { describe, expect, it } from 'vitest';
import { buildBusinessFinanceSummary } from '../src/services/businessFinance.service';

describe('buildBusinessFinanceSummary', () => {
  it('aggregates recurring service revenue, spend, and overhead by service category', () => {
    const summary = buildBusinessFinanceSummary({
      monthlyServices: [
        {
          id: 'svc-1',
          companyId: 'company-1',
          serviceCategory: 'seo',
          monthlyAmountCents: 100_000,
          salesmanPayoutCents: null,
          salesmanPayoutOverride: false,
          company: {
            id: 'company-1',
            assignedSalesman: {
              id: 'sales-1',
              fullName: 'Sam Seller',
              email: 'sam@example.com',
            },
          },
          expenses: [
            {
              id: 'expense-1',
              name: 'SEO contractor',
              vendor: 'Vendor A',
              expenseType: 'contractor',
              amountCents: 20_000,
              currency: 'USD',
              isRecurring: true,
            },
          ],
        },
        {
          id: 'svc-2',
          companyId: 'company-2',
          serviceCategory: 'seo',
          monthlyAmountCents: 80_000,
          salesmanPayoutCents: 10_000,
          salesmanPayoutOverride: true,
          company: {
            id: 'company-2',
            assignedSalesman: {
              id: 'sales-1',
              fullName: 'Sam Seller',
              email: 'sam@example.com',
            },
          },
          expenses: [
            {
              id: 'expense-2',
              name: 'SEO tools',
              vendor: 'Vendor B',
              expenseType: 'software',
              amountCents: 5_000,
              currency: 'USD',
              isRecurring: true,
            },
          ],
        },
      ],
      businessRecurringExpenses: [
        {
          id: 'bre-1',
          name: 'Ahrefs',
          vendor: 'Ahrefs',
          expenseType: 'software',
          amountCents: 15_000,
          currency: 'USD',
          isActive: true,
          serviceCategory: 'seo',
          startedAt: null,
          notes: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'bre-2',
          name: 'General ops',
          vendor: 'Notion',
          expenseType: 'software',
          amountCents: 2_500,
          currency: 'USD',
          isActive: true,
          serviceCategory: null,
          startedAt: null,
          notes: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    });

    expect(summary.totals.recurringRevenueCents).toBe(180_000);
    expect(summary.totals.serviceLinkedSpendCents).toBe(65_000);
    expect(summary.totals.businessOverheadCents).toBe(17_500);
    expect(summary.totals.netContributionCents).toBe(97_500);

    expect(summary.services).toHaveLength(1);
    expect(summary.services[0]).toMatchObject({
      serviceCategory: 'seo',
      revenueCents: 180_000,
      salesmanPayoutCents: 40_000,
      serviceExpenseCents: 25_000,
      businessOverheadCents: 15_000,
      totalSpendCents: 80_000,
      netContributionCents: 100_000,
      activeLineCount: 2,
      clientCount: 2,
    });
    expect(summary.services[0].salesmen[0]).toMatchObject({
      id: 'sales-1',
      revenueCents: 180_000,
      payoutCents: 40_000,
    });
    expect(summary.services[0].contractors[0]).toMatchObject({
      name: 'SEO contractor',
      vendor: 'Vendor A',
      amountCents: 20_000,
      lineCount: 1,
    });
  });

  it('treats services without an assigned salesman as zero payout', () => {
    const summary = buildBusinessFinanceSummary({
      monthlyServices: [
        {
          id: 'svc-unassigned',
          companyId: 'company-3',
          serviceCategory: 'seo',
          monthlyAmountCents: 100_000,
          salesmanPayoutCents: 45_000,
          salesmanPayoutOverride: true,
          company: {
            id: 'company-3',
            assignedSalesman: null,
          },
          expenses: [],
        },
      ],
      businessRecurringExpenses: [],
    });

    expect(summary.totals.recurringRevenueCents).toBe(100_000);
    expect(summary.totals.serviceLinkedSpendCents).toBe(0);
    expect(summary.totals.netContributionCents).toBe(100_000);
    expect(summary.services[0]).toMatchObject({
      serviceCategory: 'seo',
      revenueCents: 100_000,
      salesmanPayoutCents: 0,
      serviceExpenseCents: 0,
      netContributionCents: 100_000,
      activeLineCount: 1,
      clientCount: 1,
    });
    expect(summary.services[0].salesmen).toEqual([]);
  });
});
