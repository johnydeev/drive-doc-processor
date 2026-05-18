# Changelog

## [Unreleased]

### Added
- CI: la imagen de Docker en `ghcr.io/johnydeev/ia-drive-doc-processor` ahora
  se tagea con `:latest` y con `${{ github.sha }}` en cada push a master,
  habilitando rollbacks a versiones anteriores por SHA.
- Feature: reporte de resumen al final de cada ciclo automático del
  scheduler, solo cuando se encontró al menos 1 archivo.
  Muestra encontrados, encolados y ya en cola.
- Feature: resumen de ciclo en worker automático — cuando la cola
  se vacía después de procesar al menos 1 archivo, emite totales
  de procesados, sin asignar, duplicados y fallidos.

## [Unreleased] - 2026-04-15

### Security
- Fix crítico: descifrado legacy ahora prueba ambas claves candidatas (GCEK + SESSION_SECRET)
  con AES-GCM auth-tag check, garantizando lectura de secretos viejos sin importar con cuál
  se cifraron originalmente
- Fix alto: removidos logs sin sanitizar — `pdf-extractor` ya no imprime los primeros 500
  chars del texto, y `extractionResult` redacta CUIT/CUITs/monto en logs normales
- Fix alto: scan rutea correctamente imágenes JPG/PNG a Gemini Vision en vez de pdf-parse
- Fix crítico: /api/process ahora requiere sesión de admin autenticada
- Fix alto: endpoints de escritura usan requireClientSession() — VIEWER no puede mutar datos
- Fix alto: scan (`POST /api/client/consortiums/[id]/invoices/scan`) usa requireClientSession — VIEWER no puede consumir IA/OCR
- Fix medio: límites de tamaño en uploads (Excel 10MB, PDF scan 15MB, receipt 20MB) + validación MIME
- Fix medio: validación de magic bytes en uploads (PDF, PNG, JPG, XLSX/ZIP)
- Fix medio: cifrado versionado v2 en `enc:v2:...`. Nuevos secretos usan exclusivamente
  GOOGLE_CREDENTIALS_ENCRYPTION_KEY; el formato legado `enc:...` sigue legible con SESSION_SECRET
  para compatibilidad. Script de migración: `tsx scripts/rotate-encrypted-secrets.ts [--apply]`
- Fix medio: validación en producción que avisa si falta GOOGLE_CREDENTIALS_ENCRYPTION_KEY
- Fix medio: sanitización (CUITs, importes, emails, CBU) + truncado de logs en debug mode
- Fix bajo: warning en logs cuando debug mode está activo con datos sensibles
- Fix bajo: OpenAPI documenta /api/process como protegido (cookieAuth)

### Fixed
- Fix: `clientNumber` se limpia automáticamente para boletas no-LSP si Gemini alucina un valor (campo reservado exclusivamente para boletas LSP)
- Fix deduplicación: `boletaNumber` distinto → nunca duplicado, independiente de monto y vencimiento. Caso testigo: dos facturas RANKO S.R.L. con números 0003-00154753 y 0003-00155282 se marcaban como duplicado por compartir monto/período.
- Fix: los duplicados no se guardan en DB — solo se registran en Sheets (con `ES_DUPLICADO=YES`) y se mueven a Escaneados.

### Added
- Feature: solapa Pagos en vista de consorcio
  - Tabs Boletas / Pagos en el header del consorcio (reset a "boletas" al cambiar de consorcio)
  - Vista Pagos con tabla inline editable (fecha, importe, medio de pago)
  - Empleados: solo fecha de pago (monto siempre total)
  - Proveedores: fecha + importe editable + medio de pago
  - Botón GUARDAR confirma todos los pagos pendientes en un solo click
  - Al guardar: actualiza `isPaid`/`remainingBalance` en DB y reescribe columna N ("ESTADO PAGO") en Sheets
  - Medios de pago: Transferencia/Cheque propio con banco del consorcio, Descuento, Efectivo
