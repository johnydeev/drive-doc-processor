import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { PdfTextExtractorService } from "@/services/pdfTextExtractor.service";
import { resolveAiConfig } from "@/lib/clientProcessingConfig";
import { ClientDriveFolders, ClientGoogleConfig, ProcessingClient } from "@/types/client.types";
import { normalizeConsortiumName } from "@/lib/consortiumNormalizer";
import { isPdf, isPng, isJpeg } from "@/lib/fileSignature";
import { env } from "@/config/env";

/**
 * POST /api/client/consortiums/[id]/invoices/scan
 * Escanea un PDF con IA y devuelve los campos extraídos.
 *
 * Además valida que el consorcio extraído de la boleta coincida
 * con el consorcio seleccionado. Si no coincide devuelve:
 *   { consortiumMismatch: true, foundConsortium: "NOMBRE REAL" }
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { id: consortiumId } = await context.params;

  try {
    const prisma = getPrismaClient();

    // Consorcio seleccionado actualmente
    const selectedConsortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
      select: { id: true, canonicalName: true, rawName: true },
    });
    if (!selectedConsortium) {
      return NextResponse.json({ ok: false, error: "Consorcio no encontrado" }, { status: 404 });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ ok: false, error: "Formato de request inválido" }, { status: 400 });
    }

    const file = formData.get("pdf");
    if (!file || typeof file === "string") {
      return NextResponse.json({ ok: false, error: "Se requiere un archivo PDF" }, { status: 400 });
    }

    const MAX_PDF_SIZE = 15 * 1024 * 1024; // 15MB
    if (file.size > MAX_PDF_SIZE) {
      return NextResponse.json(
        { ok: false, error: "El PDF no puede superar 15MB" },
        { status: 400 }
      );
    }

    const VALID_PDF_MIMES = ["application/pdf", "image/jpeg", "image/png"];
    if (!VALID_PDF_MIMES.includes(file.type)) {
      return NextResponse.json(
        { ok: false, error: "El archivo debe ser PDF, JPG o PNG" },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Magic bytes: confirmar que el contenido coincide con el MIME declarado.
    const sigOk =
      (file.type === "application/pdf" && isPdf(buffer)) ||
      (file.type === "image/png"       && isPng(buffer)) ||
      (file.type === "image/jpeg"      && isJpeg(buffer));
    if (!sigOk) {
      return NextResponse.json(
        { ok: false, error: "El contenido del archivo no coincide con su tipo declarado" },
        { status: 400 }
      );
    }

    const isImage = file.type === "image/png" || file.type === "image/jpeg";

    // Resolver y descifrar keys de IA
    const clientRow = await prisma.client.findUnique({
      where: { id: auth.session.clientId },
      select: { driveFoldersJson: true, googleConfigJson: true, extractionConfigJson: true },
    });

    const processingClient: ProcessingClient = {
      id:                   auth.session.clientId,
      name:                 "",
      isActive:             true,
      batchSize:            10,
      intervalMinutes:      60,
      driveFoldersJson:     (clientRow?.driveFoldersJson     as ClientDriveFolders      | null) ?? null,
      googleConfigJson:     (clientRow?.googleConfigJson     as ClientGoogleConfig      | null) ?? null,
      extractionConfigJson: (clientRow?.extractionConfigJson as Record<string, unknown> | null) ?? null,
    };

    const aiConfig    = resolveAiConfig(processingClient);
    const geminiKey   = aiConfig?.geminiApiKey  || env.GEMINI_API_KEY?.trim();
    const openaiKey   = aiConfig?.openaiApiKey  || env.OPENAI_API_KEY?.trim();
    const geminiModel = aiConfig?.geminiModel   || env.GEMINI_MODEL;
    const openaiModel = aiConfig?.openaiModel   || env.OPENAI_MODEL;
    const anthropicKey   = aiConfig?.anthropicApiKey  || env.ANTHROPIC_API_KEY?.trim();
    const anthropicModel = aiConfig?.anthropicModel   || env.ANTHROPIC_MODEL;

    let extracted: Record<string, unknown> | null = null;

    if (isImage) {
      // Imagen: solo Gemini Vision puede procesarla. No hay fallback OCR/PDF.
      if (!geminiKey) {
        return NextResponse.json({
          ok: false,
          error: "Para procesar imágenes (JPG/PNG) se requiere una API key de Gemini configurada",
        }, { status: 400 });
      }
      try {
        const { GeminiExtractorService } = await import("@/services/geminiExtractor.service");
        const extractor = new GeminiExtractorService({ apiKey: geminiKey, model: geminiModel });
        const imageMime = file.type as "image/jpeg" | "image/png";
        extracted = await extractor.extractStructuredDataFromImage(buffer, imageMime) as unknown as Record<string, unknown>;
      } catch (err) {
        console.warn("[scan] Gemini Vision failed:", err instanceof Error ? err.message : err);
      }
    } else {
      // PDF: extracción de texto + IA (Gemini → OpenAI fallback).
      const pdfExtractor = new PdfTextExtractorService();
      const text = await pdfExtractor.extractTextFromPdf(buffer);

      if (geminiKey) {
        try {
          const { GeminiExtractorService } = await import("@/services/geminiExtractor.service");
          const extractor = new GeminiExtractorService({ apiKey: geminiKey, model: geminiModel });
          extracted = await extractor.extractStructuredData(text) as unknown as Record<string, unknown>;
        } catch (err) {
          console.warn("[scan] Gemini failed:", err instanceof Error ? err.message : err);
        }
      }

      if (!extracted && openaiKey) {
        try {
          const { AiExtractorService } = await import("@/services/aiExtractor.service");
          const extractor = new AiExtractorService({ apiKey: openaiKey, model: openaiModel });
          extracted = await extractor.extractStructuredData(text) as unknown as Record<string, unknown>;
        } catch (err) {
          console.warn("[scan] OpenAI failed:", err instanceof Error ? err.message : err);
        }
      }

      if (!extracted && anthropicKey) {
        try {
          const { ClaudeExtractorService } = await import("@/services/claudeExtractor.service");
          const extractor = new ClaudeExtractorService({ apiKey: anthropicKey, model: anthropicModel });
          extracted = await extractor.extractStructuredData(text) as unknown as Record<string, unknown>;
        } catch (err) {
          console.warn("[scan] Claude failed:", err instanceof Error ? err.message : err);
        }
      }
    }

    if (!extracted) {
      return NextResponse.json({
        ok: true,
        extracted: null,
        warning: "No se pudo extraer información con IA. Completá los campos manualmente.",
      });
    }

    // ── Validación de consorcio ──────────────────────────────────────────────
    let consortiumMismatch = false;
    let foundConsortium: string | null = null;

    const extractedConsortiumRaw = extracted.consortium as string | null | undefined;

    if (extractedConsortiumRaw?.trim()) {
      const extractedNorm = normalizeConsortiumName(extractedConsortiumRaw);
      const selectedNorm  = normalizeConsortiumName(selectedConsortium.canonicalName);

      if (extractedNorm && selectedNorm && extractedNorm !== selectedNorm) {
        // Buscar en todos los consorcios del cliente cuál coincide
        const allConsortiums = await prisma.consortium.findMany({
          where: { clientId: auth.session.clientId },
          select: { canonicalName: true, rawName: true },
        });

        const match = allConsortiums.find(
          (c) => normalizeConsortiumName(c.canonicalName) === extractedNorm ||
                 normalizeConsortiumName(c.rawName) === extractedNorm
        );

        consortiumMismatch = true;
        // Mostrar el nombre real registrado si existe, si no el que extrajo la IA
        foundConsortium = match?.rawName ?? extractedConsortiumRaw.trim();
      }
    }

    // Omitir alias — nunca se devuelve desde el scan
    const { alias: _alias, ...extractedWithoutAlias } = extracted;

    return NextResponse.json({
      ok: true,
      extracted: extractedWithoutAlias,
      consortiumMismatch,
      foundConsortium,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Error al procesar el PDF" },
      { status: 500 }
    );
  }
}
