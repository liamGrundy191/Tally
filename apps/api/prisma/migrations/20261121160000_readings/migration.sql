-- CreateEnum
CREATE TYPE "ReadSpeed" AS ENUM ('now', 'batch');

-- DropForeignKey
ALTER TABLE "FieldExtraction" DROP CONSTRAINT "FieldExtraction_ticketId_fkey";

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "totalFromMath" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "failedPages" INTEGER[],
ADD COLUMN     "speed" "ReadSpeed" NOT NULL DEFAULT 'batch';

-- DropTable
DROP TABLE "FieldExtraction";

-- CreateTable
CREATE TABLE "Reading" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ticketId" UUID NOT NULL,
    "pass" "ExtractionPass" NOT NULL,
    "listsKey" TEXT NOT NULL,
    "answer" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,

    CONSTRAINT "Reading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Reading_ticketId_pass_listsKey_key" ON "Reading"("ticketId", "pass", "listsKey");

-- AddForeignKey
ALTER TABLE "Reading" ADD CONSTRAINT "Reading_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