- Migración `20260415000200_payment_optional_drive_add_payment_method`: `Payment.driveFileId`/`driveFileUrl` ahora opcionales, nuevo campo `Payment.paymentMethod` (texto libre)
- `GoogleSheetsService.updatePaymentStatus()`: busca fila por `sourceFileUrl` o `boletaNumber+providerTaxId` y actualiza la columna `paymentStatus`
- Feature: soporte para archivos JPG/PNG en carpeta Pendientes de Drive. El scheduler los detecta y el pipeline los procesa directamente con Gemini Vision sin pasar por pdf-parse ni Tesseract OCR.
  - GoogleDriveService: query mimeType ampliado a image/jpeg e image/png
  - GeminiExtractorService: nuevo método `extractStructuredDataFromImage()`
  - Pipeline: detección `isImage` por mimeType/extensión, rama de procesamiento visual
  - ProcessDriveFileInput: nuevo campo `mimeType` opcional
- Feature: soporte para empleados de consorcio como tipo de proveedor
  - Nuevo enum `ProviderType` (PROVEEDOR / EMPLEADO) en tabla Provider
  - Sync-directory lee columna TIPO de hoja `_Proveedores` (5ta columna)
  - Nuevo prompt `buildReciboHaberesPrompt` para recibos de haberes
  - Router `isReciboHaberes()` detecta recibos por keywords antes del router LSP
  - UI: badge `[EMPLEADO]` en select de proveedores, etiqueta CUIL/CUIT según tipo
  - `amount` extrae NETO A COBRAR en recibos de haberes
  - Migración: `20260415000100_add_provider_type`

---

## [Unreleased] - 2026-04-14

### Added
- Feature: fallback visual con Gemini Vision para facturas donde el CUIT del emisor está en imagen. Se activa SOLO como último recurso cuando el proveedor no fue encontrado por CUIT ni nombre y hasEmitterBlock=false.

---

## [Unreleased] - 2026-04-09

### Added
- Feature: toggle "Modo Debug" por cliente en panel admin. Activa logs detallados de OCR e IA en el pipeline para diagnóstico
- Script `export-logs.ps1` para exportar logs de Docker a archivos locales con fecha
- Configuración de rotación de logs en docker-compose.yml (json-file, 50MB x 10)
- Lock de archivo vía carpeta "Procesando" en Drive: tras descargar, el pipeline mueve el archivo a la carpeta `processing` configurada en `driveFoldersJson.processing` (opcional). Si otro ciclo concurrente escanea Pendientes no lo vuelve a tomar. Los movimientos finales (Escaneados / Sin Asignar / Fallidos) usan Procesando como origen cuando el lock está activo.

### Fixed
- Fix buildInvoicePrompt: regla consortium reforzada para evitar confusión emisor/receptor en facturas donde ambos bloques tienen etiquetas similares
- Fix sync-directory: providerId se resuelve automáticamente al sincronizar LspServices (campo providerName texto se mantiene, providerId es complementario)
- Rename `LspService.provider` → `providerName` (claridad vs providerId FK)
- Fix LSP lookup: mapa router→canonicalName resuelve mismatch PERSONAL/TELECOM ARGENTINA S.A.
- Fix LSP fast path: providerId y providerTaxId ahora se asignan correctamente en Invoices de boletas LSP
- Fix race condition entre ciclos concurrentes (manual + scheduler) que causaba doble procesamiento del mismo archivo
- Fix sync-directory: timeout de transacción Prisma aumentado a 120s para evitar expiración con lotes grandes de proveedores/consorcios

### Changed
- Fix clientNumber LSP: normalización extendida elimina espacios internos antes del lookup (resuelve lspServiceId NULL en facturas Edenor y similares)
- Boletas LSP con clientNumber no registrado en LspService ahora van a Sin Asignar en lugar de procesarse sin vínculo
- Rename `Consortium.banco` → `bank`, `claveSuterh` → `suterhKey` (convención camelCase inglés)

---

## [Unreleased] - 2026-04-07

### Added
- Columna "ESTADO PAGO" en Google Sheets (columna N), valor inicial "Sin pagar" al insertar boleta
- Campos `banco` y `claveSuterh` en modelo Consortium
- Columna "BANCO" en Google Sheets (columna O)

