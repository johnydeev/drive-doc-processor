import { createHash } from "crypto";
import { Invoice, Prisma } from "@prisma/client";
import {
  buildBusinessKeyParts,
  buildBusinessKeyString,
  BusinessKeyParts,
} from "@/lib/businessKey";
import { getPrismaClient } from "@/lib/prisma";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

export interface DuplicateLookupResult {
  extraction: Omit<ExtractedDocumentData, "sourceFileUrl" | "isDuplicate"> | null;
  sourceFileUrl?: string;
  fileId?: string;
  businessKey: string | null;
}

export interface SaveInvoiceInput {
  clientId: string;
  documentHash: string;
  fileId: string;
  sourceFileUrl?: string;
  extraction: Omit<ExtractedDocumentData, "sourceFileUrl" | "isDuplicate">;
  isDuplicate: boolean;
  consortiumId?: string;
  providerId?: string;
  periodId?: string;
  lspServiceId?: string | null;
  paymentMethod?: string | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  tokensTotal?: number | null;
  aiProvider?: string | null;
  aiModel?: string | null;
}

export class InvoiceRepository {
  computeDocumentHash(input: Buffer | string): string {
    return createHash("sha256").update(input).digest("hex");
  }

  buildBusinessKeyFromData(data: ExtractedDocumentData): string | null {
    return buildBusinessKeyString(buildBusinessKeyParts(data));
  }

  async findDuplicateByHash(clientId: string, documentHash: string): Promise<DuplicateLookupResult | null> {
    const prisma = getPrismaClient();
    const invoice = await prisma.invoice.findUnique({
      where: {
        clientId_documentHash: {
          clientId,
          documentHash,
        },
      },
    });

    if (!invoice) {
      return null;
    }

    console.log(
      `[invoice-repo] duplicate-by-hash source=db clientId=${clientId} hash=${shortHash(documentHash)}`
    );

    return this.mapInvoiceDuplicate(invoice);
  }

  async findDuplicateByBusinessKey(
    clientId: string,
    data: ExtractedDocumentData
  ): Promise<DuplicateLookupResult | null> {
    const parts = buildBusinessKeyParts(data);
    const businessKey = buildBusinessKeyString(parts);
    if (!businessKey) {
      return null;
    }

    // Si hay boletaNumber, es el campo primario — debe coincidir exactamente.
    // Si no hay boletaNumber, buscar por los demás campos presentes.
    // Solo se incluyen en el WHERE los campos no vacíos para evitar matches
    // contra filas con strings vacíos.
    const whereClause: Prisma.InvoiceWhereInput = { clientId };

    if (parts.boletaNumberNorm) {
      whereClause.boletaNumberNorm = parts.boletaNumberNorm;
    }
    if (parts.providerTaxIdNorm) {
      whereClause.providerTaxIdNorm = parts.providerTaxIdNorm;
    }
    if (parts.dueDateNorm) {
      whereClause.dueDateNorm = parts.dueDateNorm;
    }
    if (parts.amountNorm) {
      whereClause.amountNorm = parts.amountNorm;
    }

    // Requerir al menos 2 campos presentes para considerar un posible duplicado
    const conditionCount = [
      parts.boletaNumberNorm,
      parts.providerTaxIdNorm,
      parts.dueDateNorm,
      parts.amountNorm,
    ].filter(Boolean).length;

    if (conditionCount < 2) return null;

    const prisma = getPrismaClient();
    const invoice = await prisma.invoice.findFirst({ where: whereClause });

    if (!invoice) {
      return null;
    }

    console.log(
      `[invoice-repo] duplicate-by-business-key source=db clientId=${clientId} key=${shortKey(
        businessKey
      )}`
    );

    return this.mapInvoiceDuplicate(invoice);
  }

  async findByPeriod(periodId: string): Promise<Invoice[]> {
    const prisma = getPrismaClient();
    return prisma.invoice.findMany({
      where: { periodId },
      orderBy: { createdAt: "desc" },
    });
  }

  async findByConsortium(consortiumId: string, clientId: string): Promise<Invoice[]> {
    const prisma = getPrismaClient();
    return prisma.invoice.findMany({
      where: { consortiumId, clientId },
      orderBy: { createdAt: "desc" },
    });
  }

