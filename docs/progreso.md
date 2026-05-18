# Progreso del proyecto — drive-doc-processor

Actualizado al 04/04/2026 (sesión 23).

---

## Estado general

El sistema core está funcionando en producción. Pipeline de PDFs, extracción IA, matching y envío a Sheets completo. Se dockerizó el proyecto con 3 servicios separados (web, scheduler, worker), CI/CD con GitHub Actions, y Cloudflare Tunnel integrado.

---

## Completado ✅

- **CI: tag de imagen Docker con SHA del commit** (17/05/2026)
  - `.github/workflows/ci.yml` (step "Build and push image") ahora produce dos
    tags simultáneos: `:latest` y `:${{ github.sha }}`
  - Permite rollbacks puntuales en el deploy haciendo `docker pull` del SHA
    correspondiente a una versión estable anterior
  - Sin cambios en el resto del pipeline (deploy sigue usando `:latest`)

- **Resumen del ciclo automático del scheduler** (11/05/2026)
  - `schedulerLog.cycleSummary()` nuevo en `src/lib/logger.ts` con Encontrados / Encolados / Ya en cola
  - `src/jobs/scheduler.ts::runOnce()` acumula `totalFound`, `totalQueued` y `totalSkipped`
    a lo largo del ciclo y emite el resumen antes de `cycleEnd()` solo cuando `totalFound >= 1`
  - No afecta al flujo manual (`runProcessingCycle`) ni al log existente "RESUMEN TOTAL DEL CICLO"

- **Resumen agregado en el worker al vaciarse la cola** (11/05/2026)
  - `workerLog.cycleSummary()` nuevo en `src/lib/logger.ts` con Procesados / Sin asignar / Duplicados / Fallidos
  - `handleJob()` ahora retorna `ProcessJobSummary | null` para que el loop pueda acumular
  - `runWorker()` mantiene contadores entre jobs (`cycleProcessed`, `cycleFailed`, `cycleUnassigned`,
    `cycleSkipped`) y los emite cuando `claimNextJob()` retorna null tras haber procesado ≥ 1 job,
    reseteando los contadores antes del próximo ciclo

- **Hardening de seguridad** (15/04/2026)
  - /api/process protegido con autenticación admin (+ alineación OpenAPI)
  - VIEWER bloqueado en endpoints de escritura y en scan (consume IA/OCR)
  - Límites de tamaño, MIME y magic bytes en todos los uploads
  - Cifrado versionado v2: nuevos secretos con GOOGLE_CREDENTIALS_ENCRYPTION_KEY,
    legado `enc:...` legible probando ambas claves candidatas (GCEK y SESSION_SECRET)
  - Script idempotente `scripts/rotate-encrypted-secrets.ts` para migración
  - Sanitización (CUIT/importes/emails/CBU) + truncado en logs de debug mode
  - Logs normales: PII redactada en extractionResult (CUIT/monto). Diagnóstico
    de pdf-extractor ya no vuelca los primeros 500 chars del texto
  - Scan: imágenes JPG/PNG van a Gemini Vision (no a pdf-parse)
- **Fix lógica de deduplicación** (15/04/2026)
  - `boletaNumber` es campo primario: si es distinto → no es duplicado (aunque monto y vencimiento coincidan)
  - `findDuplicateByBusinessKey` ahora arma `WHERE` dinámico solo con campos presentes y requiere ≥ 2 condiciones
  - Nueva función `isDuplicateByPriority` en `src/lib/businessKey.ts` para validar en memoria
  - Duplicados detectados **no se persisten en DB** — solo se escriben en Sheets (columna L = "YES") y se mueven a Escaneados
- **Solapa Pagos en vista de consorcio** (15/04/2026)
  - Tabs Boletas/Pagos en el header del consorcio
  - `PagosView` inline con tabla editable (fecha, importe, medio de pago)
  - Empleados: pagan monto total (readonly); proveedores: pueden pagar parcial
  - Medios de pago dinámicos con banco del consorcio (Transferencia/Cheque propio [BANCO]), Descuento, Efectivo
  - Botón GUARDAR sincroniza DB + Google Sheets (columna N "ESTADO PAGO" → "Pagado")
  - Migración `20260415000200`: `Payment.driveFileId`/`driveFileUrl` opcionales + nuevo `paymentMethod` (texto libre)
  - Nuevo método `GoogleSheetsService.updatePaymentStatus()` busca fila por URL o boletaNumber+CUIT
- **Soporte imágenes JPG/PNG en pipeline** (15/04/2026)
  - Scheduler detecta image/jpeg e image/png además de application/pdf
  - Pipeline detecta tipo de archivo y usa Gemini Vision directamente
  - Sin OCR ni pdf-parse para imágenes — extracción 100% visual
  - Nuevo método `extractStructuredDataFromImage()` en GeminiExtractorService
