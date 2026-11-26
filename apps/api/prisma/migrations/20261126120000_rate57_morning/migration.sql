-- The *57 rate and the morning hours (D66).
ALTER TYPE "ListKind" ADD VALUE 'rate57';

-- null until a person saves the ticket: the 57 list may pre-tick it only then.
ALTER TABLE "Ticket" ADD COLUMN "rate57" BOOLEAN;

CREATE TABLE "MorningHours" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "monthId" UUID NOT NULL,
    "workplaceGroupId" UUID NOT NULL,
    "minutes" INTEGER NOT NULL,

    CONSTRAINT "MorningHours_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MorningHours_monthId_idx" ON "MorningHours"("monthId");

ALTER TABLE "MorningHours" ADD CONSTRAINT "MorningHours_monthId_fkey" FOREIGN KEY ("monthId") REFERENCES "Month"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MorningHours" ADD CONSTRAINT "MorningHours_workplaceGroupId_fkey" FOREIGN KEY ("workplaceGroupId") REFERENCES "WorkplaceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
