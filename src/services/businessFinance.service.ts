import { DEFAULT_SALESMAN_SPLIT_PERCENT } from '../validators/monthlyServices';

type SalesmanRef = { id: string; fullName?: string | null; email?: string | null } | null | undefined;

export interface BusinessFinanceMonthlyServiceRow {
  id: string;
  companyId: string;
  serviceCategory: string;
  monthlyAmountCents: number;
  salesmanPayoutCents: number | null;
  salesmanPayoutOverride: boolean;
  company?: {
    id: string;
    assignedSalesman?: SalesmanRef;
  } | null;
  expenses?: {
    id: string;
    name: string;
    vendor?: string | null;
    expenseType: string;
    amountCents: number;
    currency: string;
    isRecurring: boolean;
  }[];
}

export interface BusinessRecurringExpenseRow {
  id: string;
  name: string;
  vendor?: string | null;
  expenseType: string;
  amountCents: number;
  currency: string;
  isActive: boolean;
  serviceCategory?: string | null;
  startedAt?: Date | null;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BusinessFinanceSalesmanSummary {
  id: string;
  fullName?: string | null;
  email?: string | null;
  revenueCents: number;
  revenue: number;
  payoutCents: number;
  payout: number;
}

export interface BusinessFinanceContractorSummary {
  name: string;
  vendor?: string | null;
  amountCents: number;
  amount: number;
  lineCount: number;
}

export interface BusinessFinanceServiceSummary {
  serviceCategory: string;
  revenueCents: number;
  revenue: number;
  salesmanPayoutCents: number;
  salesmanPayout: number;
  serviceExpenseCents: number;
  serviceExpenses: number;
  businessOverheadCents: number;
  businessOverhead: number;
  totalSpendCents: number;
  totalSpend: number;
  netContributionCents: number;
  netContribution: number;
  activeLineCount: number;
  clientCount: number;
  salesmen: BusinessFinanceSalesmanSummary[];
  contractors: BusinessFinanceContractorSummary[];
}

export interface SerializedBusinessRecurringExpense {
  id: string;
  name: string;
  vendor?: string | null;
  expenseType: string;
  amountCents: number;
  amount: number;
  currency: string;
  isActive: boolean;
  serviceCategory?: string | null;
  startedAt?: Date | null;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BusinessFinanceSummary {
  totals: {
    recurringRevenueCents: number;
    recurringRevenue: number;
    serviceLinkedSpendCents: number;
    serviceLinkedSpend: number;
    businessOverheadCents: number;
    businessOverhead: number;
    totalSpendCents: number;
    totalSpend: number;
    netContributionCents: number;
    netContribution: number;
    activeLineCount: number;
    serviceCategoryCount: number;
  };
  services: BusinessFinanceServiceSummary[];
  businessRecurringExpenses: SerializedBusinessRecurringExpense[];
}

type MutableServiceSummary = {
  serviceCategory: string;
  revenueCents: number;
  salesmanPayoutCents: number;
  serviceExpenseCents: number;
  businessOverheadCents: number;
  activeLineCount: number;
  companyIds: Set<string>;
  salesmen: Map<string, { id: string; fullName?: string | null; email?: string | null; revenueCents: number; payoutCents: number }>;
  contractors: Map<string, { name: string; vendor?: string | null; amountCents: number; lineCount: number }>;
};

function centsToAmount(amountCents: number): number {
  return amountCents / 100;
}

export function computeDefaultPayoutCents(monthlyAmountCents: number): number {
  return Math.round(monthlyAmountCents * (DEFAULT_SALESMAN_SPLIT_PERCENT / 100));
}

export function sumRecurringExpenseCents(
  expenses: { amountCents: number; isRecurring: boolean }[],
): number {
  return expenses.reduce((sum, e) => sum + (e.isRecurring ? e.amountCents : 0), 0);
}

export function serializeBusinessRecurringExpense(
  row: BusinessRecurringExpenseRow,
): SerializedBusinessRecurringExpense {
  return {
    ...row,
    amount: centsToAmount(row.amountCents),
  };
}

function getOrCreateServiceSummary(
  map: Map<string, MutableServiceSummary>,
  serviceCategory: string,
): MutableServiceSummary {
  let summary = map.get(serviceCategory);
  if (!summary) {
    summary = {
      serviceCategory,
      revenueCents: 0,
      salesmanPayoutCents: 0,
      serviceExpenseCents: 0,
      businessOverheadCents: 0,
      activeLineCount: 0,
      companyIds: new Set<string>(),
      salesmen: new Map(),
      contractors: new Map(),
    };
    map.set(serviceCategory, summary);
  }
  return summary;
}

function addContractor(
  summary: MutableServiceSummary,
  name: string,
  vendor: string | null | undefined,
  amountCents: number,
): void {
  const key = `${name.toLowerCase()}::${(vendor ?? '').toLowerCase()}`;
  const existing = summary.contractors.get(key);
  if (existing) {
    existing.amountCents += amountCents;
    existing.lineCount += 1;
    return;
  }
  summary.contractors.set(key, {
    name,
    vendor,
    amountCents,
    lineCount: 1,
  });
}

function effectiveSalesmanPayoutCents(service: BusinessFinanceMonthlyServiceRow): number {
  if (!service.company?.assignedSalesman?.id) {
    return 0;
  }
  if (service.salesmanPayoutOverride) {
    return service.salesmanPayoutCents ?? 0;
  }
  return computeDefaultPayoutCents(service.monthlyAmountCents);
}

export function buildBusinessFinanceSummary(input: {
  monthlyServices: BusinessFinanceMonthlyServiceRow[];
  businessRecurringExpenses: BusinessRecurringExpenseRow[];
}): BusinessFinanceSummary {
  const serviceMap = new Map<string, MutableServiceSummary>();

  for (const service of input.monthlyServices) {
    const summary = getOrCreateServiceSummary(serviceMap, service.serviceCategory);
    const payoutCents = effectiveSalesmanPayoutCents(service);

    summary.revenueCents += service.monthlyAmountCents;
    summary.salesmanPayoutCents += payoutCents;
    summary.activeLineCount += 1;
    summary.companyIds.add(service.companyId);

    const salesman = service.company?.assignedSalesman;
    if (salesman?.id) {
      const existing = summary.salesmen.get(salesman.id) ?? {
        id: salesman.id,
        fullName: salesman.fullName,
        email: salesman.email,
        revenueCents: 0,
        payoutCents: 0,
      };
      existing.revenueCents += service.monthlyAmountCents;
      existing.payoutCents += payoutCents;
      summary.salesmen.set(salesman.id, existing);
    }

    for (const expense of service.expenses ?? []) {
      if (!expense.isRecurring) continue;
      summary.serviceExpenseCents += expense.amountCents;
      if (expense.expenseType === 'contractor') {
        addContractor(summary, expense.name, expense.vendor, expense.amountCents);
      }
    }
  }

  for (const expense of input.businessRecurringExpenses) {
    if (!expense.isActive) continue;
    if (!expense.serviceCategory) continue;
    const summary = getOrCreateServiceSummary(serviceMap, expense.serviceCategory);
    summary.businessOverheadCents += expense.amountCents;
    if (expense.expenseType === 'contractor') {
      addContractor(summary, expense.name, expense.vendor, expense.amountCents);
    }
  }

  const services = [...serviceMap.values()]
    .map((summary) => {
      const totalSpendCents =
        summary.salesmanPayoutCents + summary.serviceExpenseCents + summary.businessOverheadCents;
      return {
        serviceCategory: summary.serviceCategory,
        revenueCents: summary.revenueCents,
        revenue: centsToAmount(summary.revenueCents),
        salesmanPayoutCents: summary.salesmanPayoutCents,
        salesmanPayout: centsToAmount(summary.salesmanPayoutCents),
        serviceExpenseCents: summary.serviceExpenseCents,
        serviceExpenses: centsToAmount(summary.serviceExpenseCents),
        businessOverheadCents: summary.businessOverheadCents,
        businessOverhead: centsToAmount(summary.businessOverheadCents),
        totalSpendCents,
        totalSpend: centsToAmount(totalSpendCents),
        netContributionCents: summary.revenueCents - totalSpendCents,
        netContribution: centsToAmount(summary.revenueCents - totalSpendCents),
        activeLineCount: summary.activeLineCount,
        clientCount: summary.companyIds.size,
        salesmen: [...summary.salesmen.values()]
          .map((salesman) => ({
            ...salesman,
            revenue: centsToAmount(salesman.revenueCents),
            payout: centsToAmount(salesman.payoutCents),
          }))
          .sort((a, b) => b.revenueCents - a.revenueCents),
        contractors: [...summary.contractors.values()]
          .map((contractor) => ({
            ...contractor,
            amount: centsToAmount(contractor.amountCents),
          }))
          .sort((a, b) => b.amountCents - a.amountCents),
      };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents || a.serviceCategory.localeCompare(b.serviceCategory));

  const recurringExpenses = input.businessRecurringExpenses
    .map(serializeBusinessRecurringExpense)
    .sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const recurringRevenueCents = services.reduce((sum, service) => sum + service.revenueCents, 0);
  const serviceLinkedSpendCents = services.reduce(
    (sum, service) => sum + service.salesmanPayoutCents + service.serviceExpenseCents,
    0,
  );
  const businessOverheadCents = recurringExpenses
    .filter((expense) => expense.isActive)
    .reduce((sum, expense) => sum + expense.amountCents, 0);
  const totalSpendCents = serviceLinkedSpendCents + businessOverheadCents;

  return {
    totals: {
      recurringRevenueCents,
      recurringRevenue: centsToAmount(recurringRevenueCents),
      serviceLinkedSpendCents,
      serviceLinkedSpend: centsToAmount(serviceLinkedSpendCents),
      businessOverheadCents,
      businessOverhead: centsToAmount(businessOverheadCents),
      totalSpendCents,
      totalSpend: centsToAmount(totalSpendCents),
      netContributionCents: recurringRevenueCents - totalSpendCents,
      netContribution: centsToAmount(recurringRevenueCents - totalSpendCents),
      activeLineCount: services.reduce((sum, service) => sum + service.activeLineCount, 0),
      serviceCategoryCount: services.length,
    },
    services,
    businessRecurringExpenses: recurringExpenses,
  };
}
