import { createWorker } from "tesseract.js";
import { execSync } from "child_process";
import { writeFileSync, readFileSync, readdirSync, unlinkSync, rmdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface OcrOptions {
  scale?: number;
  language?: string;
}

const DEFAULT_LANGUAGE = "spa+eng";

export class OcrService {
  async extractTextFromPdf(buffer: Buffer, options?: OcrOptions): Promise<string> {
    const language = options?.language ?? DEFAULT_LANGUAGE;

    // Crear directorio temporal único
    const tmpDir = mkdtempSync(join(tmpdir(), "ocr-"));
    const pdfPath = join(tmpDir, "input.pdf");
    const outputPrefix = join(tmpDir, "page");

    try {
      // Escribir PDF a disco
      writeFileSync(pdfPath, buffer);

      // Convertir PDF a imágenes PNG usando pdftoppm (200 DPI)
      execSync(`pdftoppm -png -r 200 "${pdfPath}" "${outputPrefix}"`, {
        timeout: 30000,
      });

      // Leer archivos PNG generados (ordenados)
      const files = readdirSync(tmpDir)
        .filter(f => f.startsWith("page") && f.endsWith(".png"))
        .sort();

      if (files.length === 0) {
        console.warn("[ocr-service] pdftoppm no generó imágenes");
        return "";
      }

      console.log(`[ocr-service] pdftoppm generó ${files.length} página(s)`);

      // Procesar cada página con Tesseract
      const worker = await createWorker(language);
      let fullText = "";

      try {
        for (const file of files) {
          const imagePath = join(tmpDir, file);
          const imageBuffer = readFileSync(imagePath);
          const { data } = await worker.recognize(imageBuffer);
          if (data?.text) {
            fullText += `${data.text}\n`;
          }
        }
      } finally {
        await worker.terminate();
      }

      console.log(`[ocr-service] OCR completado — ${fullText.length} chars extraídos`);
      return fullText;

    } finally {
      // Limpiar archivos temporales
      try {
        const files = readdirSync(tmpDir);
        for (const file of files) {
          unlinkSync(join(tmpDir, file));
        }
        rmdirSync(tmpDir);
      } catch {
        // Silent cleanup
      }
    }
  }
}
