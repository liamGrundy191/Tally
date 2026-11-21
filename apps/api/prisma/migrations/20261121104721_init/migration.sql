-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'reviewer');

-- CreateEnum
CREATE TYPE "MonthStatus" AS ENUM ('open', 'closing', 'closed');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('processing', 'verified', 'needs_review', 'needs_manual_entry', 'excluded');

-- CreateEnum
CREATE TYPE "VerifiedHow" AS ENUM ('auto', 'confirmed', 'corrected', 'manual');

-- CreateEnum
CREATE TYPE "ExtractionPass" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "ListKind" AS ENUM ('workplace', 'name');

-- CreateEnum
CREATE TYPE "DownloadKind" AS ENUM ('excel', 'pdfs');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "totpSecret" TEXT,
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Month" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "MonthStatus" NOT NULL DEFAULT 'open',
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,
    "summaryTicketCount" INTEGER,
    "summaryTotalMinutes" INTEGER,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Month_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Upload" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "uploadedById" UUID NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "s3KeyOriginal" TEXT,
    "sha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "pageCount" INTEGER,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "uploadId" UUID NOT NULL,
    "monthId" UUID,
    "pageIndex" INTEGER NOT NULL,
    "s3KeyPage" TEXT NOT NULL,
    "s3KeyNormalised" TEXT,
    "templateVersion" TEXT,
    "firstName" TEXT,
    "workerName" TEXT,
    "workplaceRaw" TEXT,
    "workplaceGroupId" UUID,
    "shiftDate" DATE,
    "startMinutes" INTEGER,
    "endMinutes" INTEGER,
    "totalMinutes" INTEGER,
    "status" "TicketStatus" NOT NULL DEFAULT 'processing',
    "verifiedHow" "VerifiedHow",
    "excludedReason" TEXT,
    "excludedById" UUID,
    "replacedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkplaceGroup" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "monthId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "normalisedName" TEXT NOT NULL,
    "mergedIntoId" UUID,

    CONSTRAINT "WorkplaceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListEntry" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "monthId" UUID NOT NULL,
    "kind" "ListKind" NOT NULL,
    "name" TEXT NOT NULL,
    "spellings" TEXT[],

    CONSTRAINT "ListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldExtraction" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ticketId" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "pass" "ExtractionPass" NOT NULL,
    "value" TEXT,
    "legible" BOOLEAN NOT NULL,
    "suggestion" TEXT,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,

    CONSTRAINT "FieldExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Flag" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ticketId" UUID NOT NULL,
    "field" TEXT,
    "code" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "relatedTicketId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "resolution" TEXT,

    CONSTRAINT "Flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "monthId" UUID,
    "userId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Download" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "monthId" UUID NOT NULL,
    "kind" "DownloadKind" NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "Download_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Month_year_month_key" ON "Month"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Upload_sha256_key" ON "Upload"("sha256");

-- CreateIndex
CREATE INDEX "Ticket_monthId_status_idx" ON "Ticket"("monthId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_uploadId_pageIndex_key" ON "Ticket"("uploadId", "pageIndex");

-- CreateIndex
CREATE INDEX "WorkplaceGroup_monthId_idx" ON "WorkplaceGroup"("monthId");

-- CreateIndex
CREATE UNIQUE INDEX "ListEntry_monthId_kind_name_key" ON "ListEntry"("monthId", "kind", "name");

-- CreateIndex
CREATE INDEX "FieldExtraction_ticketId_idx" ON "FieldExtraction"("ticketId");

-- CreateIndex
CREATE INDEX "Flag_ticketId_idx" ON "Flag"("ticketId");

-- CreateIndex
CREATE INDEX "AuditEntry_monthId_idx" ON "AuditEntry"("monthId");

-- CreateIndex
CREATE INDEX "Download_monthId_idx" ON "Download"("monthId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Month" ADD CONSTRAINT "Month_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_monthId_fkey" FOREIGN KEY ("monthId") REFERENCES "Month"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_workplaceGroupId_fkey" FOREIGN KEY ("workplaceGroupId") REFERENCES "WorkplaceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_excludedById_fkey" FOREIGN KEY ("excludedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkplaceGroup" ADD CONSTRAINT "WorkplaceGroup_monthId_fkey" FOREIGN KEY ("monthId") REFERENCES "Month"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkplaceGroup" ADD CONSTRAINT "WorkplaceGroup_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "WorkplaceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListEntry" ADD CONSTRAINT "ListEntry_monthId_fkey" FOREIGN KEY ("monthId") REFERENCES "Month"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldExtraction" ADD CONSTRAINT "FieldExtraction_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_relatedTicketId_fkey" FOREIGN KEY ("relatedTicketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEntry" ADD CONSTRAINT "AuditEntry_monthId_fkey" FOREIGN KEY ("monthId") REFERENCES "Month"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEntry" ADD CONSTRAINT "AuditEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Download" ADD CONSTRAINT "Download_monthId_fkey" FOREIGN KEY ("monthId") REFERENCES "Month"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Download" ADD CONSTRAINT "Download_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
