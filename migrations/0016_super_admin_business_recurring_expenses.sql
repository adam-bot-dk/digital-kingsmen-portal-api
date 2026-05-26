ALTER TABLE "users" ADD COLUMN "is_super_admin" INTEGER NOT NULL DEFAULT 0;

UPDATE "users"
SET "is_super_admin" = 1
WHERE lower("email") = 'admin@digitalkingsmen.com';

CREATE TABLE "business_recurring_expenses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "vendor" TEXT,
    "expense_type" TEXT NOT NULL DEFAULT 'other',
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "is_active" INTEGER NOT NULL DEFAULT 1,
    "service_category" TEXT,
    "started_at" DATETIME,
    "notes" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE INDEX "business_recurring_expenses_is_active_idx" ON "business_recurring_expenses"("is_active");
CREATE INDEX "business_recurring_expenses_service_category_idx" ON "business_recurring_expenses"("service_category");