- **Soporte empleados de consorcio** (15/04/2026)
  - ProviderType enum: PROVEEDOR / EMPLEADO en tabla Provider
  - Prompt dedicado para recibos de haberes (`buildReciboHaberesPrompt`)
  - Router `isReciboHaberes()` detecta recibos antes del router LSP
  - Sync-directory con columna TIPO en `_Proveedores`
  - UI: badge EMPLEADO en select, label CUIL/CUIT según tipo
  - Migración: `20260415000100_add_provider_type`
- **Fallback visual Gemini Vision** (14/04/2026)
  - Última instancia cuando proveedor no matchea y emisor está en imagen
  - Gemini recibe el PNG de pdftoppm y extrae nombre y CUIT del emisor visualmente
  - Fallo silencioso: si Vision falla el flujo continúa a Sin Asignar normalmente
  - Condiciones: unassigned=true AND consortiumId!=null AND hasEmitterBlock=false AND PNG disponible
- **Toggle Modo Debug por cliente** (13/04/2026)
  - Botón en panel admin para activar/desactivar debug por cliente
  - Cuando está activo, el pipeline logea texto completo post-OCR y respuesta raw de IA
  - Usa `extractionConfigJson.debugMode` — sin migración
  - Endpoint: `PATCH /api/admin/clients/[id]/debug-mode`
- **Lock de archivo vía carpeta Procesando** (09/04/2026)
  - Nuevo campo opcional `processing` en `driveFoldersJson`
  - Tras descargar el PDF, el pipeline lo mueve a la carpeta Procesando como lock atómico a nivel Drive
  - Los movimientos finales (Escaneados / Sin Asignar / Fallidos) usan Procesando como origen cuando el lock está activo
  - Soluciona race condition: manual + scheduler tomando el mismo archivo de Pendientes
  - Sin migración: solo requiere agregar el ID de carpeta en `driveFoldersJson.processing` del cliente
- Pipeline de procesamiento de PDFs (download → dedup → extracción → match → Sheets → mover)
- Extracción IA con Gemini + fallback OpenAI
- **Prompts LSP por empresa** — `identifyLSPProvider()` como router con prompts para Edesur, Edenor, AySA, Metrogas, Naturgy, Camuzzi, Litoral Gas (21/03/2026)
- **Normalización de direcciones LSP** — limpieza de ceros, sufijos numéricos, CP, piso/depto (21/03/2026)
- **CUIT hardcodeado por empresa LSP** — elimina confusión proveedor vs consorcio (21/03/2026)
- **Reglas dueDate específicas** — CESP, CAE y fechas inválidas por empresa (21/03/2026)
- **Logging estructurado** — módulo `src/lib/logger.ts` con timestamps, emojis, separadores, logs por proceso (21/03/2026)
- Matching de consorcios (exacto + fuzzy + alias) con expansión de abreviaturas
- Matching de proveedores (CUIT + nombre + parcial)
- Deduplicación por hash SHA256 y business key
- Sistema multi-tenant con roles ADMIN / CLIENT / VIEWER
- Autenticación con JWT + cookie httpOnly
- CRUD de consorcios, proveedores y períodos
- Importación masiva desde Excel (edificios + proveedores)
- Recibo de pago: subida a Drive + guardado en Invoice
- Scheduler + Worker como procesos separados
- Sincronización directorio ALTA (Sheets → DB) con 4 hojas
- Panel admin con métricas, alta de clientes, edición de configuración
- **Fix LSP fast path: asigna providerId y providerTaxId** (09/04/2026)
  - Cuando el pipeline resuelve por LspService, ahora busca el Provider via LspService.providerId FK
  - Asigna providerId y providerTaxId al Invoice correctamente
  - Antes: ambos campos quedaban NULL en boletas LSP resueltas por fast path
- **Mapa router→canonicalName para lookup LspService** (09/04/2026)
  - `LSP_ROUTER_TO_CANONICAL` traduce "PERSONAL"→"TELECOM ARGENTINA S.A.", etc.
  - El lookup de LspService ahora usa el nombre canónico de DB en lugar del nombre del router
  - Antes: providerName="PERSONAL" no matcheaba con providerName="TELECOM ARGENTINA S.A."
- **Rename LspService.provider → providerName** (09/04/2026)
  - Convención camelCase inglés + mayor claridad (providerName vs providerId)
  - Migración expand-contract: add → copy → drop
  - Migración: `20260409000200_rename_lspservice_provider`