---

## [Unreleased] - 2026-04-04

### Changed
- Layout refactorizado a 3 columnas independientes: navSidebar | lista consorcios | contenido
- Edicion de matchNames movida a modal de configuracion (boton "Configuracion" en detailActions)
- Boton "Cerrar sesion" reubicado al fondo del navSidebar con spacer flex

### Fixed
- Sidebar de navegacion y lista de consorcios unificados en columna izquierda unica
- Boletas del periodo ahora se renderizan correctamente en la tabla
- Monto total del periodo corregido (suma en lugar de concatenacion de Decimals)
- Boletas LSP integradas en tabla principal con badge identificador
- Toggle dark/light ahora aplica el tema correctamente al documento
- Fix build CSS Modules: variables de tema movidas a globals.css

---

## [Unreleased] - 2026-04-02

### Added
- Sistema de pagos parciales: tabla `Payment` con soporte para cuotas pactadas y pagos libres
- Campos `isPaid` y `remainingBalance` en Invoice
- Endpoints GET/POST `/api/client/invoices/[id]/payments` y DELETE `.../[paymentId]`

### Removed
- Campos `receiptDriveFileId` y `receiptDriveFileUrl` de Invoice (reemplazados por `Payment.driveFileId`/`driveFileUrl`)

---

## 2026-04-02

Highlights
- **Tunnel estabilizado**: versión fija 2025.2.0, --no-autoupdate, --url http://web:3000.
- **Zona horaria corregida**: logs ahora muestran hora UTC-3 Buenos Aires.
- **Mejoras de logging**: separadores visuales entre archivos, ciclos del scheduler y jobs del worker. Log de archivos encontrados vs límite de lote.
- **Fix scheduler requeue**: jobs COMPLETED/FAILED no bloquean reprocesamiento. Filtro status: { in: ["PENDING", "PROCESSING"] } en existingJob.
- **Feature Reprocesar Sin Asignar**: botón ♻️ en sidebar del panel cliente. Endpoints GET /api/client/unassigned/preview y POST /api/client/unassigned/requeue.
- **OCR híbrido**: detección semántica del bloque emisor AFIP + pdftoppm/Tesseract para PDFs con imagen. Reemplazado pdfjs-dist por pdftoppm. poppler-utils en Dockerfile.
- **CUITs alternativos de consorcio**: pipeline verifica CUITs en matchNames. Permite múltiples CUITs por consorcio sin cambios de schema.
- **Sync-directory optimizado**: upsert de Proveedores con constraint único @@unique([clientId, canonicalName]). Logs de timing por etapa. Migración: 20260402000100_provider_unique_client_canonical.

## 2026-03-30

Highlights
- **UI de edición de matchNames por consorcio**: nuevo campo editable en la vista de detalle para configurar nombres alternativos de matching interno. Endpoint `PATCH /api/client/consortiums/[id]` con soporte para `matchNames`.
- **UI de gestión de LspServices por consorcio**: nueva sección "Servicios públicos (LSP)" con tabla de servicios existentes, formulario inline para agregar (dropdown de 8 proveedores, nro. cliente normalizado, descripción), y eliminación con confirmación inline. Endpoints `GET/POST /api/client/consortiums/[id]/lsp-services` y `DELETE .../[lspId]`.
- **Mejora extracción allTaxIds**: DNI con 11 dígitos ahora se incluye en allTaxIds como CUIT mal etiquetado. Ingresos Brutos agregado como señal del CUIT del emisor. CAE y comprobante explícitamente excluidos. Formato normalizado con guiones.
- **Mejora buildInvoicePrompt**: descripción estructural del layout AFIP para distinguir bloque emisor vs receptor. providerTaxId puede ser null sin romper el CUIT-first matching.
- **Fix scheduler requeue**: el scheduler ahora ignora jobs COMPLETED/FAILED al decidir si encolar un archivo. Permite reprocesar archivos que volvieron a Pendientes desde Sin Asignar u otros flujos.
- **Mejora OCR fallback**: el extractor de texto ahora activa Tesseract OCR cuando pdf-parse produce texto sin CUITs detectables, no solo cuando está vacío. Los textos de pdf-parse y OCR se combinan para maximizar la información disponible para la IA.
- **Feature Reprocesar Sin Asignar**: botón "♻️ Sin Asignar" en sidebar del panel cliente. Lista archivos en carpeta Sin Asignar y los mueve a Pendientes con un click. El scheduler los procesa en el próximo ciclo automáticamente. Endpoints: `GET /api/client/unassigned/preview`, `POST /api/client/unassigned/requeue`.

