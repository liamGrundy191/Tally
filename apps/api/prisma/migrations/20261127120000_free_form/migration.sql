-- Other tickets, typed in by a person from the scan (D68).
ALTER TABLE "Upload" ADD COLUMN "freeForm" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Ticket" ADD COLUMN "shiftIndex" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "freeForm" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "Ticket_uploadId_pageIndex_key";
CREATE UNIQUE INDEX "Ticket_uploadId_pageIndex_shiftIndex_key" ON "Ticket"("uploadId", "pageIndex", "shiftIndex");
