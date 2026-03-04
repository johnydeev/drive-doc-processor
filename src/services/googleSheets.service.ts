import { google, sheets_v4 } from "googleapis";
import { env } from "@/config/env";
import { buildBusinessKeyParts, buildBusinessKeyString } from "@/lib/businessKey";
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
  sourceFileUrl: string;
  isDuplicate: string;
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
  sourceFileUrl: "URL_ARCHIVO",
  isDuplicate: "ES_DUPLICADO",
};

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
      row[index] = value === undefined || value === null ? "" : String(value);
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
      if (code < 65 || code > 90) {
        throw new Error(`Invalid column letter: ${column}`);
      }
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

    const parseAmount = (value: string): number | null => {
      const numeric = value.replace(/[^\d.,-]/g, "").replace(/,/g, ".").trim();
      const parsed = Number.parseFloat(numeric);
      return Number.isFinite(parsed) ? parsed : null;
    };

    return buildBusinessKeyString(
      buildBusinessKeyParts({
        boletaNumber: getCell(mapping.boletaNumber) || null,
        provider: null,
        consortium: getCell(mapping.consortium) || null,
        providerTaxId: getCell(mapping.providerTaxId) || null,
        detail: getCell(mapping.detail) || null,
        observation: null,
        dueDate: getCell(mapping.dueDate) || null,
        amount: parseAmount(getCell(mapping.amount)),
        alias: null,
      })
    );
  }

  async getExistingDuplicateKeys(sheetName: string, mapping: SheetsRowMapping): Promise<Set<string>> {
    const range = this.getRangeFromMapping(sheetName, mapping);

    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
    });

    const rows = response.data.values ?? [];
    const keys = new Set<string>();

    for (let i = 1; i < rows.length; i += 1) {
      const duplicateKey = this.buildDuplicateKeyFromRow(rows[i], mapping);
      if (duplicateKey) {
        keys.add(duplicateKey);
      }
    }

    return keys;
  }

  private async ensureHeaderRow(sheetName: string, mapping: SheetsRowMapping): Promise<void> {
    const existing = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!1:1`,
    });

    const firstRow = existing.data.values?.[0] ?? [];
    const hasAnyHeaderCell = firstRow.some((cell) => String(cell).trim().length > 0);

    if (hasAnyHeaderCell) {
      return;
    }

    const headerRow = this.buildHeaderRow(mapping);
    const columns = Object.values(mapping).map((c) => this.columnToIndex(c));
    const startColumn = this.indexToColumn(Math.min(...columns));
    const endColumn = this.indexToColumn(Math.max(...columns));

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!${startColumn}1:${endColumn}1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [headerRow],
      },
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
      requestBody: {
        values: [row],
      },
    });

    return {
      updatedRange: response.data.updatedRange,
      updatedRows: response.data.updatedRows,
    };
  }
}