## 2026-03-28

Highlights
- **Manual de usuario creado** (`docs/manual-usuario.md`): documentación completa para usuarios finales no técnicos. Cubre acceso al sistema, panel principal, configuración inicial, archivo ALTA (con ejemplos de tablas para cada hoja), sincronización de directorio, procesamiento automático de boletas, resolución de boletas sin asignar, cierre de período, recibos de pago, y avisos importantes.

## 2026-03-27 (sesión 20)

Highlights
- **Intervalo del scheduler configurable por cliente (`intervalMinutes`)**: nuevo campo en Client con default 60 minutos. Configurable desde el panel admin (1-1440 min). El scheduler respeta el intervalo individual de cada cliente sin necesidad de tocar `.env` ni hacer rebuild. Migración: `20260327000200_add_interval_minutes`.

## 2026-03-27 (sesión 19)

Highlights
- **Boletas sin asignar ya no se guardan en DB**: el bloque `assignment.unassigned` del pipeline ahora solo mueve el archivo a Sin Asignar en Drive, sin crear Invoice en la DB ni persistir el hash. La DB queda limpia con solo boletas efectivamente asignadas.

## 2026-03-27 (sesión 18)

Highlights
- **Sync-directory refactorizado**: transacción única dividida en 5 transacciones independientes por entidad (Rubros, Coeficientes, Consorcios+Períodos, Proveedores, LspServices). Cada una con timeout de 30s. Resuelve "Transaction not found" con datasets grandes.

## 2026-03-27 (sesión 16)

Highlights
- **Prompt facturas normales**: aclaración sobre trampa CUIT emisor vs receptor en facturas B/C donde el CUIT del receptor tiene etiqueta prominente y el del emisor está en el encabezado sin etiqueta explícita.

## 2026-03-27 (sesión 15)

Highlights
- **LSP_LATERAL_CUIT_RULES**: nueva constante compartida para indicar a la IA que el CUIT aparece en el margen lateral izquierdo rotado/vertical. Incluida en prompts de Edesur y Edenor.

## 2026-03-27 (sesión 14)

Highlights
- **Prompt Edesur**: aclaración sobre ubicación del CUIT en margen lateral izquierdo (rotado/vertical) para mejorar extracción IA.

## 2026-03-27 (sesión 13)

Highlights
- **Proveedor LSP resuelto por CUIT desde tabla Provider**: eliminados CUITs hardcodeados de todos los prompts LSP. El pipeline busca el proveedor por CUIT en `allTaxIds` contra la tabla Provider y usa el nombre canónico de la DB. LspService ahora tiene `providerId` FK a Provider. Lookup de LspService: primero por providerId, luego fallback a campo texto. Si el proveedor no está en DB → fallback al nombre del router + warning.
- **Migración pendiente**: `20260327000100_lspservice_add_provider_fk` — agregar `providerId` FK nullable a LspService.
- **Sync-directory mejorado**: resuelve `providerId` al sincronizar `_LspServices` buscando por nombre canónico en Provider.

## 2026-03-26 (sesión 12)

Highlights
- **Normalización de clientNumber para LspService**: el pipeline ahora normaliza `clientNumber` eliminando ceros a la izquierda antes del lookup de LspService (`00366037` → `366037`). Sync-directory también normaliza al guardar desde Sheets.

## 2026-03-26 (sesión 11)

