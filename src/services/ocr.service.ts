import { createWorker } from "tesseract.js";

export interface OcrOptions {
  scale?: number;
  language?: string;
}

const DEFAULT_SCALE = 2.0;
const DEFAULT_LANGUAGE = "spa+eng";

interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (input: { data: Uint8Array }) => {
    promise: Promise<{
      numPages: number;
      getPage: (pageNumber: number) => Promise<any>;
    }>;
  };
}

interface CanvasModule {
  createCanvas: (width: number, height: number) => {
    getContext: (kind: "2d") => unknown;
    toBuffer: (mimeType: "image/png") => Buffer;
  };
}

export class OcrService {
  async extractTextFromPdf(buffer: Buffer, options?: OcrOptions): Promise<string> {
    const scale = options?.scale ?? DEFAULT_SCALE;
    const language = options?.language ?? DEFAULT_LANGUAGE;

    const [{ createCanvas }, pdfjs] = await Promise.all([
      import("@napi-rs/canvas") as Promise<CanvasModule>,
      import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfJsModule>,
    ]);

    // Configurar worker de pdfjs con la misma versión para evitar mismatch
    const pdfjsWorkerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = `file://${pdfjsWorkerPath}`;

    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const worker = await createWorker(language);

    try {
      let fullText = "";

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext("2d");

        await page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;

        const imageBuffer = canvas.toBuffer("image/png");
        const { data } = await worker.recognize(imageBuffer);

        if (data?.text) {
          fullText += `${data.text}\n`;
        }
      }

      return fullText;
    } finally {
      await worker.terminate();
    }
  }
}
