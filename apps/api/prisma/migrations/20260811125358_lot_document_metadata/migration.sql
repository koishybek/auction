-- AlterTable
ALTER TABLE "lot_documents" ADD COLUMN     "content_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
ADD COLUMN     "file_name" TEXT NOT NULL DEFAULT 'document',
ADD COLUMN     "size_bytes" INTEGER NOT NULL DEFAULT 0;
