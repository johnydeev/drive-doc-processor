import dotenv from "dotenv";

dotenv.config({ path: [".env.local", ".env"] });

async function run() {
  const sampleText =
    process.argv.slice(2).join(" ") ||
    "Factura A Nro 0001-00001234 Fecha 2026-02-18 Total 12345.67 Proveedor ACME SA";

  try {
    const moduleRef = await import("@/services/geminiExtractor.service");
    const ServiceCtor =
      (moduleRef as { GeminiExtractorService?: new () => { extractStructuredData: (text: string) => Promise<unknown> } })
        .GeminiExtractorService ||
      (moduleRef as { default?: { GeminiExtractorService?: new () => { extractStructuredData: (text: string) => Promise<unknown> } } })
        .default?.GeminiExtractorService ||
      (
        moduleRef as {
          "module.exports"?: { GeminiExtractorService?: new () => { extractStructuredData: (text: string) => Promise<unknown> } };
        }
      )["module.exports"]?.GeminiExtractorService;

    if (!ServiceCtor) {
      throw new Error("Could not resolve GeminiExtractorService export");
    }

    const extractor = new ServiceCtor();
    const result = await extractor.extractStructuredData(sampleText);

    console.log("[diagnose:gemini] OK");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("[diagnose:gemini] FAILED");
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

void run();