- **Fix providerId en LspService al sincronizar directorio** (09/04/2026)
  - sync-directory ahora resuelve y guarda providerId al crear/actualizar LspServices
  - Campo providerName (texto) se mantiene — providerId es complementario
  - Paso retroactivo: resuelve providerId NULL en registros históricos en cada sync
  - Antes: providerId quedaba NULL aunque el Provider existiera en DB
- **Fix normalización clientNumber LSP** (09/04/2026)
  - Extendida normalización para eliminar espacios internos además de ceros a la izquierda
  - Afecta: pipeline lookup, sync-directory, endpoint UI de LspServices
  - Antes: "8 620 004 726" no matcheaba con "8620004726" → lspServiceId quedaba NULL
- **Logging persistente en Docker** (09/04/2026)
  - Configuración json-file con rotación (50MB x 10 archivos por servicio)
  - Script `export-logs.ps1` para exportar logs a `/logs/` con fecha
  - Carpeta `/logs/` excluida de git
- **Bloqueo LSP sin clientNumber registrado** (09/04/2026)
  - Si una boleta LSP llega con un clientNumber que no existe en LspService → Sin Asignar
  - Nuevo log: `lspClientNumberNotRegistered` con provider y clientNumber
  - Antes: la boleta se procesaba igual sin lspServiceId
- **Rename banco→bank, claveSuterh→suterhKey en Consortium** (09/04/2026)
  - Convención establecida: todos los campos nuevos en camelCase inglés
  - Migración con expand-contract: add new → copy data → drop old
  - Migración: `20260409000100_rename_consortium_banco_suterh`
- Campo `aliases` en Consortium (migración aplicada)
- Tablas Rubro y Coeficiente a nivel cliente (migración aplicada)
- Regla de documentación obligatoria en `docs/` establecida (21/03/2026)
- **Dockerización completa** — Dockerfile multi-stage con standalone, 3 servicios separados en docker-compose (21/03/2026)
- **CI/CD con GitHub Actions** — lint + typecheck + build jobs + Docker build + deploy automático (21/03/2026)
- **ESLint configurado** — typescript-eslint + @next/eslint-plugin-next (21/03/2026)
- **Cloudflare Tunnel** integrado en docker-compose (21/03/2026)
- **Fixes de build**: encoding UTF-8 en close-period/route.ts, async params en receipt/route.ts, clientAuth.ts creado, type cast en scan/route.ts (21/03/2026)
- **Campos banco y claveSuterh en Consortium** (07/04/2026) — Nuevos campos nullable: `banco` y `claveSuterh`. `banco` incluido como columna O en Google Sheets con header "BANCO". `claveSuterh` solo en DB, sin UI por ahora. Migración: `20260407000100_add_consortium_banco_suterh`
- **Columna ESTADO PAGO en Google Sheets** (07/04/2026) — Nuevo campo `paymentStatus` en `SheetsRowMapping`, `HEADER_BY_FIELD`, `DEFAULT_MAPPING` y `ExtractedDocumentData`. Columna N en Sheets con header "ESTADO PAGO". Valor inicial "Sin pagar" al procesar/cargar boleta. Actualización retroactiva de pagos existentes: pendiente (mejora futura)
- **Auditoría de producción Docker** — revisión completa de dependencias, env vars, migraciones y Docker setup (23/03/2026)
  - TypeScript compila sin errores, ESLint solo 8 warnings menores (variables no usadas)
  - `build:jobs` compila correctamente
  - `@napi-rs/canvas` confirmado en uso en `ocr.service.ts` (necesario para OCR via canvas)
  - 14 migraciones aplicadas, schema up to date, sin pendientes
- **Optimización docker-compose** — eliminado triple build redundante (23/03/2026)
  - Antes: los 3 servicios (web, scheduler, worker) tenían `build:` propio → imagen se construía 3 veces
  - Ahora: solo `web` tiene `build:`, los 3 comparten `image: drive-doc-processor:latest`
  - `docker compose up --build` construye una sola vez y los 3 servicios reusan la misma imagen
- **`.env.example` actualizado** — agregada `GOOGLE_CREDENTIALS_ENCRYPTION_KEY`, comentarios descriptivos por sección, variables agrupadas por categoría (23/03/2026)
- **Renombrado alias/aliases → matchNames + nuevo campo paymentAlias** (23/03/2026)
  - Provider: `alias` → `matchNames` (interno, matching múltiple separado por `|`) + `paymentAlias` (visible en UI y Sheets)
  - Consortium: `aliases` → `matchNames` (interno, matching) + `paymentAlias` (visible en UI y Sheets)
  - Migración: `20260323000100_rename_alias_to_matchnames_add_paymentalias` (aplicada)
  - Pipeline: columna "ALIAS" de Sheets ahora escribe `provider.paymentAlias` (vacío si no tiene)
  - Sync ALTA: hojas `_Consorcios` y `_Proveedores` ampliadas a 4 columnas (A:D)
  - Import Excel: nueva columna "Alias de pago" en ambas hojas
  - UI: provider muestra `paymentAlias` como "Alias", `matchNames` es invisible