Highlights
- **CUIT como identificador primario en matching**: nuevo campo `allTaxIds` en la extracción IA — la IA extrae todos los CUITs del documento sin clasificarlos. El pipeline ahora busca por CUIT primero en consorcio y proveedor antes de caer al matching por nombre. Excluye automáticamente el CUIT del consorcio al buscar proveedor. Backward-compatible con extracciones viejas.
- **Logger mejorado**: `extractionResult` muestra los CUITs extraídos. Nuevos métodos `consortiumMatchedByCuit` y `providerMatchedByCuit`.

## 2026-03-26 (sesión 10)

Highlights
- **Razón social en nombre de proveedor**: nueva constante `PROVIDER_NAME_RULES` que instruye a la IA a conservar la razón social (S.R.L., S.A., S.A.S., etc.) en el campo `provider`. Incluida en los 7 prompts de extracción. Sin cambios en matching ni normalización.

## 2026-03-26 (sesión 9)

Highlights
- **Validación en producción**: Deploy Docker completo funcionando (Docker Desktop + Cloudflare Tunnel + dominio propio). Los 3 servicios (web, scheduler, worker) operativos.
- **Prompts LSP validados**: Edesur y AySA probados con PDFs reales en producción. Extracción correcta.
- **Aclaración de flujo matchNames**: los matchNames de consorcios y proveedores se cargan y editan desde las hojas `_Consorcios` y `_Proveedores` del archivo ALTA en Google Sheets, y se sincronizan a la DB desde el panel. No requiere UI adicional.
- **Procedimiento de deploy documentado**: deploy estándar con `docker compose up --build -d` y procedimiento completo para migraciones de DB (down → migrate deploy → generate → up --build -d).
- **Límite de PDFs por lote (batchSize)**: nuevo campo `batchSize` en Client (default 10). Scheduler limita PDFs encolados por ciclo. Configurable desde el panel admin (campo "Tamaño de lote" en edición de cliente).
- **Registro de tokens por factura**: nuevos campos en Invoice (`tokensInput`, `tokensOutput`, `tokensTotal`, `aiProvider`, `aiModel`). Pipeline guarda tokens consumidos por cada extracción IA.
- **Página admin Invoices**: nueva ruta `/admin/invoices` (solo ADMIN) con tabla paginada de todas las invoices, filtro por cliente, y columnas de tokens/IA. Endpoint `GET /api/admin/invoices`.
- Migración: `20260326000100_add_batch_size_and_invoice_tokens`.

## 2026-03-24 (sesión 8)

Highlights
- **Purga completa de boletas por cliente (Admin)**: botón "Purgar" en la tabla de métricas del panel admin con modal de 3 pasos (preview → confirmación → resultado).
- **Endpoint GET /api/admin/clients/[id]/purge**: preview que retorna cantidad de boletas del cliente.
- **Endpoint DELETE /api/admin/clients/[id]/purge**: ejecuta purga completa — mueve archivos de Drive a pendientes, limpia Sheets (fila 2+), borra Invoices y ProcessingJobs de DB.
- **Tolerancia a fallos**: si Drive o Sheets fallan, loguea warning y continúa. El borrado de DB se ejecuta siempre.
- **Tracking de tokens con desglose input/output por provider y modelo**: `TokenUsageSummary.byProvider` y `byModel` ahora son `Record<string, TokenUsageBreakdown>` con `inputTokens`, `outputTokens`, `totalTokens`. Persistencia, carga y UI actualizados. Compatible hacia atrás con registros viejos (ceros se suman como 0).

## 2026-03-24 (sesión 7)

Highlights
- **Sidebar colapsable + menú hamburguesa**: panel cliente con sidebar de navegación global (Sincronizar directorio, Consorcios, Cerrar Periodo General, Cerrar sesión). Colapsable en desktop (solo iconos), menú hamburguesa en tablet/mobile.
- **Toggle dark/light con iconos**: reemplazado el botón de texto por switch tipo interruptor con iconos sol/luna. Estado solo de sesión (no persiste).
- **Toolbar superior**: Pausar scheduler / Ejecutar ahora a la izquierda, toggle de tema a la derecha.
- **Cerrar Periodo General**: botón solo visible para rol CLIENT. Modal de 2 pasos: preview con lista de consorcios a cerrar/saltear, luego resultado.
- **Endpoints nuevos**: `GET /api/client/periods/close-all/preview` y `POST /api/client/periods/close-all` con lógica de mes mayoritario.
- **Período por defecto mejorado**: al crear consorcio (manual, import Excel, sync-directory) usa el mes mayoritario entre los períodos activos existentes del cliente.
- **Sync-directory crea períodos**: los consorcios nuevos creados via archivo ALTA ahora reciben período activo automáticamente.

