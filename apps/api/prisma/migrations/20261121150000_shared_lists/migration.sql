-- DropForeignKey
ALTER TABLE "ListEntry" DROP CONSTRAINT "ListEntry_monthId_fkey";

-- DropIndex
DROP INDEX "ListEntry_monthId_kind_name_key";

-- AlterTable
ALTER TABLE "ListEntry" DROP COLUMN "monthId";

-- AlterTable
ALTER TABLE "Ticket" DROP COLUMN "s3KeyNormalised";

-- CreateIndex
CREATE UNIQUE INDEX "ListEntry_kind_name_key" ON "ListEntry"("kind", "name");

