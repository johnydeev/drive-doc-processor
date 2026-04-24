ALTER TABLE "Payment"
  ALTER COLUMN "driveFileId" DROP NOT NULL,
  ALTER COLUMN "driveFileUrl" DROP NOT NULL;

ALTER TABLE "Payment"
  ADD COLUMN "paymentMethod" TEXT;