- **Modelo LspService + PaymentMethod** (23/03/2026)
  - Nueva tabla `LspService`: clientId, consortiumId, provider (normalizado), clientNumber, description
  - Nuevo enum `PaymentMethod`: DEBITO_AUTOMATICO, TRANSFERENCIA, EFECTIVO
  - Invoice: nuevos campos `lspServiceId` (FK nullable) y `paymentMethod` (nullable)
  - Prompts LSP actualizados: todos extraen `clientNumber` y `paymentMethod`
  - Nuevo prompt `buildPersonalPrompt` con keywords PERSONAL/TELECOM en router
  - Pipeline: extracción limitada a página 1 para LSP + lookup en LspService por clientNumber
  - Sheets: nueva columna NRO CLIENTE (J), sourceFileUrl→K, isDuplicate→L
  - Hoja `_LspServices` en archivo ALTA (4 columnas: NOMBRE CANÓNICO, PROVEEDOR, NRO CLIENTE, DESCRIPCIÓN)
  - Sync directory: reemplazo total de LspServices por cliente
  - Migración: `20260323000200_add_lspservice_paymentmethod` (aplicada)
  - Eliminado campo `isAutoCreated` (ya no existía en schema)
- **Feature `consortiumsEnabled` (Premium)** (23/03/2026)
  - Nuevo campo `consortiumsEnabled Boolean @default(false)` en Client
  - Panel admin: columna "Premium" con toggle ON/OFF optimista (reemplaza columna ClientId)
  - Panel cliente: botón "Consorcios" deshabilitado con badge "Premium" si `consortiumsEnabled` es false
  - Página `/admin/consortiums`: guard que verifica acceso y redirige si no está habilitado
  - Endpoints actualizados: `/api/auth/me`, `/api/admin/clients/[id]`, `/api/admin/audit/clients`
  - Migración: `20260323000300_add_consortiums_enabled` (aplicada)
- **Asignación automática de período a invoices** (23/03/2026)
  - Pipeline: al matchear consorcio, busca su período ACTIVE y asigna `periodId` al Invoice
  - Google Sheets: nueva columna `period` (formato `MM/YYYY`) agregada en posición M (después de isDuplicate)
  - Columnas existentes (A–L) sin cambios, `clientNumber` permanece en J
  - Invoices manuales: también escriben el período en Sheets
  - Si no hay período activo: warning en logs, `periodId` queda null (no rompe el pipeline)
- **Sidebar colapsable + menú hamburguesa en panel cliente** (24/03/2026)
  - Sidebar global con: placeholder logo, nombre del cliente, botones (Sincronizar directorio, Consorcios con badge Premium, Cerrar Periodo General, Cerrar sesión)
  - Colapsable en desktop (iconos / iconos + labels), menú hamburguesa para tablet/mobile
  - Toolbar superior: Pausar/Ejecutar scheduler a la izquierda, toggle de tema a la derecha
- **Toggle dark/light con iconos sol/luna** (24/03/2026)
  - Reemplazado botón de texto por switch tipo interruptor con iconos
  - Estado solo de sesión (no persiste en localStorage)
- **Cerrar Periodo General** (24/03/2026)
  - Botón solo visible para rol CLIENT en el sidebar
  - `GET /api/client/periods/close-all/preview`: calcula mes mayoritario, retorna toClose + toSkip
  - `POST /api/client/periods/close-all`: cierra períodos del mes mayoritario, crea siguiente
  - Modal de 2 pasos: preview con lista de consorcios salteados → resultado con contadores
- **Período por defecto con mes mayoritario** (24/03/2026)
  - `ConsortiumRepository.resolveMajorityMonth()`: usa mes mayoritario o mes actual si no hay consorcios
  - `createManual()`, import Excel, sync-directory usan la misma lógica
  - Sync-directory ahora crea período activo para consorcios nuevos que no tenían uno
