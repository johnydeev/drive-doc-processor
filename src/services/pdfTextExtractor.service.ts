import { PDFParse } from "pdf-parse";

export class PdfTextExtractorService {
  private static readonly MIN_USEFUL_CHARS = 100;

  async extractTextFromPdf(buffer: Buffer, maxPages?: number): Promise<string> {
    const directText = await this.extractTextDirectly(buffer, maxPages);

    const hasEnoughText = directText.length >= PdfTextExtractorService.MIN_USEFUL_CHARS;

    // Detectar si el bloque del emisor está presente en el texto
    // buscando etiquetas que solo aparecen en el bloque del emisor AFIP
    const upperText = directText.toUpperCase();
    const hasEmitterBlock = (
      upperText.includes("ING. BRUTOS") ||
      upperText.includes("INGRESOS BRUTOS") ||
      upperText.includes("INICIO DE ACTIVIDADES") ||
      upperText.includes("RESPONSABLE INSCRIPTO") ||
      upperText.includes("MONOTRIBUTO")
    );

    // DIAGNÓSTICO TEMPORAL — remover después
    console.log(`[pdf-extractor-debug] chars=${directText.length} hasEmitterBlock=${hasEmitterBlock}`);
    console.log(`[pdf-extractor-debug] texto=\n${directText.slice(0, 500)}`);

    if (hasEnoughText && hasEmitterBlock) {
      return directText;
    }

    // Bloque emisor no detectado en texto → intentar OCR
    console.warn(
      `[pdf-extractor] Bloque emisor no detectado en texto ` +
      `(${directText.length} chars, hasEmitterBlock=${hasEmitterBlock}) → activando OCR`
    );
    const { OcrService } = await import("@/services/ocr.service");
    const ocrService = new OcrService();
    const ocrText = await ocrService.extractTextFromPdf(buffer);
    const cleanOcr = this.cleanText(ocrText);

    // Si OCR produjo más texto útil, combinarlo con el texto directo
    // para no perder lo que pdf-parse sí capturó correctamente
    if (cleanOcr.length > directText.length) {
      return this.mergeTexts(directText, cleanOcr);
    }

    return directText.length > 0 ? directText : cleanOcr;
  }

  private mergeTexts(directText: string, ocrText: string): string {
    if (!directText) return ocrText;
    if (!ocrText) return directText;
    return `${directText}\n\n--- OCR ---\n\n${ocrText}`;
  }

  private async extractTextDirectly(buffer: Buffer, maxPages?: number): Promise<string> {
    const options: Record<string, unknown> = { data: buffer };
    if (maxPages) {
      options.max = maxPages;
    }
    const parser = new PDFParse(options);

    try {
      const parsed = await parser.getText();
      return this.cleanText(parsed.text ?? "");
    } finally {
      await parser.destroy();
    }
  }

  private cleanText(text: string): string {
    return text
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[\t\f\v]+/g, " ")
      .replace(/ {2,}/g, " ")
      .trim();
  }
}