## 2026-03-23 (sesión 6)

Highlights
- **Asignación automática de período a invoices**: el pipeline ahora busca el período ACTIVE del consorcio matcheado y asigna `periodId` al Invoice en DB.
- **Nueva columna `period` en Google Sheets**: formato `MM/YYYY` en posición M (columna nueva al final, sin mover las existentes).
- **Invoices manuales**: también incluyen el período en Sheets al ser creados desde la UI.

## 2026-03-23 (sesión 5)

Highlights
- **Nuevo campo `consortiumsEnabled`**: booleano en Client (default false) para habilitar/deshabilitar la feature de consorcios por cliente.
- **Toggle Premium en panel admin**: columna "Premium" con toggle ON/OFF optimista en la tabla de métricas por cliente. Reemplaza la columna ClientId.
- **Botón Consorcios condicionado**: en el panel CLIENT, el botón "Consorcios" se deshabilita con badge "Premium" si `consortiumsEnabled` es false.
- **Guard en página Consorcios**: la página `/admin/consortiums` verifica `consortiumsEnabled` via `/api/auth/me` y redirige al panel si no está habilitado.
- **Endpoint `/api/auth/me` ampliado**: ahora retorna `consortiumsEnabled` en el user.
- **Endpoint `/api/admin/clients/[id]` ampliado**: GET retorna y PATCH acepta `consortiumsEnabled`.
- **Endpoint `/api/admin/audit/clients` ampliado**: retorna `consortiumsEnabled` por cliente.
- Migración: `20260323000300_add_consortiums_enabled`.

## 2026-03-23 (sesión 4)

Highlights
- **Nuevo modelo LspService**: tabla para registrar servicios de empresas públicas por consorcio (provider + clientNumber + description). Permite lookup automático en el pipeline.
- **Nuevo enum PaymentMethod**: DEBITO_AUTOMATICO, TRANSFERENCIA, EFECTIVO. Campo nullable en Invoice.
- **Campos lspServiceId y paymentMethod en Invoice**: FK nullable a LspService y método de pago detectado por IA.
- **Prompts LSP actualizados**: todos los prompts LSP ahora extraen `clientNumber` y `paymentMethod` con reglas específicas por empresa.
- **Nuevo prompt buildPersonalPrompt**: soporte para facturas de Personal/Telecom Argentina (CUIT 30-63945373-8, keywords PERSONAL/TELECOM en router).
- **Extracción limitada a página 1 para LSP**: reduce ruido en la extracción IA re-extrayendo solo la primera página cuando se detecta un documento LSP.
- **Lookup LspService en pipeline**: después de extraer clientNumber, busca en la tabla LspService para vincular la factura al servicio correspondiente.
- **Nueva columna NRO CLIENTE en Sheets**: columna J con el número de cliente extraído. Las columnas URL_ARCHIVO e ES_DUPLICADO se desplazaron a K y L.
- **Hoja _LspServices en archivo ALTA**: nueva hoja con 4 columnas (NOMBRE CANÓNICO, PROVEEDOR, NRO CLIENTE, DESCRIPCIÓN) sincronizada con reemplazo total.
- **Eliminación de isAutoCreated**: campo removido de Provider y Consortium (ya no existía en el schema actual).
- Migración: `20260323000200_add_lspservice_paymentmethod`.

## 2026-03-23 (sesión 3)

