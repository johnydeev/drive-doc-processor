-- Agregar columnas nuevas
ALTER TABLE "Consortium" ADD COLUMN "bank" TEXT;
ALTER TABLE "Consortium" ADD COLUMN "suterhKey" TEXT;

-- Copiar datos existentes (por si ya había algo cargado)
UPDATE "Consortium" SET "bank" = "banco", "suterhKey" = "claveSuterh";

-- Eliminar columnas viejas
ALTER TABLE "Consortium" DROP COLUMN "banco";
ALTER TABLE "Consortium" DROP COLUMN "claveSuterh";
