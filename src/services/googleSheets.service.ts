import { google, sheets_v4 } from "googleapis";
import { env } from "@/config/env";
import { buildBusinessKeyParts, buildBusinessKeyString, normalizeBusinessAmount } from "@/lib/businessKey";
import { ClientGoogleConfig } from "@/types/client.types";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

export interface SheetsRowMapping {
  boletaNumber: string;
  provider: string;
  consortium: string;
  providerTaxId: string;
  detail: string;
  observation: string;
  dueDate: string;
  amount: string;
  alias: string;
  clientNumber: string;
  sourceFileUrl: string;
  isDuplicate: string;
  period: string;
  paymentStatus: string;
  bank: string;
}

export interface InsertRowResult {
  updatedRange?: string | null;
  updatedRows?: number | null;
}

const HEADER_BY_FIELD: Record<keyof SheetsRowMapping, string> = {
  boletaNumber: "NUMERO DE BOLETA",
  provider: "PROVEEDOR",
  consortium: "CONSORCIO",
  providerTaxId: "CUIT DEL PROVEEDOR",
  detail: "DETALLE",
  observation: "OBSERVACION",
  dueDate: "FECHA DE VENCIMIENTO",
  amount: "MONTO",
  alias: "ALIAS",
  clientNumber: "NRO CLIENTE",
  sourceFileUrl: "URL_ARCHIVO",
  isDuplicate: "ES_DUPLICADO",
  period: "PERIODO",
  paymentStatus: "ESTADO PAGO",
  bank: "BANCO",
};

/**
 * Formatea monto como pesos argentinos: punto = miles, coma = decimal.
 * Ejemplo: 118000 → "$ 118.000,00"
 */