- **Purga completa de boletas por cliente (Admin)** (24/03/2026)
  - `GET /api/admin/clients/[id]/purge`: preview con count de boletas
  - `DELETE /api/admin/clients/[id]/purge`: purga completa (Drive → Sheets → DB)
  - Flujo: mueve archivos Drive a pendientes (scanned/unassigned → pending), limpia Sheets (fila 2+), borra Invoices + ProcessingJobs en transacción
  - Tolerancia a fallos: Drive/Sheets fallan → warning, DB se borra igual
  - UI: botón "Purgar" en tabla de métricas admin, modal de 3 pasos (preview → confirm → result)
  - Método `clearAllDataRows(sheetName)` en GoogleSheetsService
- **Tracking de tokens con desglose input/output por provider y modelo** (24/03/2026)
  - `TokenUsageBreakdown` nuevo tipo: `{ inputTokens, outputTokens, totalTokens }`
  - `TokenUsageSummary.byProvider` y `byModel` cambiados de `Record<string, number>` a `Record<string, TokenUsageBreakdown>`
  - `accumulateTokenUsage()` ahora acumula input/output/total dentro de cada provider y modelo
  - `processingPersistence.service.ts`: filas por provider/model ahora graban input/output reales (antes eran 0)
  - `schedulerControl.service.ts`: `loadTokenBreakdown()` suma input/output/total desde DB; `toSummary()` compatible con formato viejo (number) y nuevo (object)
  - UI: sección "Tokens usados" muestra In/Out/Total por Gemini y OpenAI
- **Validación en producción** (26/03/2026)
  - Deploy Docker completo funcionando: Docker Desktop + Cloudflare Tunnel + dominio propio
  - Los 3 servicios (web, scheduler, worker) operativos en producción
  - Prompts LSP validados con PDFs reales: Edesur y AySA extracción correcta
- **Aclaración flujo matchNames** (26/03/2026)
  - matchNames de consorcios y proveedores se cargan/editan desde hojas `_Consorcios` y `_Proveedores` del archivo ALTA en Google Sheets
  - Se sincronizan a la DB desde el panel con botón "Sincronizar directorio"
  - No requiere UI adicional de edición de matchNames
- **Procedimiento de deploy documentado** (26/03/2026)
  - Deploy estándar: `docker compose up --build -d`
  - Deploy con migraciones: `down → prisma migrate deploy → prisma generate → up --build -d`
- **Límite de PDFs por lote configurable (batchSize)** (26/03/2026)
  - Nuevo campo `batchSize Int @default(10)` en modelo Client
  - Scheduler respeta `batchSize` del cliente: si hay más PDFs pendientes que el límite, los deja para el próximo ciclo
  - UI: campo "Tamaño de lote" en la página de edición de cliente admin
  - API: endpoint PATCH `/api/admin/clients/[id]` acepta `batchSize` (int, 1-500)
  - Migración: `20260326000100_add_batch_size_and_invoice_tokens`
- **Boletas sin asignar no se guardan en DB** (27/03/2026)
  - Pipeline: cuando `assignment.unassigned === true`, el archivo se mueve a Sin Asignar pero ya NO se guarda como Invoice en la DB
  - Eliminado `saveProcessedInvoice` y `pipelineLog.invoiceSaved` del bloque unassigned
  - El hash tampoco se persiste (solo se persistía via `saveProcessedInvoice`)
  - Beneficio: la DB solo contiene boletas efectivamente procesadas y asignadas
- **Sync-directory: transacción única dividida en 5 transacciones por entidad** (27/03/2026)
  - Rubros, Coeficientes, Consorcios+Períodos, Proveedores y LspServices en transacciones separadas
  - Cada transacción con timeout de 30s (antes: una sola de 60s que podía excederse)
  - Misma lógica interna, solo separada en bloques independientes
- **Aclaración CUIT emisor vs receptor en facturas B/C** (27/03/2026)
  - Prompt `buildInvoicePrompt`: agregada trampa común donde el CUIT del receptor tiene etiqueta 'CUIT:' prominente y el del emisor está en el encabezado sin etiqueta explícita
- **Constante compartida LSP_LATERAL_CUIT_RULES para CUIT en margen lateral** (27/03/2026)
  - Nueva constante `LSP_LATERAL_CUIT_RULES` en reglas compartidas de `extraction.ts`
  - Reemplaza la aclaración inline de Edesur y se incluye también en Edenor
  - Indica que el CUIT aparece en el margen lateral izquierdo rotado/vertical
