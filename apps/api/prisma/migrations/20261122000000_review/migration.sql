-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "readRound" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "suggestions" JSONB NOT NULL DEFAULT '{}';
