import { z } from "zod";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

function normalizeCuit(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, "");
  if (digits.length !== 11) {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

function normalizeAmount(value: number | string | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
  }

  const normalized = value.replace(/[^\d.,-]/g, "").replace(/,/g, ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

export const EXTRACTED_DOCUMENT_SCHEMA = z
  .object({
    boletaNumber: z.string().nullable().default(null),
    provider: z.string().nullable().default(null),
    consortium: z.string().nullable().default(null),
    providerTaxId: z.string().nullable().default(null).transform((value) => normalizeCuit(value)),
    detail: z.string().nullable().default(null),
    observation: z.string().nullable().default(null),
    dueDate: z.string().nullable().default(null),
    amount: z
      .union([z.number(), z.string()])
      .nullable()
      .default(null)
      .transform((value) => normalizeAmount(value)),
    alias: z.string().nullable().default(null),
    clientNumber: z.string().nullable().default(null),
    paymentMethod: z.enum(["DEBITO_AUTOMATICO", "TRANSFERENCIA", "EFECTIVO"]).nullable().default(null),
    allTaxIds: z.array(z.string()).nullable().default(null),
  })
  .passthrough();

const OUTPUT_JSON_TEMPLATE = {
  boletaNumber: "string | null",
  provider: "string | null",
  consortium: "string | null",
  providerTaxId: "string | null",
  detail: "string | null",
  observation: "string | null",
  dueDate: "YYYY-MM-DD | null",
  amount: "number | null",
  alias: "string | null",
  clientNumber: "string | null",
  paymentMethod: "DEBITO_AUTOMATICO | TRANSFERENCIA | EFECTIVO | null",
  allTaxIds: "string[] (todos los CUITs encontrados) | []",
};

// ═══════════════════════════════════════════════════════════════════════════
// LSP Provider Identification — Router
// ═══════════════════════════════════════════════════════════════════════════

export type LSPProvider =
  | "EDESUR"
  | "EDENOR"
  | "AYSA"
  | "METROGAS"
  | "NATURGY"
  | "CAMUZZI"
  | "LITORAL_GAS"
  | "ABSA"
  | "PERSONAL"
  | "GENERIC_LSP";

/** Nombres de fallback para proveedores LSP cuando no se encuentran en la DB */
export const LSP_FALLBACK_NAMES: Partial<Record<LSPProvider, string>> = {
  EDESUR: "EDESUR S.A.",
  EDENOR: "EDENOR S.A.",
  AYSA: "AYSA",
  METROGAS: "METROGAS S.A.",
  NATURGY: "NATURGY BAN S.A.",
  CAMUZZI: "CAMUZZI GAS PAMPEANA S.A.",
  LITORAL_GAS: "LITORAL GAS S.A.",
  ABSA: "ABSA",
  PERSONAL: "PERSONAL",
};

/**
 * Identifica qué empresa de servicios públicos emitió la factura.
 * Analiza los primeros 4000 caracteres del texto del PDF.
 *
 * Retorna null si no es una LSP.
 */
export function identifyLSPProvider(text: string): LSPProvider | null {
  const upper = text.slice(0, 4000).toUpperCase();

  // Primero verificar si es una LSP
  if (!isUtilityBill(upper)) {
    return null;
  }

  // Identificar empresa específica
  if (upper.includes("EDESUR")) return "EDESUR";
  if (upper.includes("EDENOR")) return "EDENOR";

  if (
    upper.includes("AYSA") ||
    upper.includes("AY.S.A") ||
    upper.includes("AGUA Y SANEAMIENTOS")
  ) {
    return "AYSA";
  }

  if (upper.includes("METROGAS")) return "METROGAS";
  if (upper.includes("NATURGY")) return "NATURGY";
  if (upper.includes("CAMUZZI")) return "CAMUZZI";
  if (upper.includes("LITORAL GAS")) return "LITORAL_GAS";
  if (upper.includes("ABSA") || (upper.includes("AGUAS") && upper.includes("ARGENTINAS"))) {
    return "ABSA";
  }

  if (upper.includes("PERSONAL") || upper.includes("TELECOM")) return "PERSONAL";

  return "GENERIC_LSP";
}

// ═══════════════════════════════════════════════════════════════════════════
// Text utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extrae las primeras N líneas no vacías del texto del PDF.
 */
function extractRelevantLines(text: string, maxLines = 80): string {
  return text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines)
    .join("\n");
}

/**
 * Detecta si el texto corresponde a una Liquidación de Servicios Públicos (LSP).
 * Acepta texto ya en uppercase o lo convierte.
 */
function isUtilityBill(textOrUpper: string): boolean {
  const upper =
    textOrUpper === textOrUpper.toUpperCase()
      ? textOrUpper
      : textOrUpper.slice(0, 4000).toUpperCase();

  return (
    upper.includes("LIQUIDACIÓN DE SERVICIOS PÚBLICOS") ||
    upper.includes("LIQUIDACION DE SERVICIOS PUBLICOS") ||
    upper.includes("LSP ") ||
    upper.includes("EMPRESA DISTRIBUIDORA") ||
    upper.includes("METROGAS") ||
    upper.includes("AYSA") ||
    upper.includes("AY.S.A") ||
    upper.includes("AGUA Y SANEAMIENTOS") ||
    upper.includes("EDESUR") ||
    upper.includes("EDENOR") ||
    upper.includes("NATURGY") ||
    upper.includes("CAMUZZI") ||
    upper.includes("LITORAL GAS") ||
    upper.includes("ABSA") ||
    (upper.includes("AGUAS") && upper.includes("ARGENTINAS")) ||
    upper.includes("PERSONAL") ||
    upper.includes("TELECOM")
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Main prompt builder — entry point
// ═══════════════════════════════════════════════════════════════════════════

export function buildExtractionPrompt(text: string): string {
  const relevantText = extractRelevantLines(text, 80);
  const lspProvider = identifyLSPProvider(text);

  if (!lspProvider) {
    return buildInvoicePrompt(relevantText);
  }

  // Route to specific prompt per LSP provider
  switch (lspProvider) {
    case "EDESUR":
      return buildEdesurPrompt(relevantText);
    case "EDENOR":
      return buildEdenorPrompt(relevantText);
    case "AYSA":
      return buildAysaPrompt(relevantText);
    case "METROGAS":
    case "NATURGY":
    case "CAMUZZI":
    case "LITORAL_GAS":
      return buildGasPrompt(relevantText, lspProvider);
    case "PERSONAL":
      return buildPersonalPrompt(relevantText);
    default:
      return buildGenericUtilityBillPrompt(relevantText);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Common rules shared across prompts
// ═══════════════════════════════════════════════════════════════════════════

const JSON_RESPONSE_INSTRUCTION = [
  "Responde SOLO JSON con EXACTAMENTE estas claves y tipos:",
  JSON.stringify(OUTPUT_JSON_TEMPLATE, null, 2),
].join("\n");

const CONSORTIUM_ADDRESS_RULES = [
  "- consortium: dirección del INMUEBLE donde se presta el servicio.",
  "  Buscarlo en 'Domicilio de Prestación del Servicio', 'Domicilio suministro',",
  "  'Dirección del inmueble', o dirección del cliente/titular.",
  "  Extraer SOLO calle y número principal. ELIMINAR:",
  "    • Números de piso, departamento, unidad (PB, PA, 1°A, etc.)",
  "    • Código postal (C1414AWF, B1602, etc.)",
  "    • Localidad y provincia (CAPITAL FEDERAL, BUENOS AIRES, etc.)",
  "    • Ceros a la izquierda en el número (00246 → 246, 02178 → 2178)",
  "    • Sufijos numéricos extras después del número principal (001, 018, etc.)",
  "  Ejemplos:",
  "    'FRAY JUSTO SANTAMARIA DE ORO 02178 001' → 'FRAY JUSTO SANTAMARIA DE ORO 2178'",
  "    'CASTILLO 00246 C1414AWF CAPITAL FEDERAL' → 'CASTILLO 246'",
  "    'SAN ANTONIO 345 PB A' → 'SAN ANTONIO 345'",
  "    'AV ALMIRANTE BROWN 706 018' → 'AV ALMIRANTE BROWN 706'",
].join("\n");

const INVALID_DATE_RULES = [
  "  INVÁLIDO — siempre null:",
  "    ✗ 'C.E.S.P: XXXXX | Fecha Vto: [fecha]' — el Fecha Vto es del código CESP",
  "       (código electrónico de servicio público), NO de pago.",
  "    ✗ 'CAE N°: XXXXXXXXXX | Fecha Vto: [fecha]' — es vencimiento del código AFIP.",
  "    ✗ 'Fecha de emisión' o 'Fecha:' sola — es cuando se generó el documento.",
  "    ✗ 'Próxima liquidación vence el [fecha]' — es del próximo mes.",
  "    ✗ Fechas de 2° o 3° vencimiento con recargo.",
  "    ✗ 'Inicio de actividades' — antigüedad del emisor en AFIP.",
  "  Si no existe ningún caso válido: null. No deducir, no calcular, no suponer.",
].join("\n");

const PAYMENT_METHOD_RULES = [
  "- paymentMethod: método de pago detectado. Valores posibles: DEBITO_AUTOMATICO, TRANSFERENCIA, EFECTIVO, null.",
  "  • DEBITO_AUTOMATICO si detectás: 'débito automático', 'débito directo', 'pago directo',",
  "    'a debitar el', 'se debitará', 'DEBITO AUTOMATICO', 'FACTURA CON DÉBITO AUTOMÁTICO',",
  "    'Abona por Pago Directo', 'DEBITO POR PAGO DIRECTO'.",
  "  • TRANSFERENCIA si detectás: 'transferencia', 'CVU', 'CBU'.",
  "  • EFECTIVO si detectás: 'Rapipago', 'Pago Fácil', 'efectivo', 'cobro express'",
  "    SIN mención de débito automático.",
  "  • null si no se puede determinar con certeza.",
].join("\n");

const PROVIDER_NAME_RULES = [
  "  Si el nombre del proveedor/emisor aparece acompañado de una razón social",
  "  (S.R.L., S.A., S.A.S., S.C., S.H., COOP., LTDA., S.A.C.I., S.A.C.I.F.,",
  "  S.A.I.C., u otras variantes), CONSERVARLA como parte del nombre.",
  "  Ejemplo: 'ASCENSORES POTENZA S.R.L.' → 'ASCENSORES POTENZA S.R.L.' (NO 'ASCENSORES POTENZA').",
].join("\n");

const LSP_PROVIDER_TAX_ID_RULES = [
  "- providerTaxId: CUIT de la EMPRESA DE SERVICIOS emisora (NO del cliente/consorcio).",
  "  Buscar en el encabezado del documento, junto al nombre/logo de la empresa, etiquetas como 'CUIT', 'CUIT Nº'.",
  "  ⚠️ TRAMPA COMÚN: el CUIT del CLIENTE (consorcio) aparece prominente en la sección del titular",
  "  o al final del documento. Ese CUIT NO es el de la empresa emisora. IGNORARLO SIEMPRE.",
  "  Si no podés identificar con certeza el CUIT de la empresa emisora: null.",
].join("\n");

const LSP_LATERAL_CUIT_RULES =
  "  ⚠️ EN ESTA EMPRESA: el CUIT aparece en el margen lateral izquierdo del documento, " +
  "impreso de manera vertical/rotada junto a datos como 'IVA Responsable Inscripto', " +
  "'Ingresos Brutos' y 'Fecha de inicio de actividades'. Buscarlo ahí si no aparece en el encabezado.";

const ALL_TAX_IDS_RULES = [
  "- allTaxIds: lista de TODOS los CUITs que aparezcan en el documento, sin clasificar.",
  "  Un CUIT argentino tiene exactamente 11 dígitos numéricos.",
  "  Puede aparecer con o sin guiones: '30-71880844-4' o '30718808444'.",
  "  Normalizar SIEMPRE al formato CON guiones: 'XX-XXXXXXXX-X'.",
  "",
  "  ✓ INCLUIR CUITs junto a cualquiera de estas etiquetas:",
  "    'C.U.I.T.:', 'CUIT:', 'CUIT', 'C.U.I.T', 'ING. BRUTOS:', 'Ing. Brutos:'",
  "    (Ingresos Brutos usa el mismo número que el CUIT para personas jurídicas)",
  "",
  "  ✓ INCLUIR si aparece 'DNI: XXXXXXXXXXX' con exactamente 11 dígitos —",
  "    algunos sistemas emiten el CUIT del consorcio bajo la etiqueta DNI.",
  "    Incluirlo en allTaxIds normalizado con guiones.",
  "",
  "  ✗ NO incluir si 'DNI:' tiene MENOS de 11 dígitos — es un DNI real de persona física.",
  "  ✗ NO incluir el número de CAE (14 dígitos).",
  "  ✗ NO incluir el número de comprobante.",
  "  ✗ NO incluir secuencias de más de 11 dígitos numéricos consecutivos.",
  "",
  "  Resultado: array de strings con formato 'XX-XXXXXXXX-X'.",
  "  Si no hay ningún CUIT en el texto: [].",
].join("\n");

// ═══════════════════════════════════════════════════════════════════════════
// Invoice prompt (facturas normales A, B, C, etc.)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Regla de dueDate para facturas normales.
 */
const DUE_DATE_RULE = [
  "- dueDate: fecha límite en que el cliente debe PAGAR este comprobante. YYYY-MM-DD.",
  "",
  "  VÁLIDO — usar la fecha:",
  "    ✓ 'Fecha de Vto. para el pago', 'Fecha límite de pago', 'Vence:', 'Vencimiento:'",
  "      con una fecha de pago.",
  "    ✓ 'Vencimiento: [fecha]' o 'Fecha Vto.: [fecha]' en el encabezado de la factura",
  "      junto al número de comprobante, CUIT e inicio de actividades del emisor.",
  "    ✓ '1° Vencimiento: [fecha]' junto a un monto — siempre válido.",
  "",
  INVALID_DATE_RULES,
].join("\n");

function buildInvoicePrompt(relevantText: string): string {
  return [
    "Extrae datos de una factura/comprobante en PDF (administración de consorcios en Argentina).",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS ===",

    "- boletaNumber: número de comprobante. Formato típico PPPP-NNNNNNNN (ej: '0002-00003019').",

    "- provider: razón social del EMISOR (quien factura). Está en el bloque superior del documento,",
    "  generalmente con su domicilio, teléfono y CUIT. NO es el consorcio.",
    PROVIDER_NAME_RULES,

    "- providerTaxId: CUIT del EMISOR (quien factura), formato 'XX-XXXXXXXX-X'.",
    "",
    "  ESTRUCTURA ESTÁNDAR de una factura AFIP:",
    "  • Bloque EMISOR (arriba): razón social, domicilio fiscal, C.U.I.T. del emisor,",
    "    Ingresos Brutos, Inicio de Actividades, condición IVA del emisor.",
    "  • Bloque COMPROBANTE (arriba derecha): letra (A/B/C), número de factura, fecha, CAE.",
    "  • Bloque RECEPTOR (cuerpo/abajo): nombre del cliente, domicilio, C.U.I.T. o DNI.",
    "",
    "  ✓ El providerTaxId está en el bloque EMISOR, junto a 'Ingresos Brutos' o",
    "    'Inicio de Actividades'. TIP: en personas jurídicas, Ingresos Brutos usa el",
    "    mismo número que el CUIT — si ves ese número, es el CUIT del emisor.",
    "",
    "  ✗ IGNORAR el CUIT o DNI del bloque RECEPTOR aunque tenga etiqueta 'C.U.I.T.:' o 'CUIT:'.",
    "    Ese pertenece al consorcio receptor, no al proveedor.",
    "",
    "  Si el CUIT del emisor no está en el texto (imagen no copiable): null.",
    "  El sistema puede resolver el proveedor usando allTaxIds aunque este campo sea null.",

    "- consortium: nombre del CONSORCIO receptor. Buscarlo en la sección del receptor:",
    "  'Razón Social:', 'Cliente:', 'Señores:', etc. Incluir el nombre completo con calle y número.",

    "- amount: monto TOTAL a pagar ('Importe Total', 'Total a pagar'). Nunca un subtotal.",
    "  Formato numérico sin símbolos (ej: 34400.01).",

    DUE_DATE_RULE,

    "- detail: descripción breve del producto o servicio facturado (máx 120 caracteres).",

    "- clientNumber: null (no aplica a facturas normales).",
    "- paymentMethod: null (no aplica a facturas normales).",

    ALL_TAX_IDS_RULES,

    "- Usa null si un dato falta o es incierto. No inventes datos.",

    "Texto del comprobante:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// EDESUR prompt
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Prompt especializado para facturas de EDESUR S.A.
 *
 * Formato observado en PDFs reales:
 * - Encabezado: "EDESUR S.A." con CUIT 30-71079642-7
 * - boletaNumber dentro de "LSP B 0501-73540975 18" → extraer solo "0501-73540975"
 * - Dos vencimientos:
 *     Total a pagar hasta   Fecha límite de pago en banco
 *     18/02/2026 $121.670,97    23/02/2026 $122.078,88
 *   → usar SIEMPRE el primer par (fecha + monto)
 * - consortium: aparece bajo "CONSORCIO DE PROPIETARIOS" como cliente,
 *   seguido de dirección del suministro
 * - CUIT del cliente (consorcio) aparece prominente → IGNORAR para providerTaxId
 */
function buildEdesurPrompt(relevantText: string): string {
  return [
    "Extrae datos de una factura de EDESUR (energía eléctrica) argentina.",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS ESPECÍFICAS EDESUR ===",

    "- provider: siempre 'EDESUR S.A.'",
    PROVIDER_NAME_RULES,

    LSP_PROVIDER_TAX_ID_RULES,
    LSP_LATERAL_CUIT_RULES,

    "- boletaNumber: extraer de la línea tipo 'LSP B PPPP-NNNNNNNN NN'.",
    "  Tomar SOLO la parte PPPP-NNNNNNNN (ej: de 'LSP B 0501-73540975 18' → '0501-73540975').",
    "  Si no encontrás ese formato, buscar 'Nro. de Cliente' o 'Nro. Factura'.",

    CONSORTIUM_ADDRESS_RULES,

    "- amount: monto del PRIMER vencimiento solamente.",
    "  Edesur presenta dos columnas:",
    "    'Total a pagar hasta [FECHA1] $[MONTO1]    Fecha límite de pago en banco [FECHA2] $[MONTO2]'",
    "  Usar MONTO1 (el menor, sin recargo). Formato numérico (ej: 121670.97).",

    "- dueDate: fecha del PRIMER vencimiento. YYYY-MM-DD.",
    "  Usar FECHA1 del par descrito arriba.",
    "  VÁLIDO:",
    "    ✓ 'Total a pagar hasta [fecha]' — es la fecha de pago.",
    "    ✓ '1° Vencimiento [fecha]'",
    INVALID_DATE_RULES,

    "- detail: 'Energía eléctrica' o descripción del servicio.",

    "- clientNumber: número de cliente de Edesur.",
    "  Buscar 'Su número de cliente es XXXXXXXX', 'Nro de cliente T2 XXXXXXXX',",
    "  o 'Cliente N° XXXXXXXX'. Mantener formato exacto incluyendo ceros a la izquierda.",

    "- paymentMethod:",
    "  • 'Esta factura posee débito automático' → DEBITO_AUTOMATICO",
    "  • 'Pago por transferencia CVU' → TRANSFERENCIA",
    "  • Sin mención → null",

    ALL_TAX_IDS_RULES,

    "- Usa null si un dato no se puede extraer con certeza.",

    "Texto de la factura Edesur:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// EDENOR prompt
// ═══════════════════════════════════════════════════════════════════════════

function buildEdenorPrompt(relevantText: string): string {
  return [
    "Extrae datos de una factura de EDENOR (energía eléctrica) argentina.",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS ESPECÍFICAS EDENOR ===",

    "- provider: siempre 'EDENOR S.A.'",
    PROVIDER_NAME_RULES,

    LSP_PROVIDER_TAX_ID_RULES,
    LSP_LATERAL_CUIT_RULES,

    "- boletaNumber: buscar formato LSP similar a Edesur: 'LSP B PPPP-NNNNNNNN'.",
    "  Extraer solo PPPP-NNNNNNNN. Si no hay ese formato, buscar 'Nro. Factura' o similar.",

    CONSORTIUM_ADDRESS_RULES,

    "- amount: monto del PRIMER vencimiento (sin recargo). Formato numérico.",

    "- dueDate: fecha del PRIMER vencimiento. YYYY-MM-DD.",
    "  VÁLIDO:",
    "    ✓ 'Vencimiento [fecha]' junto a un monto.",
    "    ✓ 'Total a pagar hasta [fecha]'",
    INVALID_DATE_RULES,

    "- detail: 'Energía eléctrica'.",

    "- clientNumber: número de cuenta de Edenor.",
    "  Buscar 'Cuenta X XXX XXX XXX' (puede tener espacios). Normalizar eliminando espacios.",

    "- paymentMethod:",
    "  • 'Abona por Pago Directo' o 'DEBITO POR PAGO DIRECTO' → DEBITO_AUTOMATICO",
    "  • Sin mención → null",

    ALL_TAX_IDS_RULES,

    "Texto de la factura Edenor:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// AySA prompt
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Prompt especializado para AySA (Agua y Saneamientos Argentinos S.A.).
 *
 * Particularidades observadas:
 * - CUIT de AySA: 30-70956507-5 (junto a nombre e inicio de actividades)
 * - CUIT del CLIENTE aparece AL FINAL: "IVA RESPONSABLE INSCRIPTO - CUIT No. XX-XXXXXXXX-X"
 * - C.E.S.P (código electrónico): "C.E.S.P: XXXXX | Fecha Vto: DD/MM" → NO es fecha de pago
 * - Caso débito automático: "A debitar el [fecha]" → SÍ es fecha de pago
 * - Caso pago normal: "Vencimiento [fecha]" en encabezado grande
 * - boletaNumber: alfanumérico largo tipo "0106A11487223"
 * - Domicilio: "Domicilio de Prestación del Servicio" con calle y número
 */
function buildAysaPrompt(relevantText: string): string {
  return [
    "Extrae datos de una factura de AySA (Agua y Saneamientos Argentinos) argentina.",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS ESPECÍFICAS AYSA ===",

    "- provider: siempre 'AYSA' (o 'AGUA Y SANEAMIENTOS ARGENTINOS S.A.' si aparece completo).",
    PROVIDER_NAME_RULES,

    LSP_PROVIDER_TAX_ID_RULES,

    "- boletaNumber: número alfanumérico largo, formato típico '0106A11487223'.",
    "  Tomarlo tal cual aparece. Puede estar etiquetado como 'Nro.' o en el código de barras.",

    CONSORTIUM_ADDRESS_RULES,
    "  En AySA buscar específicamente 'Domicilio de Prestación del Servicio'.",

    "- amount: monto total a pagar en el PRIMER vencimiento.",
    "  En débito automático: usar 'Total a debitar $XXX' o 'A debitar el [fecha] $XXX'.",
    "  Formato numérico (ej: 798400.87). Ignorar 2° y 3° vencimiento.",

    "- dueDate: fecha de pago. YYYY-MM-DD.",
    "  VÁLIDO:",
    "    ✓ 'Vencimiento [fecha]' — en encabezado grande, es la fecha de pago.",
    "    ✓ 'Total a pagar hasta el [fecha]' — explícitamente de pago.",
    "    ✓ 'A debitar el [fecha]' — en débito automático, es cuando se cobra.",
    "  INVÁLIDO — siempre null:",
    "    ✗ 'C.E.S.P: XXXXX | Fecha Vto: DD/MM/YYYY' — 'Fecha Vto' aquí es del código",
    "       C.E.S.P (Código Electrónico de Servicio Público). Es una referencia interna",
    "       de AySA para el sistema de cobro electrónico. NO es fecha de pago del usuario.",
    "    ✗ 'Fecha de emisión'",
    "    ✗ 'Próxima liquidación vence el [fecha]' — es del próximo mes.",
    "  Si no existe ningún caso válido: null.",

    "- detail: 'Agua y cloacas' o 'Servicio de agua y saneamiento'.",

    "- clientNumber: número de cuenta de servicios AySA.",
    "  Buscar 'Cuenta de Servicios XXXXX'. Mantener formato exacto.",

    "- paymentMethod:",
    "  • 'A debitar el DD/MM/YYYY' o 'Esta liquidación será debitada' → DEBITO_AUTOMATICO",
    "  • Sin mención → null",

    ALL_TAX_IDS_RULES,

    "Texto de la factura AySA:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Gas companies prompt (Metrogas, Naturgy, Camuzzi, Litoral Gas)
// ═══════════════════════════════════════════════════════════════════════════

const GAS_PROVIDER_NAMES: Record<string, string> = {
  METROGAS: "METROGAS S.A.",
  NATURGY: "NATURGY BAN S.A.",
  CAMUZZI: "CAMUZZI GAS PAMPEANA S.A.",
  LITORAL_GAS: "LITORAL GAS S.A.",
};

function buildGasPrompt(relevantText: string, provider: LSPProvider): string {
  const providerName = GAS_PROVIDER_NAMES[provider] ?? provider;

  return [
    `Extrae datos de una factura de ${providerName} (gas natural) argentina.`,
    JSON_RESPONSE_INSTRUCTION,

    `=== REGLAS ESPECÍFICAS ${provider} ===`,

    `- provider: siempre '${providerName}'.`,
    PROVIDER_NAME_RULES,

    LSP_PROVIDER_TAX_ID_RULES,

    "- boletaNumber: número de la liquidación/factura.",
    "  Buscar 'Nro. Factura', 'Nro. Comprobante', o formato LSP.",

    CONSORTIUM_ADDRESS_RULES,

    "- amount: monto del PRIMER vencimiento (sin recargo). Formato numérico.",

    "- dueDate: fecha del PRIMER vencimiento. YYYY-MM-DD.",
    "  VÁLIDO:",
    "    ✓ 'Vencimiento [fecha]' junto a un monto.",
    "    ✓ 'Total a pagar hasta [fecha]'",
    "    ✓ '1° Vencimiento [fecha]'",
    INVALID_DATE_RULES,

    "- detail: 'Gas natural'.",

    "- clientNumber: número de cliente de la empresa de gas.",
    "  Buscar 'Número de cliente XXXXXXXX' o similar. Mantener formato exacto.",

    PAYMENT_METHOD_RULES,

    ALL_TAX_IDS_RULES,

    `Texto de la factura ${providerName}:`,
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Generic utility bill prompt (fallback for unrecognized LSPs)
// ═══════════════════════════════════════════════════════════════════════════

function buildGenericUtilityBillPrompt(relevantText: string): string {
  return [
    "Extrae datos de una Liquidación de Servicios Públicos (LSP) argentina.",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS PARA LSP (luz, gas, agua) ===",

    "- provider: nombre de la EMPRESA DE SERVICIOS emisora. Es el logo/encabezado principal.",
    "  Ejemplos: 'EDESUR', 'EDENOR', 'AYSA', 'METROGAS', 'NATURGY', 'CAMUZZI'.",
    PROVIDER_NAME_RULES,

    LSP_PROVIDER_TAX_ID_RULES,

    CONSORTIUM_ADDRESS_RULES,

    "- boletaNumber: número de la liquidación.",

    "- amount: monto total a pagar en el PRIMER vencimiento.",
    "  Ignorar 2° y 3° vencimiento (tienen recargo).",
    "  Formato numérico (ej: 798400.87).",

    "- dueDate: fecha de pago. YYYY-MM-DD.",
    "  VÁLIDO:",
    "    ✓ 'Vencimiento [fecha]' junto a un monto — es la fecha de pago.",
    "    ✓ 'Total a pagar hasta el [fecha]' — explícitamente de pago.",
    "    ✓ 'A debitar el [fecha]' — en débito automático.",
    INVALID_DATE_RULES,

    "- detail: tipo de servicio (ej: 'Agua y cloacas', 'Energía eléctrica', 'Gas natural').",

    "- clientNumber: número de cliente/cuenta si aparece en el documento. null si no se encuentra.",

    PAYMENT_METHOD_RULES,

    ALL_TAX_IDS_RULES,

    "Texto de la liquidación:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// PERSONAL (Telecom Argentina) prompt
// ═══════════════════════════════════════════════════════════════════════════

function buildPersonalPrompt(relevantText: string): string {
  return [
    "Extrae datos de una factura de PERSONAL / Telecom Argentina.",
    JSON_RESPONSE_INSTRUCTION,

    "=== REGLAS ESPECÍFICAS PERSONAL ===",

    "- provider: siempre 'PERSONAL'.",
    PROVIDER_NAME_RULES,

    LSP_PROVIDER_TAX_ID_RULES,

    "- boletaNumber: buscar 'N° de Factura XXXXX-XXXXXXXX'. Tomar el formato completo.",

    CONSORTIUM_ADDRESS_RULES,

    "- amount: total a pagar del mes. Formato numérico.",

    "- dueDate: fecha de vencimiento. YYYY-MM-DD.",
    "  VÁLIDO:",
    "    ✓ 'Vencimiento [fecha]' junto a un monto.",
    "    ✓ 'Fecha de vencimiento [fecha]'",
    INVALID_DATE_RULES,

    "- detail: 'Telecomunicaciones' o descripción del servicio.",

    "- clientNumber: buscar 'N° de Referencia de Pago XXXXXXXXXXXXXXXX'.",
    "  Mantener formato exacto incluyendo todos los dígitos.",

    "- paymentMethod:",
    "  • 'DEBITO AUTOMATICO' o 'FACTURA CON DÉBITO AUTOMÁTICO' → DEBITO_AUTOMATICO",
    "  • Sin mención → null",

    ALL_TAX_IDS_RULES,

    "Texto de la factura Personal:",
    relevantText,
  ].join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Output parsing
// ═══════════════════════════════════════════════════════════════════════════

function normalizeModelOutput(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  return trimmed;
}

export function parseExtractionOutput(raw: string): ExtractedDocumentData {
  const normalized = normalizeModelOutput(raw || "{}");
  const parsed = JSON.parse(normalized);
  return EXTRACTED_DOCUMENT_SCHEMA.parse(parsed);
}

// ═══════════════════════════════════════════════════════════════════════════
// Post-extraction refinement (consortium enrichment from raw text)
// ═══════════════════════════════════════════════════════════════════════════

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitNonEmptyLines(text: string): string[] {
  return text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => normalizeLine(line))
    .filter((line) => line.length > 0);
}

function hasLetters(value: string): boolean {
  return /[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(value);
}

function isNumericLikeLine(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  return /^[\d\-./]+$/.test(compact);
}

function isMetadataLine(value: string): boolean {
  return /^(cuit|iva|fecha|cae|comprobante|subtotal|total|domicilio|condici[oó]n|ingresos|inicio|punto de venta|c[oó]digo|regimen|otros impuestos|hys)\b/i.test(
    value
  );
}

function normalizeConsortiumValue(value: string): string {
  const noPrefix = value.replace(/^raz.{0,2}n\s*social\s*:\s*/i, "");
  return normalizeLine(noPrefix);
}

function needsConsortiumEnrichment(consortium: string | null | undefined): boolean {
  if (!consortium) {
    return true;
  }

  const normalized = normalizeLine(consortium)
    .replace(/[.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return /^(cons|consorcio)(\s+de)?\s+prop(ietarios)?$/.test(normalized);
}

function inferConsortiumFromText(text: string): string | null {
  const lines = splitNonEmptyLines(text);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lower = line.toLowerCase();
    const socialIndex = lower.indexOf("social");
    const colonIndex = line.indexOf(":");

    if (socialIndex < 0 || colonIndex < 0 || colonIndex >= line.length - 1) {
      continue;
    }

    const base = normalizeConsortiumValue(line.slice(colonIndex + 1));
    if (!base) {
      continue;
    }

    if (!needsConsortiumEnrichment(base)) {
      return base;
    }

    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const candidate = normalizeLine(lines[j]);
      if (!candidate) {
        continue;
      }

      if (isMetadataLine(candidate) || isNumericLikeLine(candidate) || !hasLetters(candidate)) {
        continue;
      }

      return `${base} ${candidate}`.trim();
    }

    return base;
  }

  return null;
}

export function refineExtractionWithRawText(
  extracted: ExtractedDocumentData,
  rawText: string
): ExtractedDocumentData {
  // Para LSPs no aplicar el refinamiento de consorcio por "Razón Social:"
  // porque esa sección puede pertenecer al cliente, no al consorcio
  if (isUtilityBill(rawText)) {
    return extracted;
  }

  const inferredConsortium = inferConsortiumFromText(rawText);
  if (!inferredConsortium) {
    return extracted;
  }

  const currentConsortium = extracted.consortium ? normalizeLine(extracted.consortium) : null;
  const shouldReplace =
    needsConsortiumEnrichment(currentConsortium) ||
    !currentConsortium ||
    inferredConsortium.length > currentConsortium.length;

  if (!shouldReplace) {
    return extracted;
  }

  return {
    ...extracted,
    consortium: inferredConsortium,
  };
}