function formatAmountARS(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const num =
    typeof value === "number"
      ? value
      : Number(normalizeBusinessAmount(value)); // reusar el parser centralizado
  if (!Number.isFinite(num)) return value === null || value === undefined ? "" : String(value);
  return (
    "$ " +
    new Intl.NumberFormat("es-AR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num)
  );
}

export interface DirectoryData {
  consortiums: { canonicalName: string; cuit: string | null; matchNames: string | null; paymentAlias: string | null }[];
  providers: { canonicalName: string; cuit: string | null; matchNames: string | null; paymentAlias: string | null }[];
  rubros: { name: string; description: string | null }[];
  coeficientes: { code: string; name: string }[];
  lspServices: { consortiumName: string; provider: string; clientNumber: string; description: string | null }[];
  warnings: string[];
}

export class GoogleSheetsService {
  private sheets: sheets_v4.Sheets;
  private readonly spreadsheetId: string;

  constructor(googleConfig?: ClientGoogleConfig | null) {
    const clientEmail = googleConfig?.clientEmail ?? env.GOOGLE_CLIENT_EMAIL;
    const privateKey = googleConfig?.privateKey ?? env.GOOGLE_PRIVATE_KEY;
    const spreadsheetId = googleConfig?.sheetsId ?? env.GOOGLE_SHEETS_ID;
    if (!clientEmail || !privateKey || !spreadsheetId) {
      throw new Error(
        "Missing Google Sheets config. Configure client credentials/sheetsId in DB or GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY/GOOGLE_SHEETS_ID."
      );
    }

    const auth = new google.auth.JWT({
      email: clientEmail,
      key: privateKey.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    this.sheets = google.sheets({ version: "v4", auth });
    this.spreadsheetId = spreadsheetId;
  }

  private buildRow(data: ExtractedDocumentData, mapping: SheetsRowMapping): string[] {
    const entries = Object.entries(mapping) as Array<[keyof ExtractedDocumentData, string]>;

    const maxIndex = entries.reduce((max, [, column]) => {
      return Math.max(max, this.columnToIndex(column));
    }, 0);

    const row = new Array<string>(maxIndex + 1).fill("");

    for (const [key, column] of entries) {
      const index = this.columnToIndex(column);
      const value = data[key];

      if (key === "amount") {
        row[index] = formatAmountARS(value as number | string | null | undefined);
      } else {
        row[index] = value === undefined || value === null ? "" : String(value);
      }
    }

    return row;
  }

  private buildHeaderRow(mapping: SheetsRowMapping): string[] {
    const entries = Object.entries(mapping) as Array<[keyof SheetsRowMapping, string]>;

    const maxIndex = entries.reduce((max, [, column]) => {
      return Math.max(max, this.columnToIndex(column));
    }, 0);

    const row = new Array<string>(maxIndex + 1).fill("");

    for (const [key, column] of entries) {
      const index = this.columnToIndex(column);
      row[index] = HEADER_BY_FIELD[key];
    }

    return row;
  }

  private getRangeFromMapping(sheetName: string, mapping: SheetsRowMapping): string {
    const columns = Object.values(mapping).map((column) => this.columnToIndex(column));
    const minIndex = Math.min(...columns);
    const maxIndex = Math.max(...columns);
    const startColumn = this.indexToColumn(minIndex);
    const endColumn = this.indexToColumn(maxIndex);
    return `${sheetName}!${startColumn}:${endColumn}`;
  }

  private indexToColumn(index: number): string {
    let current = index + 1;
    let column = "";
    while (current > 0) {
      const remainder = (current - 1) % 26;
      column = String.fromCharCode(65 + remainder) + column;
      current = Math.floor((current - 1) / 26);
    }
    return column;
  }

  private columnToIndex(column: string): number {
    const letters = column.trim().toUpperCase();
    let index = 0;
    for (let i = 0; i < letters.length; i += 1) {
      const code = letters.charCodeAt(i);
      if (code < 65 || code > 90) throw new Error(`Invalid column letter: ${column}`);
      index = index * 26 + (code - 64);
    }
    return index - 1;
  }

  buildDuplicateKeyFromData(data: ExtractedDocumentData): string | null {
    return buildBusinessKeyString(buildBusinessKeyParts(data));
  }

  private buildDuplicateKeyFromRow(row: string[], mapping: SheetsRowMapping): string | null {
    const getCell = (column: string): string => {
      const index = this.columnToIndex(column);
      return row[index] ?? "";
    };

    const amountCell = getCell(mapping.amount);

    return buildBusinessKeyString(
      buildBusinessKeyParts({
        boletaNumber: getCell(mapping.boletaNumber) || null,
        provider: null,
        consortium: getCell(mapping.consortium) || null,
        providerTaxId: getCell(mapping.providerTaxId) || null,
        detail: getCell(mapping.detail) || null,
        observation: null,
        dueDate: getCell(mapping.dueDate) || null,
        // normalizeBusinessAmount ya maneja es-AR, en-US y plano
        amount: amountCell ? Number(normalizeBusinessAmount(amountCell)) || null : null,
        alias: null,
        clientNumber: null,
        paymentMethod: null,
      })
    );
  }

  async getExistingDuplicateKeys(
    sheetName: string,
    mapping: SheetsRowMapping
  ): Promise<Set<string>> {
    const range = this.getRangeFromMapping(sheetName, mapping);
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
    });
    const rows = response.data.values ?? [];
    const keys = new Set<string>();
    for (let i = 1; i < rows.length; i += 1) {
      const duplicateKey = this.buildDuplicateKeyFromRow(rows[i], mapping);
      if (duplicateKey) keys.add(duplicateKey);
    }
    return keys;
  }

  private async ensureHeaderRow(
    sheetName: string,
    mapping: SheetsRowMapping
  ): Promise<void> {
    const existing = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!1:1`,
    });
    const firstRow = existing.data.values?.[0] ?? [];
    const hasAnyHeaderCell = firstRow.some((cell) => String(cell).trim().length > 0);
    if (hasAnyHeaderCell) return;

    const headerRow = this.buildHeaderRow(mapping);
    const columns = Object.values(mapping).map((c) => this.columnToIndex(c));
    const startColumn = this.indexToColumn(Math.min(...columns));
    const endColumn = this.indexToColumn(Math.max(...columns));

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!${startColumn}1:${endColumn}1`,
      valueInputOption: "RAW",
      requestBody: { values: [headerRow] },
    });
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit =
        message.includes("429") ||
        message.includes("Quota exceeded") ||
        message.includes("rateLimitExceeded");
      if (!isRateLimit) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return await fn();
    }
  }

  async readDirectory(): Promise<DirectoryData> {
    const warnings: string[] = [];

    const TABS: { name: string; headers: string[]; cols: string }[] = [
      { name: "_Consorcios",  headers: ["NOMBRE CANÓNICO", "CUIT", "NOMBRES ALTERNATIVOS", "ALIAS"], cols: "A:D" },
      { name: "_Proveedores", headers: ["NOMBRE CANÓNICO", "CUIT", "NOMBRES ALTERNATIVOS", "ALIAS"], cols: "A:D" },
      { name: "_Rubros",      headers: ["NOMBRE", "DESCRIPCIÓN"],              cols: "A:B" },
      { name: "_Coeficientes",headers: ["NOMBRE", "CÓDIGO"],                   cols: "A:B" },
      { name: "_LspServices", headers: ["NOMBRE CANÓNICO", "PROVEEDOR", "NRO CLIENTE", "DESCRIPCIÓN"], cols: "A:D" },
    ];

    // 1. Obtener hojas existentes en el archivo
    const spreadsheet = await this.withRetry(() =>
      this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId })
    );
    const existingTitles = new Set(
      spreadsheet.data.sheets?.map((s) => s.properties?.title ?? "") ?? []
    );

    // 2. Crear las hojas que faltan (en un solo batchUpdate)
    const missingTabs = TABS.filter((t) => !existingTitles.has(t.name));
    if (missingTabs.length > 0) {
      await this.withRetry(() =>
        this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: missingTabs.map((t) => ({
              addSheet: { properties: { title: t.name } },
            })),
          },
        })
      );
      // Escribir encabezados en las hojas recién creadas
      await Promise.all(
        missingTabs.map((t) =>
          this.withRetry(() =>
            this.sheets.spreadsheets.values.update({
              spreadsheetId: this.spreadsheetId,
              range: `${t.name}!A1`,
              valueInputOption: "RAW",
              requestBody: { values: [t.headers] },
            })
          )
        )
      );
      warnings.push(
        `Se crearon las hojas: ${missingTabs.map((t) => t.name).join(", ")}. Cargá los datos y volvé a sincronizar.`
      );
    }

    // 3. Leer datos de todas las hojas
    const readTab = async (tabName: string, cols: string): Promise<string[][]> => {
      const response = await this.withRetry(() =>
        this.sheets.spreadsheets.values.get({
          spreadsheetId: this.spreadsheetId,
          range: `${tabName}!${cols}`,
        })
      );
      const rows = response.data.values ?? [];
      return rows.slice(1).filter((row) => row[0]?.toString().trim());
    };

    const [consortiumRows, providerRows, rubroRows, coeficienteRows, lspServiceRows] = await Promise.all([
      readTab("_Consorcios", "A:D"),
      readTab("_Proveedores", "A:D"),
      readTab("_Rubros", "A:B"),
      readTab("_Coeficientes", "A:B"),
      readTab("_LspServices", "A:D"),
    ]);

    return {
      consortiums: consortiumRows
        .map((row) => ({
          canonicalName: row[0]?.toString().trim().toUpperCase() ?? "",
          cuit: row[1]?.toString().trim() || null,
          matchNames: row[2]?.toString().trim() || null,
          paymentAlias: row[3]?.toString().trim() || null,
        }))
        .filter((c) => c.canonicalName),

      providers: providerRows
        .map((row) => ({
          canonicalName: row[0]?.toString().trim().toUpperCase() ?? "",
          cuit: row[1]?.toString().trim() || null,
          matchNames: row[2]?.toString().trim() || null,
          paymentAlias: row[3]?.toString().trim() || null,
        }))
        .filter((p) => p.canonicalName),

      rubros: rubroRows
        .map((row) => ({
          name: row[0]?.toString().trim().toUpperCase() ?? "",
          description: row[1]?.toString().trim() || null,
        }))
        .filter((r) => r.name),

      coeficientes: coeficienteRows
        .map((row) => ({
          name: row[0]?.toString().trim().toUpperCase() ?? "",
          code: row[1]?.toString().trim().toUpperCase() ?? "",
        }))
        .filter((c) => c.name && c.code),

      lspServices: lspServiceRows
        .map((row) => ({
          consortiumName: row[0]?.toString().trim().toUpperCase() ?? "",
          provider: row[1]?.toString().trim().toUpperCase() ?? "",
          clientNumber: row[2]?.toString().trim() ?? "",
          description: row[3]?.toString().trim() || null,
        }))
        .filter((l) => l.consortiumName && l.provider && l.clientNumber),

      warnings,
    };
  }

  async clearAllDataRows(sheetName: string): Promise<void> {
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!A2:Z`,
    });
  }

  async insertRow(
    sheetName: string,
    data: ExtractedDocumentData,
    mapping: SheetsRowMapping
  ): Promise<InsertRowResult> {
    await this.ensureHeaderRow(sheetName, mapping);

    const tableRange = this.getRangeFromMapping(sheetName, mapping);
    const current = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: tableRange,
    });

    const existingRows = current.data.values ?? [];
    const nextRowNumber = Math.max(existingRows.length + 1, 2);

    const row = this.buildRow(data, mapping);
    const columns = Object.values(mapping).map((c) => this.columnToIndex(c));
    const startColumn = this.indexToColumn(Math.min(...columns));
    const endColumn = this.indexToColumn(Math.max(...columns));
    const targetRange = `${sheetName}!${startColumn}${nextRowNumber}:${endColumn}${nextRowNumber}`;

    const response = await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: targetRange,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });

    return {
      updatedRange: response.data.updatedRange,
      updatedRows: response.data.updatedRows,
    };
  }
}
