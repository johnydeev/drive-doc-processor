import { env } from "@/config/env";
import { normalizeConsortiumName, consortiumFuzzyMatch, consortiumAliasMatch } from "@/lib/consortiumNormalizer";
import { identifyLSPProvider, LSPProvider, LSP_FALLBACK_NAMES } from "@/lib/extraction";
import { refineExtractionWithRawText } from "@/lib/extraction";
import { createEmptyTokenUsageSummary } from "@/lib/createEmptyTokenUsageSummary";
import { pipelineLog } from "@/lib/logger";
import { accumulateTokenUsage } from "@/types/aiUsage.types";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";
import { ProcessJobSummary } from "@/types/process.types";
import { ClientGoogleConfig } from "@/types/client.types";
import { ConsortiumRepository } from "@/repositories/consortium.repository";
import { InvoiceRepository } from "@/repositories/invoice.repository";
import { ProviderRepository } from "@/repositories/provider.repository";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { GoogleSheetsService, SheetsRowMapping } from "@/services/googleSheets.service";
import { PdfTextExtractorService } from "@/services/pdfTextExtractor.service";
import { getPrismaClient } from "@/lib/prisma";

export interface ProcessJobConfig {
  clientId: string;
  clientName: string;
  sheetName: string;
  mapping?: SheetsRowMapping;
  drivePendingFolderId?: string;
  driveScannedFolderId?: string;
  driveUnassignedFolderId?: string | null;
  driveFailedFolderId?: string | null;
  driveProcessingFolderId?: string | null;
  googleConfig?: ClientGoogleConfig | null;
  aiConfig?: {
    geminiApiKey?: string;
    geminiModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
  } | null;
  debugMode?: boolean;
}

export interface ProcessDriveFileInput {
  id: string;
  name: string;
  mimeType?: string | null;
  webViewLink?: string | null;
}

type GeminiModule = typeof import("@/services/geminiExtractor.service");
type OpenAiModule = typeof import("@/services/aiExtractor.service");

type ProcessingContext = {
  resolvedConfig: ProcessJobConfig;
  resolvedMapping: SheetsRowMapping;
  driveService: GoogleDriveService;
  pdfExtractor: PdfTextExtractorService;
  sheetsService: GoogleSheetsService;
  invoiceRepository: InvoiceRepository;
  consortiumRepository: ConsortiumRepository;
  providerRepository: ProviderRepository;
  geminiModule: GeminiModule | null;
  openAiModule: OpenAiModule | null;
  geminiApiKey?: string;
  openaiApiKey?: string;
  geminiModel?: string;
  openaiModel?: string;
  existingDuplicateKeys: Set<string>;
};

const DEFAULT_MAPPING: SheetsRowMapping = {
  boletaNumber: "A",
  provider: "B",
  consortium: "C",
  providerTaxId: "D",
  detail: "E",
  observation: "F",
  dueDate: "G",
  amount: "H",
  alias: "I",
  clientNumber: "J",
  sourceFileUrl: "K",
  isDuplicate: "L",
  period: "M",
  paymentStatus: "N",
  bank: "O",
};

function createBaseSummary(totalFound: number): ProcessJobSummary {
  return {
    clientId: "",
    clientName: "",
    totalFound,
    processed: 0,
    skipped: 0,
    failed: 0,
    unassigned: 0,
    duplicatesDetected: 0,
    errors: [],
    tokenUsage: createEmptyTokenUsageSummary(),
  };
}

/** Traduce el nombre corto del router LSP al nombre canónico (razón social) en DB */
const LSP_ROUTER_TO_CANONICAL: Record<string, string> = {
  "PERSONAL":    "TELECOM ARGENTINA S.A.",
  "EDESUR":      "EDESUR S.A.",
  "EDENOR":      "EDENOR S.A.",
  "AYSA":        "AYSA S.A.",
  "METROGAS":    "METROGAS S.A.",
  "NATURGY":     "NATURGY S.A.",
  "CAMUZZI":     "CAMUZZI GAS PAMPEANA S.A.",
  "LITORAL_GAS": "LITORAL GAS S.A.",
};

function buildDriveFileUrl(fileId: string, webViewLink?: string | null): string {
  return webViewLink?.trim() || `https://drive.google.com/file/d/${fileId}/view`;
}

function buildOcrOnlyPayload(): ExtractedDocumentData {
  return {
    boletaNumber: null,
    provider: null,
    consortium: null,
    providerTaxId: null,
    detail: null,
    observation: "OCR_ONLY",
    dueDate: null,
    amount: null,
    alias: null,
    clientNumber: null,
    paymentMethod: null,
    allTaxIds: [],
  };
}

function formatPeriodLabel(month: number, year: number): string {
  return `${String(month).padStart(2, "0")}/${year}`;
}