- **Proveedor LSP resuelto por CUIT desde tabla Provider (elimina CUITs hardcodeados)** (27/03/2026)
  - Nuevo campo `providerId String?` en modelo LspService con FK a Provider
  - Relación inversa `lspServices LspService[]` en modelo Provider
  - Migración: `20260327000100_lspservice_add_provider_fk`
  - Eliminados CUITs hardcodeados de todos los prompts LSP (Edesur, Edenor, AySA, Gas, Personal)
  - Nueva constante `LSP_PROVIDER_TAX_ID_RULES` reemplaza instrucciones de CUIT específicas por empresa
  - Exportado `LSP_FALLBACK_NAMES` como mapa LSP → nombre para fallback cuando el proveedor no está en DB
  - Pipeline: busca proveedor LSP por CUIT en `allTaxIds` contra tabla Provider antes del lookup de LspService
  - LspService lookup: primero por `providerId` (FK), luego fallback a campo texto `provider` (backward compatible)
  - Actualización progresiva: si LspService no tiene `providerId` pero se resuelve, se actualiza automáticamente
  - Sync-directory: resuelve `providerId` al sincronizar `_LspServices` buscando por nombre canónico en Provider
  - Logger: nuevos métodos `lspProviderResolvedFromDB` y `lspProviderNotInDB`
  - Si el proveedor LSP no está cargado en Provider → warning + fallback al nombre del router (no rompe pipeline)
- **Normalización de clientNumber para LspService lookup** (26/03/2026)
  - Pipeline: `extracted.clientNumber` se normaliza con `.replace(/^0+/, "")` antes del lookup de LspService (ej: `00366037` → `366037`)
  - Sync-directory: al sincronizar `_LspServices` desde Sheets, el `clientNumber` se guarda sin ceros a la izquierda
  - Sin cambios en schema, migraciones ni prompts
- **CUIT como identificador primario en matching (allTaxIds)** (26/03/2026)
  - Nuevo campo `allTaxIds: string[]` en `ExtractedDocumentData` — la IA extrae todos los CUITs del documento como lista plana
  - Nueva constante `ALL_TAX_IDS_RULES` en `src/lib/extraction.ts`, incluida en los 7 prompts
  - Schema Zod actualizado con campo `allTaxIds` (array de strings, nullable, default null)
  - `OUTPUT_JSON_TEMPLATE` actualizado con el nuevo campo
  - Matching de consorcio refactorizado: CUIT-first → exacto → fuzzy → alias
  - Matching de proveedor refactorizado: CUIT allTaxIds → CUIT providerTaxId (legacy) → nombre exacto → nombre parcial
  - CUITs del consorcio excluidos automáticamente al buscar proveedor
  - Logger actualizado: `extractionResult` muestra allTaxIds; nuevos métodos `consortiumMatchedByCuit` y `providerMatchedByCuit`
  - Backward-compatible: si `allTaxIds` viene vacío o null, el flujo de matching por nombre funciona igual que antes
- **Razón social en nombre de proveedor (PROVIDER_NAME_RULES)** (26/03/2026)
  - Nueva constante compartida `PROVIDER_NAME_RULES` en `src/lib/extraction.ts`
  - Instruye a la IA a conservar la razón social (S.R.L., S.A., S.A.S., S.C., S.H., COOP., LTDA., etc.) como parte del nombre del proveedor
  - Incluida en todos los prompts: `buildInvoicePrompt`, `buildEdesurPrompt`, `buildEdenorPrompt`, `buildAysaPrompt`, `buildGasPrompt`, `buildPersonalPrompt`, `buildGenericUtilityBillPrompt`
  - No modifica lógica de matching ni normalización — solo la instrucción de extracción IA
- **Registro de tokens por factura individual** (26/03/2026)
  - Nuevos campos en Invoice: `tokensInput`, `tokensOutput`, `tokensTotal`, `aiProvider`, `aiModel`
  - Pipeline: al completar la extracción IA guarda los tokens consumidos y el proveedor/modelo usado en cada Invoice
  - Nueva página `/admin/invoices` (solo ADMIN): tabla paginada con filtro por cliente
  - Columnas: Cliente, Consorcio, Proveedor, Período, Monto, Tokens In/Out/Total, Provider IA, Modelo IA, Fecha
  - Endpoint `GET /api/admin/invoices` protegido con `requireAdminSession`
  - Botón "Invoices" en el panel admin (solo visible para ADMIN)
  - Migración: misma que batchSize (`20260326000100_add_batch_size_and_invoice_tokens`)
- **Intervalo del scheduler configurable por cliente (`intervalMinutes`)** (27/03/2026)
  - Nuevo campo `intervalMinutes Int @default(60)` en modelo Client
  - Scheduler respeta intervalo individual: mantiene `Map<clientId, lastRunTimestamp>` y salta clientes cuyo intervalo no se cumplió
  - `touchHeartbeat` y `getState` usan el intervalo del cliente (con fallback al global del `.env`)
  - UI: campo "Intervalo del scheduler" en la página de edición de cliente admin (1-1440 min)
  - API: endpoint PATCH `/api/admin/clients/[id]` acepta `intervalMinutes` (int, 1-1440)
  - Migración: `20260327000200_add_interval_minutes`