  async saveProcessedInvoice(input: SaveInvoiceInput): Promise<void> {
    const parts = ensurePersistableBusinessKeyParts(
      buildBusinessKeyParts(input.extraction),
      input.documentHash
    );

    const prisma = getPrismaClient();

    try {
      await prisma.invoice.upsert({
        where: {
          clientId_documentHash: {
            clientId: input.clientId,
            documentHash: input.documentHash,
          },
        },
        create: {
          clientId: input.clientId,
          consortiumId: input.consortiumId ?? null,
          documentHash: input.documentHash,
          driveFileId: input.fileId,
          sourceFileUrl: input.sourceFileUrl,
          isDuplicate: input.isDuplicate,
          boletaNumber: input.extraction.boletaNumber,
          provider: input.extraction.provider,
          consortium: input.extraction.consortium,
          providerId: input.providerId ?? null,
          providerTaxId: input.extraction.providerTaxId,
          detail: input.extraction.detail,
          observation: input.extraction.observation,
          dueDate: parseDueDate(input.extraction.dueDate),
          periodId: input.periodId ?? null,
          amount: input.extraction.amount,
          alias: input.extraction.alias,
          lspServiceId: input.lspServiceId ?? null,
          paymentMethod: input.paymentMethod as any ?? null,
          tokensInput: input.tokensInput ?? null,
          tokensOutput: input.tokensOutput ?? null,
          tokensTotal: input.tokensTotal ?? null,
          aiProvider: input.aiProvider ?? null,
          aiModel: input.aiModel ?? null,
          boletaNumberNorm: parts.boletaNumberNorm,
          providerTaxIdNorm: parts.providerTaxIdNorm,
          dueDateNorm: parts.dueDateNorm,
          amountNorm: parts.amountNorm,
        },
        update: {
          driveFileId: input.fileId,
          sourceFileUrl: input.sourceFileUrl,
          isDuplicate: input.isDuplicate,
          boletaNumber: input.extraction.boletaNumber,
          provider: input.extraction.provider,
          consortium: input.extraction.consortium,
          consortiumId: input.consortiumId ?? null,
          providerId: input.providerId ?? null,
          providerTaxId: input.extraction.providerTaxId,
          detail: input.extraction.detail,
          observation: input.extraction.observation,
          dueDate: parseDueDate(input.extraction.dueDate),
          periodId: input.periodId ?? null,
          amount: input.extraction.amount,
          alias: input.extraction.alias,
          lspServiceId: input.lspServiceId ?? null,
          paymentMethod: input.paymentMethod as any ?? null,
          tokensInput: input.tokensInput ?? null,
          tokensOutput: input.tokensOutput ?? null,
          tokensTotal: input.tokensTotal ?? null,
          aiProvider: input.aiProvider ?? null,
          aiModel: input.aiModel ?? null,
          boletaNumberNorm: parts.boletaNumberNorm,
          providerTaxIdNorm: parts.providerTaxIdNorm,
          dueDateNorm: parts.dueDateNorm,
          amountNorm: parts.amountNorm,
        },
      });

      console.log(
        `[invoice-repo] save source=db clientId=${input.clientId} hash=${shortHash(input.documentHash)} duplicate=${input.isDuplicate}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      const isUniqueConflict = message.includes("p2002") || message.includes("unique constraint");

      if (isUniqueConflict) {
        console.warn(
          `[invoice-repo] save unique-conflict clientId=${input.clientId} hash=${shortHash(input.documentHash)}`
        );
        return;
      }

      throw error;
    }
  }

  private mapInvoiceDuplicate(invoice: Invoice): DuplicateLookupResult {
    return {
      extraction: {
        boletaNumber: invoice.boletaNumber,
        provider: invoice.provider,
        consortium: invoice.consortium,
        providerTaxId: invoice.providerTaxId,
        detail: invoice.detail,
        observation: invoice.observation,
        dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
        amount: invoice.amount !== null ? Number(invoice.amount) : null,
        alias: invoice.alias,
        clientNumber: null,
        paymentMethod: null,
      },
      sourceFileUrl: invoice.sourceFileUrl ?? undefined,
      fileId: invoice.driveFileId ?? undefined,
      businessKey: buildBusinessKeyString({
        boletaNumberNorm: invoice.boletaNumberNorm,
        providerTaxIdNorm: invoice.providerTaxIdNorm,
        dueDateNorm: invoice.dueDateNorm,
        amountNorm: invoice.amountNorm,
      }),
    };
  }
}

function ensurePersistableBusinessKeyParts(
  parts: BusinessKeyParts,
  documentHash: string
): BusinessKeyParts {
  if (buildBusinessKeyString(parts)) {
    return parts;
  }

  return {
    ...parts,
    boletaNumberNorm: `__hash__${documentHash.toLowerCase()}`,
  };
}

function parseDueDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function shortHash(hash: string): string {
  if (hash.length <= 12) {
    return hash;
  }

  return `${hash.slice(0, 6)}...${hash.slice(-6)}`;
}

function shortKey(key: string): string {
  return key.length > 70 ? `${key.slice(0, 70)}...` : key;
}