function normCuit(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

function normName(v: string | null | undefined): string {
  const LEGAL_SUFFIXES = /\b(s\.?r\.?l\.?|s\.?a\.?|s\.?a\.?s\.?|s\.?c\.?s?\.?|s\.?h\.?|ltda?\.?|e\.?i\.?r\.?l\.?|s\.?a\.?u\.?)\b/gi;
  return (v ?? "")
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[.,\-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function createProcessingContext(
  config: ProcessJobConfig,
  mapping: SheetsRowMapping
): Promise<ProcessingContext> {
  const driveService = new GoogleDriveService(config.googleConfig);
  const pdfExtractor = new PdfTextExtractorService();
  const sheetsService = new GoogleSheetsService(config.googleConfig);
  const invoiceRepository = new InvoiceRepository();
  const consortiumRepository = new ConsortiumRepository();
  const providerRepository = new ProviderRepository();
  const geminiApiKey = config.aiConfig?.geminiApiKey?.trim() || env.GEMINI_API_KEY?.trim();
  const openaiApiKey = config.aiConfig?.openaiApiKey?.trim() || env.OPENAI_API_KEY?.trim();
  const geminiModel = config.aiConfig?.geminiModel?.trim() || env.GEMINI_MODEL;
  const openaiModel = config.aiConfig?.openaiModel?.trim() || env.OPENAI_MODEL;
  const geminiModule = geminiApiKey ? await import("@/services/geminiExtractor.service") : null;
  const openAiModule = openaiApiKey ? await import("@/services/aiExtractor.service") : null;

  let existingDuplicateKeys = new Set<string>();
  try {
    existingDuplicateKeys = await sheetsService.getExistingDuplicateKeys(config.sheetName, mapping);
  } catch (error) {
    pipelineLog.stepStart(config.clientId, `Dedup bootstrap falló: ${error instanceof Error ? error.message : "Unknown"}`);
  }

  return {
    resolvedConfig: config, resolvedMapping: mapping, driveService, pdfExtractor,
    sheetsService, invoiceRepository, consortiumRepository, providerRepository,
    geminiModule, openAiModule, geminiApiKey, openaiApiKey, geminiModel, openaiModel,
    existingDuplicateKeys,
  };
}

interface AssignmentResult {
  consortiumId: string | undefined;
  providerId: string | undefined;
  periodId: string | undefined;
  periodLabel: string | null;
  lspServiceId: string | null;
  unassigned: boolean;
  unassignedReason: string | null;
  canonicalConsortium: string | null;
  canonicalProvider: string | null;
  canonicalProviderTaxId: string | null;
  providerPaymentAlias: string | null;
  consortiumBank: string | null;
}

async function resolveAssignment(
  extracted: ExtractedDocumentData,
  clientId: string,
  fileId: string,
  consortiumRepository: ConsortiumRepository,
  providerRepository: ProviderRepository,
  lspProvider: LSPProvider | null
): Promise<AssignmentResult> {
  const base: AssignmentResult = {
    consortiumId: undefined, providerId: undefined, periodId: undefined,
    periodLabel: null, lspServiceId: null,
    unassigned: true, unassignedReason: null,
    canonicalConsortium: null, canonicalProvider: null, canonicalProviderTaxId: null,
    providerPaymentAlias: null, consortiumBank: null,
  };

  const prisma = getPrismaClient();

  // ── 0. LSP fast path: resolver proveedor por CUIT + LspService por clientNumber ──

  const normalizedClientNumber = extracted.clientNumber?.replace(/\s+/g, "").replace(/^0+/, "") || null;
  const allTaxIds = (extracted.allTaxIds ?? []).map((c) => normCuit(c)).filter((c) => c.length >= 10);

  // Resolver proveedor LSP por CUIT en tabla Provider
  let lspProviderId: string | null = null;
  let lspProviderCanonical: string | null = null;
  let lspProviderTaxId: string | null = null;
  let lspProviderAlias: string | null = null;

  if (lspProvider && allTaxIds.length > 0) {
    const allProviders = await prisma.provider.findMany({
      where: { clientId },
      select: { id: true, canonicalName: true, cuit: true, paymentAlias: true },
    });

    for (const cuit of allTaxIds) {
      const found = allProviders.find((p) => normCuit(p.cuit) === cuit);
      if (found) {
        lspProviderId = found.id;
        lspProviderCanonical = found.canonicalName;
        lspProviderTaxId = found.cuit;
        lspProviderAlias = found.paymentAlias ?? null;
        pipelineLog.lspProviderResolvedFromDB(clientId, found.canonicalName, cuit);
        break;
      }
    }

    if (!lspProviderId) {
      pipelineLog.lspProviderNotInDB(clientId, lspProvider);
    }
  }

  // Traducir nombre del router al nombre canónico en DB
  const lspProviderCanonicalName = lspProvider ? (LSP_ROUTER_TO_CANONICAL[lspProvider] ?? lspProvider) : null;

  if (lspProvider && lspProvider !== "GENERIC_LSP" && normalizedClientNumber) {
    try {
      const lspInclude = {
        consortium: { select: { id: true, canonicalName: true, rawName: true, bank: true } },
        providerRef: { select: { id: true, canonicalName: true, cuit: true, paymentAlias: true } },
      } as const;

      // Intento 1: buscar por providerId (FK) si lo tenemos
      let lspService = lspProviderId
        ? await prisma.lspService.findFirst({
            where: { clientId, providerId: lspProviderId, clientNumber: normalizedClientNumber },
            include: lspInclude,
          })
        : null;

      // Intento 2: fallback a campo texto providerName (nombre canónico)
      if (!lspService) {
        lspService = await prisma.lspService.findFirst({
          where: { clientId, providerName: lspProviderCanonicalName!, clientNumber: normalizedClientNumber },
          include: lspInclude,
        });
      }

      if (lspService) {
        pipelineLog.stepStart(clientId, `LspService match: ${lspProvider} clientNumber=${lspService.clientNumber}`);

        // Actualizar providerId si no estaba seteado y lo tenemos
        if (lspProviderId && !lspService.providerId) {
          await prisma.lspService.update({
            where: { id: lspService.id },
            data: { providerId: lspProviderId },
          }).catch(() => { /* non-fatal */ });
        }

        // Resolver proveedor: preferir CUIT lookup, luego FK del LspService
        const resolvedProvider = lspProviderId
          ? { id: lspProviderId, canonicalName: lspProviderCanonical, cuit: lspProviderTaxId, paymentAlias: lspProviderAlias }
          : lspService.providerRef;

        const activePeriod = await consortiumRepository.findActivePeriod(lspService.consortiumId);

        return {
          consortiumId: lspService.consortiumId,
          providerId: resolvedProvider?.id ?? undefined,
          periodId: activePeriod?.id,
          periodLabel: activePeriod ? formatPeriodLabel(activePeriod.month, activePeriod.year) : null,
          lspServiceId: lspService.id,
          unassigned: false,
          unassignedReason: null,
          canonicalConsortium: lspService.consortium.rawName,
          canonicalProvider: resolvedProvider?.canonicalName ?? LSP_FALLBACK_NAMES[lspProvider] ?? lspProvider,
          canonicalProviderTaxId: resolvedProvider?.cuit ?? extracted.providerTaxId,
          providerPaymentAlias: resolvedProvider?.paymentAlias ?? null,
          consortiumBank: lspService.consortium.bank ?? null,
        };
      }

      pipelineLog.lspClientNumberNotRegistered(clientId, lspProviderCanonicalName!, normalizedClientNumber);
      return {
        ...base,
        unassigned: true,
        unassignedReason: `LSP ${lspProviderCanonicalName} - Nro cliente ${normalizedClientNumber} no registrado en LspServices`,
      };
    } catch (err) {
      pipelineLog.stepStart(clientId, `LspService lookup error: ${err instanceof Error ? err.message : "Unknown"} → fallback a matching normal`);
    }
  }

  // ── 1. Consorcio ─────────────────────────────────────────────────────────

  const rawConsortium = extracted.consortium?.trim() ?? null;

  const allConsortiums = await prisma.consortium.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true, rawName: true, cuit: true, matchNames: true },
  });

  let consortiumRow: typeof allConsortiums[0] | undefined;
  let matchMethod = "";

  // Intento 0: match por CUIT (allTaxIds) — incluye CUITs alternativos en matchNames
  if (allTaxIds.length > 0) {
    for (const cuit of allTaxIds) {
      const found = allConsortiums.find((c) => {
        if (c.cuit && normCuit(c.cuit) === cuit) return true;
        const altNames = (c.matchNames ?? "").split("|").map(n => n.trim()).filter(Boolean);
        return altNames.some(alt => {
          const normAlt = normCuit(alt);
          return normAlt.length >= 10 && normAlt === cuit;
        });
      });
      if (found) {
        consortiumRow = found;
        matchMethod = `CUIT (${cuit})`;
        break;
      }
    }
  }

  // Intentos por nombre requieren rawConsortium
  if (!consortiumRow && rawConsortium) {
    const canonicalName = normalizeConsortiumName(rawConsortium);

    // Intento 1: match exacto por canonicalName
    consortiumRow = allConsortiums.find((c) => c.canonicalName === canonicalName);
    if (consortiumRow) matchMethod = "exacto";

    // Intento 2: fuzzy match
    if (!consortiumRow) {
      const fuzzy = allConsortiums.find((c) => consortiumFuzzyMatch(rawConsortium, c.canonicalName));
      if (fuzzy) { consortiumRow = fuzzy; matchMethod = "fuzzy"; }
    }

    // Intento 3: alias match
    if (!consortiumRow) {
      const aliased = allConsortiums.find((c) => {
        const names = (c.matchNames ?? "").split("|").map((a) => a.trim()).filter(Boolean);
        return consortiumAliasMatch(rawConsortium, names);
      });
      if (aliased) { consortiumRow = aliased; matchMethod = "alias"; }
    }

    if (!consortiumRow) {
      pipelineLog.consortiumNotFound(
        clientId,
        rawConsortium,
        canonicalName,
        allConsortiums.map((c) => c.canonicalName)
      );
      return {
        ...base,
        unassignedReason: `Consorcio no encontrado: "${rawConsortium}" → norm: "${canonicalName}"`,
      };
    }
  }

  if (!consortiumRow) {
    return { ...base, unassignedReason: "No se pudo extraer el consorcio del PDF ni matchear por CUIT" };
  }

  pipelineLog.consortiumMatch(clientId, matchMethod, consortiumRow.canonicalName);

  const consortium = await consortiumRepository.findByCanonicalName(clientId, consortiumRow.canonicalName);
  if (!consortium) {
    return { ...base, unassignedReason: `Consorcio no encontrado: "${rawConsortium}"` };
  }

  const activePeriod = await consortiumRepository.findActivePeriod(consortium.id);
  if (!activePeriod) {
    pipelineLog.stepStart(clientId, `⚠️ No se encontró período activo para consorcio ${consortium.canonicalName}`);
  }
  base.consortiumId = consortium.id;
  base.periodId = activePeriod?.id;
  base.periodLabel = activePeriod ? formatPeriodLabel(activePeriod.month, activePeriod.year) : null;
  base.canonicalConsortium = consortium.rawName;
  base.consortiumBank = consortium.bank ?? null;

  const consortiumCuitNorm = normCuit((consortium as any).cuit);

  // ── 2. Proveedor ─────────────────────────────────────────────────────────

  const allProviders = await prisma.provider.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true, cuit: true, matchNames: true, paymentAlias: true },
  });

  const rawCuit     = extracted.providerTaxId?.trim() ?? null;
  const rawName     = extracted.provider?.trim() ?? null;
  const normOcrCuit = normCuit(rawCuit);
  const normOcrName = normName(rawName);

  let matched: typeof allProviders[0] | undefined;
  let providerMatchMethod = "";

  // Intento 0: CUIT match usando allTaxIds, excluyendo CUIT del consorcio
  if (allTaxIds.length > 0) {
    const providerCuits = allTaxIds.filter((c) => c !== consortiumCuitNorm);
    for (const cuit of providerCuits) {
      const found = allProviders.find((p) => normCuit(p.cuit) === cuit);
      if (found) {
        matched = found;
        providerMatchMethod = `CUIT allTaxIds (${cuit})`;
        break;
      }
    }
  }

  // Intento 1: CUIT normalizado de providerTaxId (legacy), excluyendo CUIT del consorcio
  if (!matched && normOcrCuit.length >= 10 && normOcrCuit !== consortiumCuitNorm) {
    matched = allProviders.find((p) => normCuit(p.cuit) === normOcrCuit);
    if (matched) providerMatchMethod = `CUIT providerTaxId (${normOcrCuit})`;
  } else if (!matched && normOcrCuit.length >= 10 && normOcrCuit === consortiumCuitNorm) {
    pipelineLog.providerCuitMatchesConsortium(clientId, normOcrCuit);
  }

  // Intento 2: nombre / matchNames exacto
  if (!matched && normOcrName.length >= 3) {
    matched = allProviders.find((p) => {
      if (normName(p.canonicalName) === normOcrName) return true;
      const names = (p.matchNames ?? "").split("|").map((n) => n.trim()).filter(Boolean);
      return names.some((n) => normName(n) === normOcrName);
    });
    if (matched) providerMatchMethod = `nombre exacto ("${normOcrName}")`;
  }

  // Intento 3: nombre parcial
  if (!matched && normOcrName.length >= 5) {
    matched = allProviders.find((p) =>
      normName(p.canonicalName).includes(normOcrName) ||
      normOcrName.includes(normName(p.canonicalName).slice(0, 5))
    );
    if (matched) providerMatchMethod = `nombre parcial ("${normOcrName}")`;
  }

  if (!matched) {
    pipelineLog.providerNotFound(clientId, rawCuit, rawName, normOcrCuit, normOcrName);
    return {
      ...base,
      unassigned: true,
      unassignedReason: `Proveedor no identificado. OCR taxId="${rawCuit}" provider="${rawName}"`,
    };
  }

  pipelineLog.providerMatch(clientId, providerMatchMethod, matched.canonicalName);

  try {
    await providerRepository.linkToConsortium(matched.id, consortium.id);
  } catch (linkErr) {
    // Non-fatal
  }

  return {
    consortiumId: consortium.id,
    providerId: matched.id,
    periodId: activePeriod?.id,
    periodLabel: activePeriod ? formatPeriodLabel(activePeriod.month, activePeriod.year) : null,
    lspServiceId: null,
    unassigned: false,
    unassignedReason: null,
    canonicalConsortium: consortium.rawName,
    canonicalProvider: matched.canonicalName,
    canonicalProviderTaxId: matched.cuit ?? rawCuit,
    providerPaymentAlias: matched.paymentAlias ?? null,
    consortiumBank: base.consortiumBank,
  };
}

