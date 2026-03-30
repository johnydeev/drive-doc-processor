/**
 * Logger centralizado para scheduler y worker.
 *
 * Formato: [TIMESTAMP] [PROCESO] EMOJI mensaje
 *
 * Cada log incluye timestamp ISO para correlacionar entre terminales.
 * Los emojis dan feedback visual instantáneo del tipo de evento.
 */

type LogLevel = "info" | "warn" | "error" | "success" | "debug";
type ProcessTag = "scheduler" | "worker" | "job" | "assign" | "run-cycle";

const LEVEL_PREFIX: Record<LogLevel, string> = {
  info:    "ℹ️ ",
  warn:    "⚠️ ",
  error:   "❌",
  success: "✅",
  debug:   "🔍",
};

function timestamp(): string {
  return new Date().toLocaleString("sv-SE", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).replace("T", " ");
}

function formatTag(process: ProcessTag, sub?: string): string {
  const base = process.toUpperCase();
  return sub ? `${base}:${sub}` : base;
}

function log(level: LogLevel, process: ProcessTag, message: string, sub?: string): void {
  const line = `[${timestamp()}] [${formatTag(process, sub)}] ${LEVEL_PREFIX[level]} ${message}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Separadores visuales para marcar inicio/fin de ciclos
// ═══════════════════════════════════════════════════════════════════════════

function divider(process: ProcessTag, label: string): void {
  const line = `[${timestamp()}] [${process.toUpperCase()}] ${"─".repeat(50)}`;
  console.log(line);
  console.log(`[${timestamp()}] [${process.toUpperCase()}]  ${label}`);
  console.log(line);
}

function miniDivider(process: ProcessTag): void {
  console.log(`[${timestamp()}] [${process.toUpperCase()}] ${"· ".repeat(25)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Scheduler-specific logs
// ═══════════════════════════════════════════════════════════════════════════

export const schedulerLog = {
  starting(intervalMinutes: number) {
    divider("scheduler", `🚀 SCHEDULER INICIADO — intervalo: ${intervalMinutes} min`);
  },

  cycleStart(clientCount: number) {
    miniDivider("scheduler");
    log("info", "scheduler", `Ciclo de escaneo iniciado — ${clientCount} cliente(s) activo(s)`);
  },

  cycleEmpty() {
    log("info", "scheduler", "Sin clientes activos para procesar");
  },

  cycleEnd() {
    log("info", "scheduler", "Ciclo de escaneo finalizado");
  },

  clientPaused(clientId: string, clientName: string) {
    log("info", "scheduler", `Cliente pausado — "${clientName}" [${shortId(clientId)}]`);
  },

  clientScanning(clientId: string, clientName: string) {
    log("info", "scheduler", `Escaneando Drive — "${clientName}" [${shortId(clientId)}]`);
  },

  clientNoPdfs(clientId: string, clientName: string) {
    log("debug", "scheduler", `Sin PDFs pendientes — "${clientName}" [${shortId(clientId)}]`);
  },

  jobsQueued(count: number, clientId: string, clientName: string, totalFound: number, batchSize: number) {
    const capped = totalFound >= batchSize;
    const foundLabel = capped
      ? `${totalFound} encontrado(s) (límite de lote: ${batchSize})`
      : `${totalFound} encontrado(s)`;
    log("success", "scheduler", `${count} job(s) encolado(s) — "${clientName}" [${shortId(clientId)}] — ${foundLabel}`);
  },

  batchLimitReached(clientId: string, clientName: string, created: number, total: number) {
    log("info", "scheduler", `Límite de lote alcanzado (${created}/${total} PDFs) — "${clientName}" [${shortId(clientId)}]. Resto se procesará en el próximo ciclo.`);
  },

  clientError(clientId: string, clientName: string, error: string) {
    log("error", "scheduler", `Error en cliente "${clientName}" [${shortId(clientId)}]: ${error}`);
  },

  fatalError(error: string) {
    log("error", "scheduler", `Error fatal del scheduler: ${error}`);
  },

  skippedBusy() {
    log("warn", "scheduler", "Ciclo omitido — el anterior aún está corriendo");
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Worker-specific logs
// ═══════════════════════════════════════════════════════════════════════════

export const workerLog = {
  starting() {
    divider("worker", "🔧 WORKER INICIADO — esperando jobs...");
  },

  polling() {
    // Silencioso — no loguear cada poll de 2s
  },

  jobClaimed(jobId: string, fileId: string, fileName: string | null, clientName: string) {
    miniDivider("worker");
    log("info", "worker", `Job reclamado: ${shortId(jobId)}`);
    log("info", "worker", `  Archivo: "${fileName ?? fileId}"`);
    log("info", "worker", `  Cliente: "${clientName}"`);
  },

  jobCompleted(jobId: string, fileName: string | null, durationMs: number) {
    log("success", "worker", `Job completado: ${shortId(jobId)} — "${fileName ?? "?"}" (${formatDuration(durationMs)})`);
  },

  jobFailed(jobId: string, fileName: string | null, error: string, attempt: number, maxAttempts: number) {
    log("error", "worker", `Job falló: ${shortId(jobId)} — "${fileName ?? "?"}" (intento ${attempt}/${maxAttempts})`);
    log("error", "worker", `  Error: ${error}`);
  },

  jobRetry(jobId: string, nextAttempt: number, maxAttempts: number) {
    log("warn", "worker", `Job será reintentado: ${shortId(jobId)} (intento ${nextAttempt}/${maxAttempts})`);
  },

  jobPermanentFailure(jobId: string, fileName: string | null) {
    log("error", "worker", `Job descartado (máx intentos): ${shortId(jobId)} — "${fileName ?? "?"}"`);
  },

  clientNotFound(jobId: string, clientId: string) {
    log("error", "worker", `Cliente no encontrado para job ${shortId(jobId)} — clientId=${shortId(clientId)}`);
  },

  clientInactive(jobId: string, clientName: string) {
    log("warn", "worker", `Cliente inactivo para job ${shortId(jobId)} — "${clientName}"`);
  },

  unhandledError(jobId: string, error: string) {
    log("error", "worker", `Error no manejado en job ${shortId(jobId)}: ${error}`);
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Pipeline processing logs (processPendingDocuments.job.ts)
// ═══════════════════════════════════════════════════════════════════════════

export const pipelineLog = {
  fileStart(clientId: string, fileId: string, fileName: string) {
    log("info", "job", `📄 Procesando: "${fileName}"`, shortId(clientId));
    log("debug", "job", `  fileId: ${fileId}`, shortId(clientId));
  },

  stepStart(clientId: string, step: string) {
    log("debug", "job", `  → ${step}...`, shortId(clientId));
  },

  hashResult(clientId: string, hash: string, isDuplicate: boolean) {
    const status = isDuplicate ? "⚠️  DUPLICADO por hash" : "Hash único";
    log("info", "job", `  Hash: ${hash.slice(0, 12)}... — ${status}`, shortId(clientId));
  },

  aiExtraction(clientId: string, provider: "gemini" | "openai", success: boolean, error?: string) {
    if (success) {
      log("success", "job", `  IA: ${provider.toUpperCase()} extrajo datos correctamente`, shortId(clientId));
    } else {
      log("warn", "job", `  IA: ${provider.toUpperCase()} falló — ${error ?? "desconocido"}`, shortId(clientId));
    }
  },

  aiOcrFallback(clientId: string) {
    log("warn", "job", "  IA: Ambos proveedores fallaron → OCR_ONLY", shortId(clientId));
  },

  extractionResult(clientId: string, data: { consortium?: string | null; provider?: string | null; providerTaxId?: string | null; amount?: number | null; dueDate?: string | null; allTaxIds?: string[] | null }) {
    log("info", "job", `  Extraído:`, shortId(clientId));
    log("info", "job", `    Consorcio:  ${data.consortium ?? "null"}`, shortId(clientId));
    log("info", "job", `    Proveedor:  ${data.provider ?? "null"}`, shortId(clientId));
    log("info", "job", `    CUIT:       ${data.providerTaxId ?? "null"}`, shortId(clientId));
    log("info", "job", `    CUITs:      ${(data.allTaxIds ?? []).length > 0 ? (data.allTaxIds ?? []).join(", ") : "ninguno"}`, shortId(clientId));
    log("info", "job", `    Monto:      ${data.amount != null ? `$${data.amount}` : "null"}`, shortId(clientId));
    log("info", "job", `    Vto:        ${data.dueDate ?? "null"}`, shortId(clientId));
  },

  lspDetected(clientId: string, lspProvider: string) {
    log("info", "job", `  📋 Tipo documento: LSP — ${lspProvider}`, shortId(clientId));
  },

  duplicateByBusinessKey(clientId: string) {
    log("warn", "job", "  ⚠️  DUPLICADO por clave de negocio", shortId(clientId));
  },

  // Assignment logs
  consortiumMatch(clientId: string, method: string, canonical: string) {
    log("success", "job", `  Consorcio: match ${method} → "${canonical}"`, shortId(clientId));
  },

  consortiumNotFound(clientId: string, raw: string, normalized: string, dbNames: string[]) {
    log("error", "job", `  Consorcio NO encontrado:`, shortId(clientId));
    log("error", "job", `    OCR:        "${raw}"`, shortId(clientId));
    log("error", "job", `    Normalizado: "${normalized}"`, shortId(clientId));
    log("error", "job", `    DB tiene:    [${dbNames.map(n => `"${n}"`).join(", ")}]`, shortId(clientId));
  },

  providerMatch(clientId: string, method: string, canonical: string) {
    log("success", "job", `  Proveedor: match ${method} → "${canonical}"`, shortId(clientId));
  },

  providerNotFound(clientId: string, rawCuit: string | null, rawName: string | null, normCuit: string, normName: string) {
    log("error", "job", `  Proveedor NO encontrado — CUIT="${rawCuit ?? "null"}" normCuit="${normCuit}" nombre="${rawName ?? "null"}" normNombre="${normName}"`, shortId(clientId));
  },

  providerCuitMatchesConsortium(clientId: string, cuit: string) {
    log("warn", "job", `  CUIT del OCR (${cuit}) coincide con consorcio — fallback a nombre`, shortId(clientId));
  },

  consortiumMatchedByCuit(clientId: string, consortiumName: string, cuit: string) {
    log("success", "job", `  Consorcio: match CUIT (${cuit}) → "${consortiumName}"`, shortId(clientId));
  },

  providerMatchedByCuit(clientId: string, providerName: string, cuit: string) {
    log("success", "job", `  Proveedor: match CUIT (${cuit}) → "${providerName}"`, shortId(clientId));
  },

  lspProviderResolvedFromDB(clientId: string, providerName: string, cuit: string) {
    log("success", "job", `  LSP Proveedor resuelto desde DB: "${providerName}" CUIT=${cuit}`, shortId(clientId));
  },

  lspProviderNotInDB(clientId: string, lspType: string) {
    log("warn", "job", `  LSP Proveedor "${lspType}" no encontrado en tabla Provider — usando nombre del router como fallback`, shortId(clientId));
  },

  // Canonization
  canonized(clientId: string, consortium: string, provider: string, taxId: string) {
    log("info", "job", `  Canonizado → consorcio="${consortium}" proveedor="${provider}" CUIT="${taxId}"`, shortId(clientId));
  },

  // Destination
  movedToScanned(clientId: string, fileId: string) {
    log("success", "job", `  📁 Movido a Escaneados`, shortId(clientId));
  },

  movedToUnassigned(clientId: string, fileId: string, reason: string) {
    log("warn", "job", `  📁 Movido a Sin Asignar — ${reason}`, shortId(clientId));
  },

  movedToFailed(clientId: string, fileId: string) {
    log("error", "job", `  📁 Movido a Fallidos`, shortId(clientId));
  },

  sheetsInserted(clientId: string) {
    log("success", "job", `  📊 Fila insertada en Google Sheets`, shortId(clientId));
  },

  invoiceSaved(clientId: string, isDuplicate: boolean) {
    const dupLabel = isDuplicate ? " (marcado como duplicado)" : "";
    log("success", "job", `  💾 Invoice guardada en DB${dupLabel}`, shortId(clientId));
  },

  fileCompleted(clientId: string, fileName: string, result: { processed: number; unassigned: number; duplicate: boolean }) {
    const status = result.unassigned > 0 ? "⚠️  SIN ASIGNAR" : result.duplicate ? "⚠️  DUPLICADO" : "✅ OK";
    log("info", "job", `  Resultado: ${status} — "${fileName}"`, shortId(clientId));
  },

  fileFailed(clientId: string, fileName: string, error: string) {
    log("error", "job", `  ❌ FALLÓ: "${fileName}" — ${error}`, shortId(clientId));
  },

  batchStart(clientId: string, clientName: string, pendingFolder: string, fileCount: number) {
    divider("job", `📦 PROCESANDO LOTE — "${clientName}" — ${fileCount} archivo(s)`);
    log("debug", "job", `  Carpeta pendientes: ${pendingFolder}`, shortId(clientId));
  },

  batchSummary(clientId: string, summary: { totalFound: number; processed: number; unassigned: number; failed: number; duplicatesDetected: number }) {
    miniDivider("job");
    log("info", "job", `📊 RESUMEN DEL LOTE:`, shortId(clientId));
    log("info", "job", `  Encontrados:  ${summary.totalFound}`, shortId(clientId));
    log("info", "job", `  Procesados:   ${summary.processed}`, shortId(clientId));
    log("info", "job", `  Sin asignar:  ${summary.unassigned}`, shortId(clientId));
    log("info", "job", `  Duplicados:   ${summary.duplicatesDetected}`, shortId(clientId));
    log("info", "job", `  Fallidos:     ${summary.failed}`, shortId(clientId));
    miniDivider("job");
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Run cycle logs
// ═══════════════════════════════════════════════════════════════════════════

export const cycleLog = {
  start(trigger: string, clientCount: number, intervalMinutes: number, targetClient?: string) {
    divider("run-cycle", `🔄 CICLO DE PROCESAMIENTO — trigger=${trigger}`);
    log("info", "run-cycle", `Clientes: ${clientCount} | Intervalo: ${intervalMinutes}min | Target: ${targetClient ?? "ALL"}`);
  },

  clientStart(clientId: string, clientName: string) {
    log("info", "run-cycle", `Iniciando cliente: "${clientName}" [${shortId(clientId)}]`);
  },

  clientDone(clientId: string, processed: number, unassigned: number, failed: number) {
    const emoji = failed > 0 ? "⚠️ " : "✅";
    log("info", "run-cycle", `${emoji} Cliente terminado [${shortId(clientId)}]: procesados=${processed} sinAsignar=${unassigned} fallidos=${failed}`);
  },

  clientFailed(clientId: string, error: string) {
    log("error", "run-cycle", `Cliente falló [${shortId(clientId)}]: ${error}`);
  },

  aggregateSummary(summary: { totalFound: number; processed: number; unassigned: number; failed: number; duplicatesDetected: number }) {
    divider("run-cycle", "📊 RESUMEN TOTAL DEL CICLO");
    log("info", "run-cycle", `Encontrados:  ${summary.totalFound}`);
    log("info", "run-cycle", `Procesados:   ${summary.processed}`);
    log("info", "run-cycle", `Sin asignar:  ${summary.unassigned}`);
    log("info", "run-cycle", `Duplicados:   ${summary.duplicatesDetected}`);
    log("info", "run-cycle", `Fallidos:     ${summary.failed}`);
    miniDivider("run-cycle");
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function shortId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