Highlights
- **Auditoría completa pre-producción Docker**: revisión de dependencias, build, variables de entorno, migraciones y Docker setup.
- **Optimización docker-compose**: eliminado triple build redundante. Solo `web` tiene `build:`, los 3 servicios comparten `image: drive-doc-processor:latest`.
- **`.env.example` mejorado**: agregada `GOOGLE_CREDENTIALS_ENCRYPTION_KEY`, comentarios descriptivos, variables agrupadas por categoría.
- **Smoke test del pipeline**: verificación completa de los 10 pasos del pipeline, router LSP, normalización de consorcios, sync-directory. Todo coincide con la documentación.
- **Resultados de auditoría**: TypeScript 0 errores, ESLint 0 errores (8 warnings menores), `build:jobs` OK, 14 migraciones aplicadas (schema up to date).
- **README.md creado** para GitHub con descripción del proyecto, arquitectura, setup Docker, y desarrollo local.
- **Renombrado `alias`/`aliases` → `matchNames` + nuevo campo `paymentAlias`** en Provider y Consortium.
  - `matchNames`: campo interno para matching de PDFs (separado por `|`), no visible en UI.
  - `paymentAlias`: alias visible en UI y en columna "ALIAS" de Google Sheets.
  - Pipeline: columna ALIAS de Sheets ahora escribe `provider.paymentAlias` (vacío si no tiene).
  - Sync ALTA: hojas ampliadas a 4 columnas (NOMBRE CANÓNICO, CUIT, NOMBRES ALTERNATIVOS, ALIAS).
  - Import Excel: nueva columna "Alias de pago" en ambas hojas.
  - Migración: `20260323000100_rename_alias_to_matchnames_add_paymentalias`.

## 2026-03-21 (sesión 2)

Highlights
- **Dockerización completa**: Dockerfile multi-stage con Next.js standalone output, 3 servicios separados (web, scheduler, worker).
- **docker-compose.yml** reescrito: web con healthcheck, scheduler y worker como servicios independientes, Cloudflare Tunnel integrado.
- **Path aliases resueltos**: `tsc-alias` como post-procesador para que `dist/` use paths relativos en vez de `@/`.
- **tsconfig.jobs.json** arreglado: excluye `useAuthGuard.ts` (DOM) y shim para `CanvasRenderingContext2D`.
- **ESLint** configurado con `typescript-eslint` + `@next/eslint-plugin-next`. 0 errores, 8 warnings.
- **GitHub Actions CI/CD**: workflow con 3 jobs (check → build → deploy a self-hosted runner).
- **Scripts nuevos**: `build:jobs`, `lint`, `typecheck`, `check` (pipeline completo pre-deploy).
- **Fixes de build**: encoding UTF-8 en `close-period/route.ts`, async params en `receipt/route.ts`, creado `clientAuth.ts` faltante, type cast en `scan/route.ts`.

## 2026-03-21

Highlights
- Refactorización completa de `extraction.ts`: nuevo router `identifyLSPProvider()` que detecta la empresa de servicios y despacha a un prompt específico.
- Prompts dedicados para: Edesur (`buildEdesurPrompt`), Edenor (`buildEdenorPrompt`), AySA (`buildAysaPrompt`), Metrogas/Naturgy/Camuzzi/Litoral Gas (`buildGasPrompt`), y genérico LSP (`buildGenericUtilityBillPrompt`).
- CUIT de cada empresa hardcodeado en su prompt → resuelve confusión entre CUIT del proveedor y del consorcio.
- Reglas de dueDate específicas por empresa → resuelve extracción errónea de fecha CESP/CAE como fecha de pago.
- Reglas de dirección unificadas en `CONSORTIUM_ADDRESS_RULES` con instrucciones de limpiar ceros, sufijos, CP, piso.
- `consortiumNormalizer.ts` mejorado: nuevas funciones `stripLeadingZeros`, `stripTrailingNumericSuffix`, `stripPostalAndLocality`, `stripFloorUnit`.
- Fuzzy match ahora limpia ceros a la izquierda en ambos lados antes de comparar tokens.
- Alias match soporta fuzzy inverso (OCR → alias además de alias → OCR).
- Nuevas abreviaturas de calles: SGTO→SARGENTO, CTE→COMANDANTE, INT→INTENDENTE, PROF→PROFESOR.
- Nuevo módulo `src/lib/logger.ts` — sistema de logging centralizado con timestamps, emojis, separadores visuales y logs estructurados por proceso (scheduler, worker, pipeline, run-cycle).
- Scheduler ahora muestra: inicio de ciclo con cantidad de clientes, estado por cliente (pausado/escaneando/sin PDFs/jobs encolados), fin de ciclo, y errores detallados.
- Worker ahora muestra: job reclamado con nombre de archivo y cliente, duración del job, reintentos y fallas permanentes.
- Pipeline ahora muestra: cada paso del procesamiento (descarga, hash, extracción IA, matching, canonización, destino), tipo de LSP detectado, resultado de cada match (método + nombre canónico), y resumen del lote.
- Establecida regla obligatoria de documentación: `docs/progreso.md`, `docs/decisiones.md` y `CHANGELOG.md` deben actualizarse con cada cambio significativo.
- Actualizado CLAUDE.md con sección de router LSP, tabla de prompts por empresa, y regla de documentación.
- Inicializado `docs/decisiones.md` con las primeras decisiones técnicas documentadas.
- Actualizado `docs/progreso.md` al estado actual.