async function processDriveFile(
  file: ProcessDriveFileInput,
  context: ProcessingContext,
  summary: ProcessJobSummary
): Promise<void> {
  const {
    resolvedConfig, resolvedMapping, driveService, pdfExtractor, sheetsService,
    invoiceRepository, consortiumRepository, providerRepository,
    geminiModule, openAiModule, geminiApiKey, openaiApiKey, geminiModel, openaiModel,
    existingDuplicateKeys,
  } = context;

  const cid = resolvedConfig.clientId;

  const runStep = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    pipelineLog.stepStart(cid, label);
    try { return await fn(); }
    catch (error) { throw new Error(`${label} failed: ${error instanceof Error ? error.message : "Unknown error"}`); }
  };

  try {
    pipelineLog.fileStart(cid, file.id, file.name);

    const sourceFileUrl = buildDriveFileUrl(file.id, file.webViewLink);
    const buffer = await runStep("Descarga de Drive", () => driveService.downloadFile(file.id));

    // ── Lock de archivo: mover a carpeta Procesando para evitar que otro ciclo
    // concurrente lo reprocese mientras estamos trabajando en él.
    const processingFolderId = resolvedConfig.driveProcessingFolderId ?? null;
    if (processingFolderId && resolvedConfig.drivePendingFolderId) {
      try {
        await driveService.moveFileToFolder(file.id, resolvedConfig.drivePendingFolderId, processingFolderId);
        pipelineLog.stepStart(cid, `→ Lock: movido a Procesando`);
      } catch (lockError) {
        const msg = lockError instanceof Error ? lockError.message : "Unknown error";
        pipelineLog.stepStart(cid, `⚠️ No se pudo mover a Procesando: ${msg}`);
      }
    }

    // Carpeta origen para los movimientos finales: si hay lock, venimos de Procesando;
    // si no, seguimos viniendo de Pendientes (comportamiento legacy).
    const finalSourceFolderId = processingFolderId ?? resolvedConfig.drivePendingFolderId;

    const fileHash = invoiceRepository.computeDocumentHash(buffer);
    const existingByHash = await runStep("Verificación duplicado por hash", () =>
      invoiceRepository.findDuplicateByHash(cid, fileHash)
    );
    pipelineLog.hashResult(cid, fileHash, Boolean(existingByHash));

    let extracted: ExtractedDocumentData | null = null;
    let isDuplicate = Boolean(existingByHash);
    let fileAiUsage: import("@/types/aiUsage.types").AiUsageMetrics | null = null;

    let lspProvider: ReturnType<typeof identifyLSPProvider> = null;

    // Detectar si el archivo es una imagen (JPG/PNG)
    const isImage = (
      file.mimeType?.startsWith("image/") ||
      /\.(jpg|jpeg|png)$/i.test(file.name)
    );

    if (isImage) {
      // ── Flujo imagen: extracción directa con Gemini Vision ──
      pipelineLog.stepStart(cid, `→ Archivo de imagen detectado (${file.mimeType ?? file.name}) — usando Gemini Vision`);

      if (existingByHash?.extraction) {
        const { sourceFileUrl: _url, isDuplicate: _dup, ...storedFields } =
          existingByHash.extraction as ExtractedDocumentData;
        extracted = { ...storedFields };
      } else if (geminiModule && geminiApiKey) {
        const imageMimeType: "image/jpeg" | "image/png" =
          file.mimeType?.includes("png") ? "image/png" : "image/jpeg";
        try {
          const extractor = new geminiModule.GeminiExtractorService({ apiKey: geminiApiKey, model: geminiModel });
          extracted = await runStep("Extracción IA (Gemini Vision)", () =>
            extractor.extractStructuredDataFromImage(buffer, imageMimeType)
          );
          fileAiUsage = extractor.getLastUsage?.() ?? null;
          accumulateTokenUsage(summary.tokenUsage, fileAiUsage);
          pipelineLog.aiExtraction(cid, "gemini", true);
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Gemini Vision error";
          pipelineLog.aiExtraction(cid, "gemini", false, msg);
          extracted = buildOcrOnlyPayload();
        }
      } else {
        pipelineLog.stepStart(cid, "⚠️ Imagen sin Gemini configurado — no se puede procesar");
        extracted = buildOcrOnlyPayload();
      }

      if (resolvedConfig.debugMode && extracted) {
        pipelineLog.stepStart(cid, `[DEBUG-AI] respuesta raw: ${JSON.stringify(extracted)}`);
      }
    } else if (existingByHash?.extraction) {
      // ── Flujo PDF: duplicado por hash con extracción previa ──
      const { sourceFileUrl: _url, isDuplicate: _dup, ...storedFields } =
        existingByHash.extraction as ExtractedDocumentData;
      extracted = { ...storedFields };
      const text = await runStep("Extracción de texto (PDF)", () => pdfExtractor.extractTextFromPdf(buffer));
      lspProvider = identifyLSPProvider(text);
      extracted = refineExtractionWithRawText(extracted, text);
    } else {
      // ── Flujo PDF: extracción normal ──
      // Primera pasada: texto completo para detección
      const fullText = await runStep("Extracción de texto (PDF)", () => pdfExtractor.extractTextFromPdf(buffer));

      // Detectar tipo de documento
      lspProvider = identifyLSPProvider(fullText);
      if (lspProvider) {
        pipelineLog.lspDetected(cid, lspProvider);
      }

      // Para LSP, re-extraer limitando a página 1 para reducir ruido
      const text = lspProvider
        ? await runStep("Re-extracción página 1 (LSP)", () => pdfExtractor.extractTextFromPdf(buffer, 1))
        : fullText;

      if (resolvedConfig.debugMode) {
        pipelineLog.stepStart(cid, `[DEBUG-OCR] texto completo (${text.length} chars):\n${text}`);
      }

      const providerErrors: string[] = [];

      if (geminiModule) {
        try {
          const extractor = new geminiModule.GeminiExtractorService({ apiKey: geminiApiKey, model: geminiModel });
          extracted = await runStep("Extracción IA (Gemini)", () => extractor.extractStructuredData(text));
          fileAiUsage = extractor.getLastUsage?.() ?? null;
          accumulateTokenUsage(summary.tokenUsage, fileAiUsage);
          pipelineLog.aiExtraction(cid, "gemini", true);
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Gemini unknown error";
          providerErrors.push(msg);
          pipelineLog.aiExtraction(cid, "gemini", false, msg);
        }
      }

      if (extracted === null && openAiModule) {
        try {
          const extractor = new openAiModule.AiExtractorService({ apiKey: openaiApiKey, model: openaiModel });
          extracted = await runStep("Extracción IA (OpenAI)", () => extractor.extractStructuredData(text));
          fileAiUsage = extractor.getLastUsage?.() ?? null;
          accumulateTokenUsage(summary.tokenUsage, fileAiUsage);
          pipelineLog.aiExtraction(cid, "openai", true);
        } catch (error) {
          const msg = error instanceof Error ? error.message : "OpenAI unknown error";
          providerErrors.push(msg);
          pipelineLog.aiExtraction(cid, "openai", false, msg);
        }
      }

      if (extracted === null) {
        pipelineLog.aiOcrFallback(cid);
        extracted = buildOcrOnlyPayload();
      }

      if (resolvedConfig.debugMode && extracted) {
        pipelineLog.stepStart(cid, `[DEBUG-AI] respuesta raw: ${JSON.stringify(extracted)}`);
      }
    }

    if (extracted === null) throw new Error("extraction produced no result unexpectedly");

    pipelineLog.extractionResult(cid, {
      consortium: extracted.consortium,
      provider: extracted.provider,
      providerTaxId: extracted.providerTaxId,
      amount: extracted.amount,
      dueDate: extracted.dueDate,
      allTaxIds: extracted.allTaxIds,
    });

    if (!isDuplicate) {
      const dup = await runStep("Verificación duplicado por clave de negocio", () =>
        invoiceRepository.findDuplicateByBusinessKey(cid, extracted!)
      );
      if (dup) {
        isDuplicate = true;
        pipelineLog.duplicateByBusinessKey(cid);
      }
    }

    const duplicateKey = invoiceRepository.buildBusinessKeyFromData(extracted);
    if (!isDuplicate && duplicateKey) {
      if (existingDuplicateKeys.has(duplicateKey)) {
        isDuplicate = true;
        pipelineLog.duplicateByBusinessKey(cid);
      }
    }

    extracted.sourceFileUrl = sourceFileUrl;
    extracted.isDuplicate = isDuplicate ? "YES" : "NO";
    extracted.paymentStatus = "Sin pagar";

    let assignment = await resolveAssignment(
      extracted, cid, file.id, consortiumRepository, providerRepository, lspProvider
    );

    // ── Fallback visual: si el proveedor no fue encontrado y el emisor
    // estaba en imagen, intentar extracción visual con Gemini ──────────────
    if (
      assignment.unassigned &&
      assignment.consortiumId &&
      !pdfExtractor.getLastHasEmitterBlock() &&
      geminiModule &&
      geminiApiKey
    ) {
      const pngBuffer = pdfExtractor.getLastOcrPng();
      if (pngBuffer) {
        try {
          pipelineLog.stepStart(cid, "→ Fallback visual: extrayendo emisor con Gemini Vision...");
          const visualExtractor = new geminiModule.GeminiExtractorService({
            apiKey: geminiApiKey,
            model: geminiModel,
          });
          const visualResult = await visualExtractor.extractProviderFromImage(
            pngBuffer,
            assignment.canonicalConsortium ?? extracted.consortium ?? ""
          );

          if (visualResult.providerTaxId || visualResult.providerName) {
            pipelineLog.stepStart(cid,
              `→ Gemini Vision extrajo: provider="${visualResult.providerName}" ` +
              `taxId="${visualResult.providerTaxId}"`
            );

            if (visualResult.providerTaxId) {
              extracted.providerTaxId = visualResult.providerTaxId;
            }
            if (visualResult.providerName) {
              extracted.provider = visualResult.providerName;
            }

            const visualAssignment = await resolveAssignment(
              extracted, cid, file.id, consortiumRepository, providerRepository, lspProvider
            );

            if (!visualAssignment.unassigned) {
              pipelineLog.stepStart(cid, "✅ Fallback visual: proveedor encontrado");
              assignment = visualAssignment;
            } else {
              pipelineLog.stepStart(cid,
                `⚠️ Fallback visual: proveedor no encontrado en DB ` +
                `(${visualResult.providerName} / ${visualResult.providerTaxId})`
              );
            }
          } else {
            pipelineLog.stepStart(cid, "⚠️ Fallback visual: Gemini Vision no pudo extraer el emisor");
          }
        } catch (visualError) {
          pipelineLog.stepStart(cid,
            `⚠️ Fallback visual falló silenciosamente: ${visualError instanceof Error ? visualError.message : "error"}`
          );
        }
      }
    }
    // ── Fin fallback visual ────────────────────────────────────────────────

    if (!assignment.unassigned) {
      if (assignment.canonicalConsortium)    extracted.consortium    = assignment.canonicalConsortium;
      if (assignment.canonicalProvider)      extracted.provider      = assignment.canonicalProvider;
      extracted.alias = assignment.providerPaymentAlias || null;
      if (assignment.canonicalProviderTaxId) extracted.providerTaxId = assignment.canonicalProviderTaxId;
      extracted.period = assignment.periodLabel || null;
      extracted.bank = assignment.consortiumBank;
      pipelineLog.canonized(cid, extracted.consortium ?? "?", extracted.provider ?? "?", extracted.providerTaxId ?? "?");
    }

    const { sourceFileUrl: _url, isDuplicate: _dup, ...extractionFields } = extracted;

    if (assignment.unassigned) {
      pipelineLog.movedToUnassigned(cid, file.id, assignment.unassignedReason ?? "razón desconocida");
      if (resolvedConfig.driveUnassignedFolderId && finalSourceFolderId) {
        await runStep("Mover a Sin Asignar", () =>
          driveService.moveFileToUnassigned(file.id, finalSourceFolderId, resolvedConfig.driveUnassignedFolderId!)
        );
      }
      summary.unassigned += 1;
      pipelineLog.fileCompleted(cid, file.name, { processed: 0, unassigned: 1, duplicate: false });
      return;
    }

    await runStep("Insertar en Google Sheets", () =>
      sheetsService.insertRow(resolvedConfig.sheetName, extracted!, resolvedMapping)
    );
    pipelineLog.sheetsInserted(cid);

    await runStep("Mover a Escaneados", () =>
      driveService.moveFileToScanned(file.id, finalSourceFolderId, resolvedConfig.driveScannedFolderId)
    );
    pipelineLog.movedToScanned(cid, file.id);

    await runStep("Guardar invoice", () =>
      invoiceRepository.saveProcessedInvoice({
        clientId: cid, documentHash: fileHash, fileId: file.id,
        sourceFileUrl, extraction: extractionFields, isDuplicate,
        consortiumId: assignment.consortiumId, providerId: assignment.providerId, periodId: assignment.periodId,
        lspServiceId: assignment.lspServiceId, paymentMethod: extracted!.paymentMethod,
        tokensInput: fileAiUsage?.inputTokens ?? null,
        tokensOutput: fileAiUsage?.outputTokens ?? null,
        tokensTotal: fileAiUsage?.totalTokens ?? null,
        aiProvider: fileAiUsage?.provider ?? null,
        aiModel: fileAiUsage?.model ?? null,
      })
    );
    pipelineLog.invoiceSaved(cid, isDuplicate);

    if (duplicateKey) existingDuplicateKeys.add(duplicateKey);
    if (isDuplicate)  summary.duplicatesDetected += 1;
    summary.processed += 1;
    pipelineLog.fileCompleted(cid, file.name, { processed: 1, unassigned: 0, duplicate: isDuplicate });

  } catch (error) {
    summary.failed += 1;
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    summary.errors.push({ fileId: file.id, fileName: file.name, error: errorMessage });
    pipelineLog.fileFailed(cid, file.name, errorMessage);
    // Para el catch, intentamos usar Procesando primero (si existe) y caer a Pendientes.
    const failSourceFolderId =
      resolvedConfig.driveProcessingFolderId ?? resolvedConfig.drivePendingFolderId;
    if (resolvedConfig.driveFailedFolderId && failSourceFolderId) {
      try {
        await driveService.moveFileToFailed(file.id, failSourceFolderId, resolvedConfig.driveFailedFolderId);
        pipelineLog.movedToFailed(cid, file.id);
      } catch {
        // Silent — ya logueamos el error principal
      }
    }
  }
}

