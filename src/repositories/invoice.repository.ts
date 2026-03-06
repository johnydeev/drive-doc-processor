import { createHash } from "crypto";
import { Invoice } from "@prisma/client";
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

    const prisma = getPrismaClient();
    const invoice = await prisma.invoice.findFirst({
      where: {
        clientId,
        boletaNumberNorm: parts.boletaNumberNorm,
        providerTaxIdNorm: parts.providerTaxIdNorm,
        dueDateNorm: parts.dueDateNorm,
        amountNorm: parts.amountNorm,
      },
    });

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
          documentHash: input.documentHash,
          driveFileId: input.fileId,
          sourceFileUrl: input.sourceFileUrl,
          isDuplicate: input.isDuplicate,
          boletaNumber: input.extraction.boletaNumber,
          provider: input.extraction.provider,
          consortium: input.extraction.consortium,
          providerTaxId: input.extraction.providerTaxId,
          detail: input.extraction.detail,
          observation: input.extraction.observation,
          dueDate: parseDueDate(input.extraction.dueDate),
          amount: input.extraction.amount,
          alias: input.extraction.alias,
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
          providerTaxId: input.extraction.providerTaxId,
          detail: input.extraction.detail,
          observation: input.extraction.observation,
          dueDate: parseDueDate(input.extraction.dueDate),
          amount: input.extraction.amount,
          alias: input.extraction.alias,
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
