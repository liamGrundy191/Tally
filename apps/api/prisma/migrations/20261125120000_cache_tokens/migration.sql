-- The cached start of each reading request (D65).
ALTER TABLE "Reading" ADD COLUMN "cacheReadTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Reading" ADD COLUMN "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0;