- **UI de edición de matchNames de consorcio** (30/03/2026)
  - Nuevo campo editable en la vista de detalle de consorcio para `matchNames`
  - Nuevo endpoint `PATCH /api/client/consortiums/[id]` con `requireClientSession`
  - Muestra valor actual con botón "Editar", campo de texto con ayuda, botón guardar/cancelar
- **UI de gestión de LspServices desde el panel** (30/03/2026)
  - Sección "Servicios públicos (LSP)" en detalle de consorcio con tabla y formulario inline
  - Endpoints: `GET/POST /api/client/consortiums/[id]/lsp-services`, `DELETE .../[lspId]`
  - Tabla con Empresa, Nro. Cliente, Descripción y botón Eliminar con confirmación inline
  - Formulario inline: dropdown de 8 proveedores, nro. de cliente (normalizado sin ceros), descripción opcional
  - Manejo de 409 (duplicado) con mensaje específico
- **Mejora de `ALL_TAX_IDS_RULES`** (30/03/2026)
  - Instrucción más precisa para extraer todos los CUITs con formato normalizado con guiones (`XX-XXXXXXXX-X`)
  - Regla explícita: DNI con exactamente 11 dígitos se trata como CUIT del consorcio y se incluye en allTaxIds
  - DNI con menos de 11 dígitos se ignora (DNI real de persona física)
  - CAE (14 dígitos) y número de comprobante excluidos explícitamente
  - Ingresos Brutos incluido como señal del CUIT del emisor
- **Mejora de `buildInvoicePrompt`** (30/03/2026)
  - Nueva descripción estructural del layout AFIP estándar (bloque emisor / comprobante / receptor)
  - Orientación explícita para distinguir el CUIT del emisor del receptor
  - `providerTaxId` puede ser null sin romper el matching (allTaxIds como fallback)
- **Tunnel estabilizado** (02/04/2026)
  - Versión fija `cloudflare/cloudflared:2025.2.0` en docker-compose.yml
  - Agregado `--no-autoupdate` y `--url http://web:3000` al comando
  - Zona horaria corregida en logs: UTC-3 Buenos Aires usando `toLocaleString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" })`
- **Mejoras de logging** (02/04/2026)
  - Separadores visuales entre archivos procesados (divider en fileStart/fileCompleted)
  - Separadores en ciclos del scheduler (═ para fin, ─ para inicio)
  - Separador en worker al reclamar job
  - Timestamp con zona horaria correcta UTC-3
  - Log de cantidad de archivos encontrados en jobsQueued con indicador de límite de lote
- **Fix scheduler: jobs COMPLETED/FAILED no bloquean reprocesamiento** (02/04/2026)
  - scheduler.ts: filtro `status: { in: ["PENDING", "PROCESSING"] }` en existingJob
  - Permite reprocesar archivos que volvieron a Pendientes desde Sin Asignar
- **OCR híbrido para PDFs con bloque emisor en imagen** (02/04/2026)
  - Detección semántica del bloque emisor AFIP en pdfTextExtractor.service.ts buscando etiquetas exclusivas: "ING. BRUTOS", "INICIO DE ACTIVIDADES", "RESPONSABLE INSCRIPTO", "MONOTRIBUTO"
  - Si el bloque no está en texto → activa OCR con pdftoppm + Tesseract
  - OcrService reescrito: usa pdftoppm (poppler-utils) en lugar de pdfjs-dist
  - Textos combinados con separador --- OCR --- para máxima información a la IA
  - Fallo silencioso: si OCR falla → continúa con texto de pdf-parse → Sin Asignar
  - poppler-utils agregado al Dockerfile
  - Validado con facturas de emisor en imagen: primera extracción exitosa automática
- **CUITs alternativos de consorcio en matchNames** (02/04/2026)
  - El pipeline verifica CUITs en matchNames al hacer matching por CUIT de allTaxIds
  - Permite consorcios con múltiples CUITs sin cambios de schema
  - Uso: agregar CUIT alternativo en columna Aliases del archivo ALTA
- **Sync-directory: upsert de Proveedores optimizado** (02/04/2026)
  - Reemplazado `findFirst` + `update`/`create` por `upsert` directo con compound key `clientId_canonicalName`
  - Reduce de 2 queries a 1 por proveedor (menos overhead en la transacción)
  - Nuevo constraint `@@unique([clientId, canonicalName])` en Provider
  - Migración: `20260402000100_provider_unique_client_canonical`
  - Logs de timing por etapa: Rubros, Coeficientes, Consorcios, Proveedores, LspServices