## 2026-03-20

Highlights
- Implementada feature de sincronización de directorio desde archivo Google Sheets ALTA (Sheets → DB).
- Nuevo endpoint `POST /api/client/sync-directory`: lee 4 hojas del archivo ALTA y upserta Consorcios, Proveedores, Rubros y Coeficientes en DB.
- Auto-creación de hojas `_Consorcios`, `_Proveedores`, `_Rubros`, `_Coeficientes` con encabezados si no existen.
- Tablas Rubro y Coeficiente movidas a nivel cliente (no por consorcio).
- Nuevo campo `lastDirectorySyncAt` en `SchedulerState` para registrar la última sincronización.
- Nuevo campo `altaSheetsId` en `googleConfigJson` del cliente para apuntar al archivo ALTA separado.
- UI: botón "Sincronizar directorio" en el panel admin (solo rol CLIENT).
- UI: badge "Última sync directorio" en card de estado del panel.
- UI: botón "Editar" por cliente en tabla de métricas → nueva página `/admin/clients/[id]`.
- Nueva página de edición de configuración de cliente (`/admin/clients/[id]`) con secciones: General, Sheets, Drive, Credenciales Google, Claves IA.
- Nuevo endpoint `GET /PATCH /api/admin/clients/[id]` — campos sensibles enmascarados en GET, encriptados en PATCH.
- CRUD endpoints para Rubros (`/api/client/rubros`) y Coeficientes (`/api/client/coeficientes`).
- Comando `npm run local` como atajo para levantar los 3 procesos con PowerShell.
- Migración `20260320000100_rubro_coeficiente_to_client_level` (pendiente de aplicar).
- Resuelto bug: private key encriptada pasada directamente a GoogleSheetsService → usar siempre `resolveGoogleConfig(client)`.

## 2026-03-16

Highlights
- Added ProcessingJob queue with dedicated worker/scheduler split and env loading helpers.
- Added consortium/provider/period models with normalization, auto-period creation and client endpoints.
- Updated docs/scripts for local run and docker workflow.

PRs
- https://github.com/johnydeev/drive-doc-processor/commit/101fac2553d13c431fcb671d2986a2a358e48991
- https://github.com/johnydeev/drive-doc-processor/commit/6f9359fd15c858bc5be9e8939fcd665d77ed2acf
- https://github.com/johnydeev/drive-doc-processor/commit/73f88a42944cc6eff18b1535a3ea2f64c331c87d

## 2026-03-12

Highlights
- Added VIEWER role to ClientRole and updated related admin/scheduler logic.
- Updated PDF parsing method in PdfTextExtractorService.
- Removed unused Invoice model fields and adjusted business key/repository logic.

PRs
- https://github.com/johnydeev/drive-doc-processor/commit/abf01f8
- https://github.com/johnydeev/drive-doc-processor/commit/17a3b0d
- https://github.com/johnydeev/drive-doc-processor/commit/b44534b
