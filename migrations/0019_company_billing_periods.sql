-- Client billing periods and per-service allocations
ALTER TABLE "companies" ADD COLUMN "billing_due_day_of_month" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "company_billing_periods" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "company_id" TEXT NOT NULL,
    "period_start" DATETIME NOT NULL,
    "period_end" DATETIME NOT NULL,
    "due_date" DATETIME NOT NULL,
    "expected_amount_cents" INTEGER NOT NULL,
    "paid_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "payment_status" TEXT NOT NULL DEFAULT 'unpaid',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "paid_at" DATETIME,
    "waived_at" DATETIME,
    "notes" TEXT,
    "external_reference" TEXT,
    "created_by_id" TEXT,
    "updated_by_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "company_billing_periods_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "company_billing_periods_company_id_period_start_key" ON "company_billing_periods"("company_id", "period_start");
CREATE INDEX "company_billing_periods_company_id_idx" ON "company_billing_periods"("company_id");
CREATE INDEX "company_billing_periods_payment_status_idx" ON "company_billing_periods"("payment_status");
CREATE INDEX "company_billing_periods_due_date_idx" ON "company_billing_periods"("due_date");
CREATE INDEX "company_billing_periods_period_start_idx" ON "company_billing_periods"("period_start");

CREATE TABLE "company_billing_allocations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billing_period_id" TEXT NOT NULL,
    "monthly_service_id" TEXT NOT NULL,
    "expected_amount_cents" INTEGER NOT NULL,
    "line_status" TEXT NOT NULL DEFAULT 'billable',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "company_billing_allocations_billing_period_id_fkey" FOREIGN KEY ("billing_period_id") REFERENCES "company_billing_periods" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "company_billing_allocations_monthly_service_id_fkey" FOREIGN KEY ("monthly_service_id") REFERENCES "company_monthly_services" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "company_billing_allocations_billing_period_id_monthly_service_id_key" ON "company_billing_allocations"("billing_period_id", "monthly_service_id");
CREATE INDEX "company_billing_allocations_billing_period_id_idx" ON "company_billing_allocations"("billing_period_id");
CREATE INDEX "company_billing_allocations_monthly_service_id_idx" ON "company_billing_allocations"("monthly_service_id");