function buildLegacyConfig(sheetName: string, mapping?: SheetsRowMapping): ProcessJobConfig {
  return {
    clientId: "default-env-client", clientName: "Default Client", sheetName, mapping,
    drivePendingFolderId: env.GOOGLE_DRIVE_PENDING_FOLDER_ID,
    driveScannedFolderId: env.GOOGLE_DRIVE_SCANNED_FOLDER_ID,
    driveUnassignedFolderId: null, driveFailedFolderId: null, driveProcessingFolderId: null, googleConfig: null,
  };
}

function normalizeConfig(config: ProcessJobConfig | string, mapping?: SheetsRowMapping): ProcessJobConfig {
  if (typeof config === "string") return buildLegacyConfig(config, mapping);
  return {
    ...config, mapping: config.mapping ?? mapping,
    drivePendingFolderId: config.drivePendingFolderId ?? env.GOOGLE_DRIVE_PENDING_FOLDER_ID,
    driveScannedFolderId: config.driveScannedFolderId ?? env.GOOGLE_DRIVE_SCANNED_FOLDER_ID,
    driveUnassignedFolderId: config.driveUnassignedFolderId ?? null,
    driveFailedFolderId: config.driveFailedFolderId ?? null,
    driveProcessingFolderId: config.driveProcessingFolderId ?? null,
  };
}