- **Feature "Reprocesar Sin Asignar"** (30/03/2026)
  - Botón "♻️ Sin Asignar" en sidebar del panel cliente (solo rol CLIENT)
  - Lista archivos en carpeta Sin Asignar de Drive via preview endpoint
  - Los mueve a Pendientes con un click, el scheduler los procesa en el próximo ciclo
  - Sin cambios en pipeline ni schema
  - Endpoints: `GET /api/client/unassigned/preview`, `POST /api/client/unassigned/requeue`

- **Sistema de pagos parciales (Payment tracking)** (02/04/2026)
  - Nueva tabla `Payment`: amount, paymentDate, installmentNumber, totalInstallments, driveFileId, driveFileUrl, observation
  - Campos nuevos en Invoice: `isPaid` (Boolean), `remainingBalance` (Decimal)
  - Eliminados campos Invoice: `receiptDriveFileId`, `receiptDriveFileUrl` (movidos a Payment)
  - Dos modos: cuotas pactadas (monto fijo auto-calculado) y pagos libres (monto manual)
  - Modo fijado en el primer pago, no se puede cambiar
  - `isPaid` se activa automáticamente al llegar `remainingBalance` a 0
  - Último pago en modo cuotas absorbe diferencias de redondeo
  - Endpoints: GET/POST `/api/client/invoices/[id]/payments`, DELETE `.../[paymentId]`
  - Endpoint legacy `receipt/route.ts` adaptado para crear Payment (pago total)
  - UI: columna "Recibo" reemplazada por columna "Pago" con estado (Pagada / Resta $X / —)
  - Migración: `20260402000200_add_payment_tracking`
- **Fix UX pagina de consorcios** (04/04/2026)
  - Sidebar unificado: navSidebar + lista de consorcios en columna izquierda unica, botones colapsan a icono
  - Fix render de boletas: filas de invoices ahora se muestran correctamente (layout page flex-direction: row)
  - Fix total periodo: suma correcta de montos Decimal con `Number()` en lugar de concatenacion
  - Badge "LSP" en columna proveedor para boletas con `lspServiceId`
  - Fix toggle de tema: aplica `data-theme` a `document.documentElement` via useEffect
  - CSS migrado a variables CSS (`--bg`, `--text`, `--border`, etc.) para soporte dark/light
  - Fix build: variables CSS movidas a `globals.css` (CSS Modules no permite selectores globales)
- **Refactor layout 3 columnas + modal de configuracion** (04/04/2026)
  - Layout separado en 3 columnas independientes: navSidebar (colapsable) | lista consorcios (fija 220px) | contenido
  - Lista de consorcios ya no se oculta al colapsar el nav
  - Edicion de matchNames movida de inline a modal de configuracion
  - Boton "Configuracion" en detailActions abre el modal
  - Boton "Cerrar sesion" reubicado al fondo del navSidebar con spacer flex
  - En mobile (≤1024px) sidebar de consorcios se oculta (acceso via nav mobile)
  - Nuevas clases CSS: `.sidebar`, `.contentCol`, `.configBtn`, `.configSection`, `.configSectionTitle`, `.configSectionDesc`

---

## En progreso 🔄

- **Configurar self-hosted GitHub Actions runner** en la máquina local para deploy automático

---

## Pendiente ❌

### Alta prioridad
- [ ] Configurar self-hosted runner de GitHub Actions en la máquina local
- [ ] Validar prompts LSP restantes con PDFs reales (Metrogas, Naturgy, Camuzzi, Litoral Gas, Personal)

### Media prioridad
- [ ] UI de gestión de carpetas Drive por cliente desde el panel admin
- [ ] Agregar URL de recibo a columna de Google Sheets
- [ ] Resincronización automática con Sheets cuando Google falla

### Baja prioridad
- [ ] UI para asignar Rubro y Coeficiente a invoices individuales desde el panel (Stage 2)

---

## Próximos pasos sugeridos

1. Configurar self-hosted runner de GitHub Actions
2. Validar prompts LSP restantes (Metrogas, Naturgy, Camuzzi, Litoral Gas, Personal)
3. UI de gestión de carpetas Drive por cliente
4. Agregar URL de recibo a columna de Google Sheets

---

## Problemas conocidos

- En Windows, `npx prisma generate` puede fallar si los 3 procesos están corriendo (el `.dll` queda bloqueado). Parar todo antes de migrar.
- PowerShell no soporta `&&`. Siempre correr comandos por separado.
- Números de calle distintos entre factura y DB (ej: Edesur 708 vs DB 706) no se resuelven automáticamente → registrar alias manualmente.
