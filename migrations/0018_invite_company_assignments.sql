CREATE TABLE "invite_company_assignments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invite_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "relationship_type" TEXT,
    "staff_tag_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invite_company_assignments_invite_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "invites" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invite_company_assignments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invite_company_assignments_staff_tag_id_fkey" FOREIGN KEY ("staff_tag_id") REFERENCES "staff_tags" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "invite_company_assignments_invite_id_idx" ON "invite_company_assignments"("invite_id");
CREATE INDEX "invite_company_assignments_company_id_idx" ON "invite_company_assignments"("company_id");
CREATE INDEX "invite_company_assignments_staff_tag_id_idx" ON "invite_company_assignments"("staff_tag_id");