export async function processPendingDocumentsJob(
  config: ProcessJobConfig | string,
  mapping?: SheetsRowMapping
): Promise<ProcessJobSummary> {
  const resolvedConfig = normalizeConfig(config, mapping);
  const resolvedMapping = resolvedConfig.mapping ?? DEFAULT_MAPPING;
  const context = await createProcessingContext(resolvedConfig, resolvedMapping);
  const files = await context.driveService.listPendingPdfFiles(resolvedConfig.drivePendingFolderId);
  const processedIds = new Set<string>();

  pipelineLog.batchStart(resolvedConfig.clientId, resolvedConfig.clientName, resolvedConfig.drivePendingFolderId ?? "?", files.length);

  const summary = createBaseSummary(files.length);
  summary.clientId = resolvedConfig.clientId;
  summary.clientName = resolvedConfig.clientName;

  for (const file of files) {
    if (processedIds.has(file.id)) { summary.skipped += 1; continue; }
    processedIds.add(file.id);
    await processDriveFile({ id: file.id, name: file.name, mimeType: file.mimeType, webViewLink: file.webViewLink }, context, summary);
  }

  pipelineLog.batchSummary(resolvedConfig.clientId, {
    totalFound: summary.totalFound,
    processed: summary.processed,
    unassigned: summary.unassigned,
    failed: summary.failed,
    duplicatesDetected: summary.duplicatesDetected,
  });

  return summary;
}

export async function processSingleDriveFileJob(
  config: ProcessJobConfig,
  file: ProcessDriveFileInput,
  mapping?: SheetsRowMapping
): Promise<ProcessJobSummary> {
  const resolvedConfig = normalizeConfig(config, mapping);
  const resolvedMapping = resolvedConfig.mapping ?? DEFAULT_MAPPING;
  const context = await createProcessingContext(resolvedConfig, resolvedMapping);
  const summary = createBaseSummary(1);
  summary.clientId = resolvedConfig.clientId;
  summary.clientName = resolvedConfig.clientName;
  await processDriveFile(file, context, summary);
  return summary;
}
