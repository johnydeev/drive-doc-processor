# Decisiones técnicas — drive-doc-processor

Registro de decisiones tomadas ante problemas reales encontrados en producción.

---

## 2026-04-02 — OCR migrado de pdfjs-dist a pdftoppm

### Problema
El servicio OCR usaba `pdfjs-dist` + `@napi-rs/canvas` para renderizar páginas de PDF a imagen y luego pasarlas a Tesseract. Esto requería dependencias nativas pesadas (`@napi-rs/canvas`) y era frágil en el container Docker.

### Decisión
Reescribir `ocr.service.ts` para usar `pdftoppm` (del paquete `poppler-utils`) en lugar de `pdfjs-dist`. pdftoppm convierte el PDF a imágenes PNG en disco (200 DPI), y luego Tesseract las procesa. Se eliminaron los imports de `pdfjs-dist` y `@napi-rs/canvas`.

Además, la llamada al OCR desde `pdfTextExtractor.service.ts` se envolvió en try/catch para que si OCR falla, el pipeline continúe con el texto de pdf-parse.

### Impacto
- Reescrito: `src/services/ocr.service.ts`
- Modificado: `src/services/pdfTextExtractor.service.ts` (try/catch)
- Modificado: `Dockerfile` (agregado `poppler-utils`)

---

## 2026-04-02 — Upsert de Proveedores en sync-directory con constraint único

### Problema
El loop de upsert de proveedores en sync-directory usaba `findFirst` + `update`/`create` — 2 queries por proveedor, lo que generaba overhead innecesario en la transacción.

### Decisión
Agregar `@@unique([clientId, canonicalName])` a Provider y usar `upsert` directo de Prisma con el compound key. Reduce a 1 query por proveedor.

### Alternativas descartadas
Mantener `findFirst` + `update`/`create` para evitar migración. Se descartó porque el `upsert` es más performante y el constraint único es correcto semánticamente (no debería haber 2 proveedores con el mismo nombre canónico por cliente).

### Impacto
- Modificado: `prisma/schema.prisma` (nuevo `@@unique`)
- Modificado: `src/app/api/client/sync-directory/route.ts` (upsert)
- Migración: `20260402000100_provider_unique_client_canonical`

---

## 2026-03-30 — Mejora fallback OCR para PDFs con bloques en imagen

### Problema
PDFs como Ikarus Seguridad tienen el bloque del emisor (nombre, CUIT) renderizado
como imagen dentro del PDF. pdf-parse extrae el texto del cuerpo pero omite la
imagen. El resultado no está vacío, por lo que el fallback a Tesseract no se
activaba. La IA recibía texto sin CUIT del emisor y extraía proveedor=null.

### Decisión
Cambiar el umbral de activación del OCR en PdfTextExtractorService:
- Antes: activar solo si directText.length === 0
- Ahora: activar si directText < 100 chars O si no contiene secuencia de 10+
  dígitos consecutivos (indicador de ausencia de CUIT/CAE en el texto)
Cuando OCR produce más texto que pdf-parse, combinar ambos con separador
`--- OCR ---` para que la IA tenga toda la información disponible.

### Impacto
- Modificado: `src/services/pdfTextExtractor.service.ts`
- Sin cambios en pipeline, schema ni prompts
- Mejora automática para cualquier PDF con bloques en imagen, no solo Ikarus

---

## 2026-03-30 — Fix: scheduler no reprocesaba archivos con job COMPLETED/FAILED

### Problema
El scheduler chequeaba existingJob sin filtrar por status. Archivos que volvían a Pendientes (ej: via requeue desde Sin Asignar) eran salteados si tenían un ProcessingJob previo en cualquier estado, incluyendo COMPLETED y FAILED.

### Decisión
Agregar `status: { in: ["PENDING", "PROCESSING"] }` al findFirst de existingJob en scheduler.ts. Solo se saltea si hay un job activo en curso. Jobs terminados (COMPLETED/FAILED) no bloquean el reprocesamiento. El check de existingInvoice sigue siendo el guard principal contra duplicados reales.

### Impacto
- Modificado: `src/jobs/scheduler.ts`
- Sin cambios en schema ni migraciones

---

## 2026-03-30 — Feature: Reprocesar Sin Asignar desde el panel (Opción C)

### Problema
Los archivos que van a Sin Asignar (proveedor no encontrado en DB) quedaban bloqueados hasta que el usuario los movía manualmente en Drive a Pendientes. No había forma de reencolarlos desde el panel.

### Decisión
- Endpoint GET /api/client/unassigned/preview: lista PDFs en carpeta Sin Asignar.
- Endpoint POST /api/client/unassigned/requeue: mueve archivos de Sin Asignar a Pendientes usando moveFileToFolder de GoogleDriveService. Tolerancia a fallos por archivo.
- El scheduler detecta los archivos en Pendientes en el próximo ciclo y los encola como ProcessingJob normalmente — reutiliza toda la infraestructura existente.
- No hay race condition: el check existingJob del scheduler previene duplicados.
- No hay timeout HTTP: el endpoint solo mueve archivos (operación liviana).
- UI: botón en sidebar, modal de 2 pasos (preview con lista → resultado con conteo).

### Alternativas descartadas
- Opción A (mover + procesar sincrónicamente): timeout HTTP con muchos archivos.
- Opción B (procesar directo desde Sin Asignar): requería cambios en el pipeline y tenía el mismo problema de timeout HTTP.

### Impacto
- Nuevos: `src/app/api/client/unassigned/preview/route.ts`, `src/app/api/client/unassigned/requeue/route.ts`
- Modificado: `src/app/admin/consortiums/page.tsx` (botón sidebar + modal)
- Sin cambios en schema, migraciones ni pipeline

---

## 2026-03-30 — Mejora de extracción allTaxIds y providerTaxId en facturas normales

### Problema
Tres casos reales mostraron fallas en la extracción de CUITs: (1) BSS con dos labels C.U.I.T. en el mismo documento, (2) Ferretería Serrano con el consorcio bajo label `DNI: 30714787256` (11 dígitos = CUIT) que el prompt anterior excluía, (3) Ikarus Seguridad con el CUIT del emisor en imagen no copiable. En todos los casos allTaxIds no capturaba los CUITs suficientes para el CUIT-first matching del pipeline.

### Decisión
Mejorar ALL_TAX_IDS_RULES: incluir valores bajo label `DNI:` si tienen exactamente 11 dígitos (CUIT mal etiquetado), excluir si tienen menos (DNI real). Agregar Ingresos Brutos como señal del CUIT del emisor. Excluir explícitamente CAE (14 dígitos) y número de comprobante. Mejorar buildInvoicePrompt con descripción estructural del layout AFIP estándar para que la IA distinga bloque emisor de bloque receptor y sepa que providerTaxId puede ser null sin romper el matching.

### Alternativas descartadas
- Validar el dígito verificador del CUIT en el prompt: demasiado complejo para instrucción de IA, mejor hacerlo en el pipeline si fuera necesario.
- Modificar el pipeline para intentar parsing de DNI: innecesario, la solución en el prompt es más limpia.

### Impacto
- Modificado: `src/lib/extraction.ts` (ALL_TAX_IDS_RULES + buildInvoicePrompt)
- Sin cambios en pipeline, schema ni migraciones

---

## 2026-03-30 — LspServices: delete + create en lugar de PUT/PATCH

### Problema
Se necesitaba un CRUD de LspServices por consorcio en la UI. ¿Implementar edición (PUT/PATCH) o solo crear y eliminar?

### Decisión
No se implementa endpoint de edición (PUT/PATCH). Con delete + create es suficiente dado que LspService tiene solo 3 campos editables (provider, clientNumber, description) y el unique constraint es sobre `(consortiumId, provider, clientNumber)`, que son los campos clave. Editar implica cambiar la identidad del registro. Es más simple y menos propenso a errores eliminar y recrear.

### Alternativas descartadas
- **PUT/PATCH endpoint**: agrega complejidad innecesaria. Si se cambia provider o clientNumber hay que validar el nuevo unique constraint y manejar el caso de que el nuevo combo ya exista, que es lo mismo que crear uno nuevo.

### Impacto
- Menos código de backend (un endpoint menos)
- UI más simple (no requiere modal de edición, solo tabla + formulario inline + botón eliminar)

---

## 2026-03-30 — matchNames y LspServices integrados en vista de detalle de consorcio

### Problema
¿Dónde ubicar la edición de matchNames y la gestión de LspServices en la UI?

### Decisión
Ambas features se integran directamente en la vista de detalle del consorcio seleccionado (`page.tsx`), entre el header y la navegación de períodos. No se crean modales ni páginas separadas. matchNames usa un campo inline con toggle editar/ver. LspServices usa una tabla + formulario inline dentro de una sección colapsada visualmente.

### Alternativas descartadas
- **Modal separado para cada feature**: agrega más estado y complejidad modal (ya hay 5+ modales en la página).
- **Página dedicada `/admin/consortiums/[id]/settings`**: overengineering para 2 campos simples.

### Impacto
- Archivos modificados: `page.tsx`, `page.module.css`, `consortiums/[id]/route.ts` (PATCH), nuevos `lsp-services/route.ts` y `lsp-services/[lspId]/route.ts`

---

## 2026-03-27 — Intervalo del scheduler configurable por cliente

### Problema
El intervalo del scheduler era global (`PROCESS_INTERVAL_MINUTES` en `.env`), igual para todos los clientes. Cambiar el intervalo requería modificar el `.env` y hacer rebuild del contenedor, afectando a todos los clientes por igual.

### Decisión
Nuevo campo `intervalMinutes` (Int, default 60) en el modelo Client. El scheduler mantiene un `Map<clientId, lastRunTimestamp>` y antes de procesar cada cliente verifica si pasó su intervalo individual. El `setInterval` global sigue usando el valor del `.env` como tick base (frecuencia mínima de chequeo). Si `client.intervalMinutes` es 0 o no está definido, se usa el fallback global.

### Alternativas descartadas
- **Un scheduler independiente por cliente**: excesiva complejidad, múltiples timers, difícil de monitorear.
- **Cron expressions por cliente**: overengineering para un caso simple de intervalo en minutos.

### Impacto
- Migración: `20260327000200_add_interval_minutes`
- Archivos modificados: `schema.prisma`, `client.types.ts`, `client.repository.ts`, `scheduler.ts`, `jobWorkerMain.ts`, `admin/clients/[id]/route.ts`, `admin/clients/[id]/page.tsx`, `receipt/route.ts`, `invoices/route.ts`, `scan/route.ts`

---

## 2026-03-27 — Boletas sin asignar no se guardan en DB

### Problema
El pipeline guardaba un Invoice en la DB incluso cuando la boleta iba a "Sin Asignar" (sin consorcio o proveedor matcheado). Esto contaminaba la DB con registros incompletos que no tenían consorcio/proveedor asignado y complicaba las métricas y la purga.

### Decisión
Eliminar el paso `saveProcessedInvoice` del bloque `assignment.unassigned`. El archivo se sigue moviendo a la carpeta Sin Asignar en Drive, pero no se crea Invoice en la DB. El hash tampoco se persiste, por lo que si el usuario corrige el directorio y vuelve a procesar el mismo PDF, pasará como nuevo.

### Alternativas descartadas
- Guardar con un status especial (UNASSIGNED): agrega complejidad al schema y a las queries sin beneficio claro.

### Impacto
- Modificado: `src/jobs/processPendingDocuments.job.ts` (bloque unassigned)

---

## 2026-03-27 — Sync-directory: transacción única dividida en 5 por entidad

### Problema
La sincronización de directorio ALTA usaba una sola transacción Prisma para procesar todas las entidades (Rubros, Coeficientes, Consorcios, Proveedores, LspServices). Con muchos registros, la transacción excedía el timeout y fallaba con "Transaction not found".

### Decisión
Dividir en 5 transacciones independientes ejecutadas en secuencia, una por entidad. Cada una con timeout de 30s. La lógica interna de cada bloque es idéntica a la anterior. LspServices va última porque depende de Consorcios y Proveedores ya sincronizados.

### Alternativas descartadas
- Aumentar el timeout a 60s: solo patea el problema, no lo resuelve para datasets grandes.

### Impacto
- Modificado: `src/app/api/client/sync-directory/route.ts`

---

## 2026-03-27 — Aclaración CUIT emisor vs receptor en facturas B/C

### Problema
En facturas tipo B/C, la IA confundía el CUIT del receptor (consorcio) con el del emisor (proveedor) porque el receptor tiene etiqueta 'CUIT:' explícita en el cuerpo, mientras que el emisor tiene el CUIT en el encabezado superior derecho sin etiqueta tan prominente.

### Decisión
Agregar aclaración en `buildInvoicePrompt` advirtiendo sobre esta trampa y orientando a identificar el bloque del emisor (encabezado superior derecho, junto a número de factura, ingresos brutos e inicio de actividades).

### Impacto
- Modificado: `src/lib/extraction.ts` (solo prompt facturas normales)

---

## 2026-03-27 — Constante LSP_LATERAL_CUIT_RULES para CUIT en margen lateral

### Problema
En facturas de Edesur y Edenor el CUIT de la empresa no aparece en el encabezado sino en el margen lateral izquierdo, impreso de forma vertical/rotada. La instrucción genérica `LSP_PROVIDER_TAX_ID_RULES` solo indicaba buscar en el encabezado, lo que hacía que la IA no lo encontrara.

### Decisión
Crear constante compartida `LSP_LATERAL_CUIT_RULES` e incluirla en `buildEdesurPrompt` y `buildEdenorPrompt` después de `LSP_PROVIDER_TAX_ID_RULES`. Reemplaza la aclaración inline que existía solo en Edesur.

### Impacto
- Modificado: `src/lib/extraction.ts` (nueva constante + incluida en 2 prompts)

---

## 2026-03-27 — Proveedor LSP resuelto por CUIT desde tabla Provider

### Problema
Los prompts LSP (Edesur, Edenor, AySA, etc.) tenían CUITs hardcodeados en el código fuente. Esto significaba que agregar un nuevo proveedor LSP requería un cambio de código. Además, el pipeline LSP no resolvía `providerId` — la invoice quedaba sin vínculo al Provider, y el nombre del proveedor venía del router en vez de la DB.

### Decisión
- Eliminar CUITs hardcodeados de todos los prompts LSP. Reemplazar por `LSP_PROVIDER_TAX_ID_RULES` genérico que instruye a la IA a extraer el CUIT del encabezado.
- El pipeline ahora busca el proveedor LSP por CUIT (via `allTaxIds`) contra la tabla Provider. Si lo encuentra, usa el nombre canónico de la DB y setea `providerId`.
- El lookup de LspService intenta primero por `providerId` (FK) y luego por campo texto `provider` (backward compatible).
- Si un LspService matchea y no tiene `providerId`, se actualiza automáticamente (migración progresiva de datos).
- Sync-directory resuelve `providerId` al crear LspServices, buscando por nombre canónico en la tabla Provider.
- Si el proveedor no está en la DB, se usa `LSP_FALLBACK_NAMES` como fallback (nombres hardcodeados del router) y se loguea un warning.

### Alternativas descartadas
- Mantener CUITs hardcodeados y solo agregar `providerId`: no resuelve el problema de mantenibilidad — cada nuevo proveedor LSP seguiría requiriendo cambio de código.
- Eliminar el campo texto `provider` de LspService: prematuro, rompe backward compatibility con datos existentes.

### Impacto
- Migración: `20260327000100_lspservice_add_provider_fk`
- Modificados: `prisma/schema.prisma`, `src/lib/extraction.ts`, `src/jobs/processPendingDocuments.job.ts`, `src/app/api/client/sync-directory/route.ts`, `src/lib/logger.ts`

---

## 2026-03-26 — Normalización de clientNumber para LspService lookup

### Problema
Los números de cliente en la DB se guardan sin ceros a la izquierda (ej: `366037`), pero la IA extrae el clientNumber tal como aparece en el PDF, que frecuentemente incluye ceros (ej: `00366037`). El lookup de `LspService.findFirst({ clientNumber })` fallaba porque comparaba `"00366037"` con `"366037"`.

### Decisión
- Normalizar `extracted.clientNumber` con `.replace(/^0+/, "")` antes de usarlo en el `findFirst` de LspService en el pipeline.
- Aplicar la misma normalización al guardar `clientNumber` durante la sincronización de `_LspServices` desde el archivo ALTA (`sync-directory`), para que la DB siempre tenga el valor sin ceros.
- No modificar prompts ni schema — la normalización se hace en el pipeline y en la ingesta.

### Impacto
- Modificados: `src/jobs/processPendingDocuments.job.ts`, `src/app/api/client/sync-directory/route.ts`

---

## 2026-03-26 — CUIT como identificador primario en matching (allTaxIds)

### Problema
El matching de consorcio y proveedor dependía casi exclusivamente del nombre extraído por la IA, que a veces venía con errores de OCR, variantes de escritura o normalizaciones imprecisas. El campo `providerTaxId` solo contenía un CUIT (el que la IA clasificaba como del proveedor), pero en documentos de servicios públicos frecuentemente confundía el CUIT del consorcio con el del proveedor.

### Decisión
- La IA ahora extrae **todos** los CUITs que encuentra en el documento como lista plana (`allTaxIds`), sin clasificarlos.
- El pipeline busca cada CUIT de `allTaxIds` contra las tablas `Consortium` y `Provider` en la DB, usando la función `normCuit()` (solo dígitos) para comparar.
- Matching de consorcio: CUIT-first (allTaxIds) → exacto (canonicalName) → fuzzy → alias.
- Matching de proveedor: CUIT allTaxIds (excluyendo CUIT del consorcio ya matcheado) → CUIT providerTaxId legacy → nombre exacto → nombre parcial.
- Si ningún CUIT matchea, se cae al flujo existente por nombre sin romper nada.
- Se usa `normCuit()` (ya existente en el pipeline, strip a solo dígitos) para normalizar ambos lados de la comparación.
- Schema Zod cambiado de `.strict()` a `.passthrough()` para robustez ante campos extra de la IA.

### Alternativas descartadas
- Crear función `normalizeTaxId` nueva: no necesaria, `normCuit()` ya existía y hace exactamente lo mismo (strip non-digits).
- Hacer queries por CUIT a la DB (N+1): descartado porque el pipeline ya carga todos los consorcios y proveedores en memoria.

### Impacto
- Modificados: `src/types/extractedDocument.types.ts`, `src/lib/extraction.ts`, `src/jobs/processPendingDocuments.job.ts`, `src/lib/logger.ts`
- Backward-compatible: invoices viejas sin `allTaxIds` siguen funcionando (campo opcional, default null/[])

---

## 2026-03-26 — Conservar razón social en nombre de proveedor (PROVIDER_NAME_RULES)

### Problema
La extracción IA a veces devolvía el nombre del proveedor sin la razón social (ej: "ASCENSORES POTENZA" en lugar de "ASCENSORES POTENZA S.R.L."). Esto generaba inconsistencias entre el nombre extraído y los datos registrados en DB/Sheets, dificultando el matching y la identificación visual del proveedor.

### Decisión
- Nueva constante `PROVIDER_NAME_RULES` en `src/lib/extraction.ts` con la instrucción de conservar S.R.L., S.A., S.A.S., S.C., S.H., COOP., LTDA., etc.
- Se incluyó en los 7 prompts de extracción (facturas normales + 6 LSP) siguiendo el patrón existente de reglas compartidas (`CONSORTIUM_ADDRESS_RULES`, `INVALID_DATE_RULES`, `PAYMENT_METHOD_RULES`).
- No se modificó la lógica de matching ni normalización. El matching existente funciona con el nombre completo incluyendo razón social.

### Impacto
- Modificado: `src/lib/extraction.ts` (nueva constante + inclusión en 7 prompts)

---

## 2026-03-26 — Límite de PDFs por lote configurable (batchSize)

### Problema
El scheduler agarraba todos los PDFs pendientes de un cliente en un solo ciclo. Con clientes que suben muchos PDFs a la vez, esto generaba lotes muy grandes que podían sobrecargar el worker y consumir tokens IA desproporcionadamente.

### Decisión
- Campo `batchSize Int @default(10)` en modelo Client, configurable desde el panel admin.
- El scheduler respeta el límite: si encuentra 50 PDFs pero `batchSize=10`, encola 10 y loguea que el resto se procesará en el próximo ciclo.
- Validación: entero entre 1 y 500 (Zod en API).
- El campo se agrega a `ProcessingClient` para que el scheduler lo lea directamente.

### Impacto
- Migración: `20260326000100_add_batch_size_and_invoice_tokens`
- Modificados: `schema.prisma`, `scheduler.ts`, `client.types.ts`, `client.repository.ts`, `jobWorkerMain.ts`, admin client API y UI

---

## 2026-03-26 — Registro de tokens por factura individual

### Problema
Los tokens se registraban solo a nivel de corrida/scheduler (tabla `TokenUsage`). No había forma de analizar el costo por boleta individual ni identificar qué tipo de documentos consumían más tokens.

### Decisión
- Campos nullable en Invoice: `tokensInput`, `tokensOutput`, `tokensTotal` (Int?), `aiProvider` (String?), `aiModel` (String?).
- El pipeline captura `extractor.getLastUsage()` después de cada extracción exitosa (Gemini o OpenAI) y lo pasa a `saveProcessedInvoice`.
- Los duplicados por hash (que reusan extracción anterior) quedan con tokens null — correcto, no consumieron IA.
- Nueva página `/admin/invoices` accesible solo para ADMIN, con filtro por cliente y paginación server-side.

### Alternativas descartadas
- Tabla separada `InvoiceTokenUsage` (1:1) — overhead innecesario, los campos directamente en Invoice son más simples y eficientes para consultas.

### Impacto
- Misma migración que batchSize
- Modificados: `schema.prisma`, `invoice.repository.ts`, `processPendingDocuments.job.ts`
- Nuevos: `src/app/api/admin/invoices/route.ts`, `src/app/admin/invoices/page.tsx`, `src/app/admin/invoices/page.module.css`
- Modificado: `src/app/admin/page.tsx` (botón Invoices para ADMIN)

---

## 2026-03-24 — Purga completa de boletas por cliente (Admin)

### Problema
No existía forma de revertir el pipeline completo para un cliente. Si se necesitaba reprocesar todas las boletas (por cambios en prompts, configuración incorrecta, etc.), había que limpiar manualmente la DB, Sheets y mover archivos en Drive.

### Decisión
- Endpoint `DELETE /api/admin/clients/[id]/purge` con flujo tolerante a fallos: Drive → Sheets → DB.
- Los archivos de Drive se mueven (no borran) de vuelta a `pending` intentando primero desde `scanned`, luego `unassigned`.
- La carpeta `failed` no se toca.
- Sheets se limpia con `clearAllDataRows()` (borra fila 2+, preserva headers).
- Solo se borran Invoices y ProcessingJobs. NO se tocan Consorcios, Proveedores, Períodos, Rubros, Coeficientes ni LspServices.
- Si Drive o Sheets fallan, se loguea warning y se continúa. El borrado de DB se ejecuta siempre.
- Modal de 3 pasos en la UI (preview → confirmación → resultado) para prevenir purgas accidentales.

### Impacto
- Nuevo archivo: `src/app/api/admin/clients/[id]/purge/route.ts`
- Nuevo método: `GoogleSheetsService.clearAllDataRows()`
- Modificado: `src/app/admin/page.tsx` (botón Purgar + modal)
- Modificado: `src/app/admin/page.module.css` (estilos purge)

---

## 2026-03-24 — Sidebar colapsable + menú hamburguesa en panel cliente

### Problema
El panel cliente (`/admin/consortiums`) tenía todos los controles (scheduler, tema, sync directorio, cerrar sesión) dentro de la misma página como botones sueltos. No había navegación global ni estructura visual clara. En mobile no había menú responsive.

### Decisión
- Sidebar global con: placeholder logo, nombre del cliente (obtenido de `/api/auth/me`), separadores, y botones de navegación.
- En desktop: sidebar colapsable entre modo expandido (iconos + labels) y modo compacto (solo iconos).
- En tablet/mobile (≤1024px): sidebar oculto con menú hamburguesa en la toolbar superior.
- Toolbar superior: controles de scheduler (Pausar/Ejecutar) a la izquierda, toggle de tema a la derecha.
- Toggle dark/light reemplazado por switch tipo interruptor con iconos sol/luna (sin texto). Estado solo de sesión (no persiste en localStorage).
- Botón "Cerrar Periodo General" solo visible para rol CLIENT.
- Botón "Consorcios" deshabilitado con badge "Premium" si `consortiumsEnabled` es false.

### Alternativas descartadas
- **Librería de componentes UI (Radix, Headless UI)**: over-engineering para un sidebar simple. CSS Modules alcanza.
- **lucide-react para iconos**: no estaba instalado y agregar dependencias no era deseado. Se usaron caracteres Unicode (☀️, 🌙, ☰, ◀, ▶).
- **Persistir tema en localStorage**: el usuario pidió explícitamente estado solo de sesión.

### Impacto
- Archivos modificados: `src/app/admin/consortiums/page.tsx`, `src/app/admin/consortiums/page.module.css`
- Sin archivos nuevos ni dependencias nuevas

---

## 2026-03-24 — Cerrar Periodo General con lógica de mes mayoritario

### Problema
No había forma de cerrar todos los períodos activos de un cliente de una sola vez. El cierre individual por consorcio era tedioso para administradores con decenas de consorcios. Además, se necesitaba una lógica inteligente para determinar qué mes cerrar cuando no todos los consorcios están en el mismo período.

### Decisión
- **Lógica de mes mayoritario**: se cuentan las frecuencias de `(year, month)` entre todos los períodos ACTIVE del cliente. Se elige el más frecuente. Esto evita cerrar accidentalmente períodos que están adelantados o atrasados.
- **Dos endpoints separados** (preview + execute):
  - `GET /api/client/periods/close-all/preview`: calcula mes mayoritario, retorna lista de consorcios a cerrar (`toClose`) y a saltear (`toSkip` con razón).
  - `POST /api/client/periods/close-all`: recalcula internamente el mes mayoritario (no confía en el body del cliente), cierra los períodos del mes mayoritario y crea el siguiente como ACTIVE.
- **Modal de 2 pasos** en la UI: primero preview con lista de consorcios (cerrar vs saltear), luego resultado con contadores.
- El POST recalcula el mes mayoritario en vez de recibir `year/month` del frontend, evitando race conditions si otro usuario cierra períodos entre preview y execute.
- La misma lógica de mes mayoritario se reutiliza en: `ConsortiumRepository.resolveMajorityMonth()`, `import/route.ts`, `sync-directory/route.ts`.

### Alternativas descartadas
- **Enviar year/month desde el frontend**: vulnerable a race conditions. Mejor recalcular server-side.
- **Cerrar TODOS los períodos activos sin importar el mes**: peligroso si algunos consorcios tienen meses distintos por error o por estar adelantados.
- **Un solo endpoint POST sin preview**: sin preview el usuario no sabe qué se va a cerrar ni qué se va a saltear.

### Impacto
- Archivos creados: `src/app/api/client/periods/close-all/preview/route.ts`, `src/app/api/client/periods/close-all/route.ts`
- Archivos modificados: `src/repositories/consortium.repository.ts` (nuevo método `resolveMajorityMonth()`), `src/app/api/client/import/route.ts`, `src/app/api/client/sync-directory/route.ts`, `src/app/admin/consortiums/page.tsx`

---

## 2026-03-24 — Período por defecto con mes mayoritario al crear consorcios

### Problema
Al crear consorcios (manual, import Excel, sync-directory), el período inicial se creaba con el mes actual (`new Date()`). Si un cliente ya tenía 30 consorcios en abril 2026 y creaba uno nuevo en mayo 2026, el nuevo quedaba en mayo mientras el resto estaba en abril. Esto generaba inconsistencias al cerrar períodos y en la operación diaria.

### Decisión
- `ConsortiumRepository.resolveMajorityMonth()`: si hay períodos activos existentes, retorna el mes más frecuente. Si no hay ninguno, retorna el mes actual.
- Se aplica en: `createManual()`, import Excel (`import/route.ts`), y sync-directory (`sync-directory/route.ts`).
- En sync-directory la lógica se resuelve inline dentro de la transacción Prisma para no romper el contexto transaccional.

### Alternativas descartadas
- **Siempre usar mes actual**: genera inconsistencias con el resto de consorcios.
- **Pedir al usuario que elija el mes**: agrega fricción innecesaria cuando la respuesta correcta es casi siempre "el mismo mes que los demás".

### Impacto
- Archivos modificados: `src/repositories/consortium.repository.ts`, `src/app/api/client/import/route.ts`, `src/app/api/client/sync-directory/route.ts`

---

## 2026-03-23 — Asignación automática de período activo a invoices

### Problema
Las boletas procesadas no quedaban asociadas a ningún período, lo que impedía filtrar y generar reportes por mes/año. El campo `periodId` ya existía en el schema de Invoice pero no se estaba populando durante el pipeline automático.

### Decisión
- Se busca el período ACTIVE del consorcio matcheado en `resolveAssignment()` (tanto en el path normal como en el LSP fast path).
- Se asigna `periodId` al Invoice al guardarlo en DB.
- Se agrega columna `period` (formato `MM/YYYY`) a Google Sheets en posición M (nueva columna al final).
- Las columnas existentes (A–L incluyendo `clientNumber` en J) no se modificaron.
- Si no hay período activo (caso defensivo), se loguea un warning y `periodId` queda null — el pipeline no falla.

### Alternativas descartadas
- Crear el período automáticamente si no existe: descartado porque eso podría generar períodos con mes/año incorrectos si el consorcio nunca tuvo uno.
- Usar la fecha del documento para inferir el período: complejo y propenso a errores — mejor confiar en el período ACTIVE del consorcio.

### Impacto
- `src/jobs/processPendingDocuments.job.ts` — `resolveAssignment()` ahora devuelve `periodLabel`, `processDriveFile()` lo asigna a `extracted.period`, `DEFAULT_MAPPING` agrega `period: "M"`
- `src/services/googleSheets.service.ts` — `SheetsRowMapping` agrega campo `period` al final (sin remover `clientNumber`)
- `src/lib/clientProcessingConfig.ts` — `requiredKeys` agrega `"period"` al final
- `src/app/api/client/consortiums/[id]/invoices/route.ts` — invoice manual incluye período en Sheets
- `src/types/extractedDocument.types.ts` — campo `period` agregado

---

## 2026-03-23 — Feature consortiumsEnabled (Premium) para control de acceso a consorcios

### Problema
Todos los clientes tenían acceso a la funcionalidad de gestión de consorcios. Se necesitaba un mecanismo para habilitar/deshabilitar esta feature por cliente, permitiendo ofrecer planes diferenciados (free vs premium).

### Decisión
- Nuevo campo `consortiumsEnabled Boolean @default(false)` en el modelo Client.
- El panel admin muestra un toggle "Premium" por cliente con actualización optimista (PATCH a `/api/admin/clients/[id]`).
- El panel cliente condiciona el botón "Consorcios": deshabilitado con badge dorado "Premium" si `consortiumsEnabled` es false.
- La página `/admin/consortiums` verifica acceso via `/api/auth/me` al montar y redirige a `/admin` si no está habilitado.
- Se removió la columna ClientId de la tabla de métricas (innecesaria para el admin) y se reemplazó por la columna Premium.

### Alternativas descartadas
- **Middleware de Next.js para bloquear `/admin/consortiums`**: requiere acceso a DB desde Edge Runtime, más complejo y no compatible con el patrón actual de autenticación.
- **Campo `plan` con enum**: over-engineering para una sola feature gate. Si en el futuro se necesitan más features, se puede migrar a un sistema de plans.

### Impacto
- Migración: `20260323000300_add_consortiums_enabled`
- Archivos modificados: `schema.prisma`, `admin/page.tsx`, `admin/page.module.css`, `admin/consortiums/page.tsx`, `api/admin/clients/[id]/route.ts`, `api/admin/audit/clients/route.ts`, `api/auth/me/route.ts`

---

## 2026-03-23 — Modelo LspService para lookup automático de servicios públicos

### Problema
El pipeline extraía datos de facturas LSP (Edesur, AySA, etc.) pero no tenía forma de vincular la factura a un servicio específico dentro de un consorcio. Un consorcio puede tener múltiples servicios del mismo proveedor (ej: dos medidores Edesur con distintos números de cliente). Sin esta relación, no se podía identificar a qué servicio corresponde cada factura.

### Decisión
- Nueva tabla `LspService` con campos: clientId, consortiumId, provider (normalizado), clientNumber, description.
- Unique constraint: `(consortiumId, provider, clientNumber)` — un consorcio no puede tener el mismo nro de cliente duplicado para el mismo proveedor.
- El pipeline busca en `LspService` después de extraer `clientNumber` con IA, usando `clientId + provider + clientNumber`.
- Si encuentra match → setea `lspServiceId` en Invoice. Si no → loguea warning y continúa.
- Nueva columna NRO CLIENTE en Sheets (columna J) para registrar el número de cliente extraído.
- Nuevo enum `PaymentMethod` (DEBITO_AUTOMATICO, TRANSFERENCIA, EFECTIVO) como campo nullable en Invoice.
- Todos los prompts LSP actualizados para extraer `clientNumber` y `paymentMethod`.
- Extracción limitada a página 1 para documentos LSP (reduce ruido en la extracción IA).
- Nueva hoja `_LspServices` en archivo ALTA para cargar los servicios desde Sheets.

### Alternativas descartadas
- **Lookup por dirección del consorcio**: impreciso porque las LSPs formatean direcciones de maneras distintas.
- **Campo clientNumber suelto en Invoice sin tabla**: no permite validar ni vincular a un consorcio específico.
- **Crear LspService automáticamente desde el pipeline**: podría generar duplicados y datos incorrectos sin supervisión humana.

### Impacto
- Migración: `20260323000200_add_lspservice_paymentmethod`
- Archivos modificados: `schema.prisma`, `extraction.ts`, `processPendingDocuments.job.ts`, `googleSheets.service.ts`, `sync-directory/route.ts`, `clientProcessingConfig.ts`, `pdfTextExtractor.service.ts`, `invoice.repository.ts`, `extractedDocument.types.ts`, `invoices/route.ts`
- Columnas de Sheets desplazadas: sourceFileUrl J→K, isDuplicate K→L
- Nuevo prompt: `buildPersonalPrompt` con keywords PERSONAL/TELECOM

---

## 2026-03-23 — Separar matchNames (interno) de paymentAlias (visible)

### Problema
El campo `alias` en Provider y `aliases` en Consortium cumplía dos funciones distintas:
1. **Matching interno**: nombres alternativos para que el pipeline identifique la entidad en PDFs (ej: "BROWN ALMTE AV 708" para matchear con "ALMIRANTE BROWN 706").
2. **Alias de pago**: nombre corto visible en la UI y en la columna "ALIAS" de Google Sheets.

Mezclar ambos usos genera confusión: si un admin carga un alias de pago como "TIGRE", el pipeline lo usa para matching de nombre, lo cual puede generar falsos positivos. Y si se cargan nombres técnicos de matching (como direcciones alternativas), aparecen en la UI sin sentido para el usuario.

### Decisión
- Renombrar `Provider.alias` → `Provider.matchNames` y `Consortium.aliases` → `Consortium.matchNames`.
- Agregar `paymentAlias` (String?, opcional) en ambos modelos.
- `matchNames`: campo interno, separado por `|`, usado exclusivamente por el pipeline de matching. No se muestra en la UI.
- `paymentAlias`: campo visible en la UI (label "Alias") y escrito en la columna "ALIAS" de Google Sheets. Si no tiene valor, la celda queda vacía.
- En el pipeline, `extracted.alias` (columna I de Sheets) ahora se setea con `provider.paymentAlias` en vez de `provider.canonicalName`.
- Migración por rename de columna (preserva datos existentes).

### Alternativas descartadas
- **Dos campos en la UI**: mostrar ambos campos al usuario. Descartado porque `matchNames` es un concepto técnico que el usuario no necesita ver ni gestionar directamente (se carga via Sheets ALTA o import Excel).
- **Campo único con separador especial**: usar un prefijo o formato especial para distinguir matching de pago dentro del mismo campo. Frágil y propenso a errores.

### Impacto
- Migración: `20260323000100_rename_alias_to_matchnames_add_paymentalias`
- Archivos modificados: `schema.prisma`, `processPendingDocuments.job.ts`, `googleSheets.service.ts`, `sync-directory/route.ts`, `import/route.ts`, `import/template/route.ts`, `providers/route.ts`, `consortiums/page.tsx`
- Sync ALTA: hojas `_Consorcios` y `_Proveedores` ampliadas de 3 a 4 columnas
- Import Excel: nueva columna "Alias de pago" en ambas hojas
- Compatible con datos existentes: rename preserva valores, `paymentAlias` empieza como NULL

---

## 2026-03-23 — Optimización docker-compose: imagen compartida entre servicios

### Problema
Los 3 servicios (web, scheduler, worker) en `docker-compose.yml` tenían cada uno su propio bloque `build:`, lo que causaba que `docker compose up --build` construyera la misma imagen 3 veces. Esto triplicaba el tiempo de build sin ningún beneficio — los 3 servicios usan exactamente el mismo Dockerfile y la misma imagen final.

### Decisión
- Agregar `image: drive-doc-processor:latest` al servicio `web` (que mantiene el `build:`).
- Reemplazar los bloques `build:` de `scheduler` y `worker` por `image: drive-doc-processor:latest`.
- Resultado: `docker compose up --build` construye **una sola vez** y los 3 servicios reusan la misma imagen.

### Alternativas descartadas
- **docker compose build + referencia cruzada con `depends_on`**: Docker Compose no cachea automáticamente entre servicios con `build:` independiente — sigue intentando buildear cada uno.
- **Script wrapper que hace `docker build` primero y luego `compose up`**: agrega complejidad innecesaria cuando el tag de imagen resuelve el problema nativamente.

### Impacto
- Archivo modificado: `docker-compose.yml`
- Tiempo de build reducido ~66% (1 build en vez de 3)

---

## 2026-03-23 — Auditoría de .env.example para producción Docker

### Problema
El `.env.example` tenía 15 variables sin comentarios ni agrupación. Faltaba `GOOGLE_CREDENTIALS_ENCRYPTION_KEY` (usada en `encryption.util.ts` con fallback a `SESSION_SECRET`). Al preparar Docker para producción, un operador no sabría qué variables son requeridas vs opcionales ni qué hace cada una.

### Decisión
Reescribir `.env.example` con:
- Variables agrupadas por categoría (DB, Auth, Google Cloud, Drive, Sheets, Scheduler, IA)
- Comentarios descriptivos en cada variable
- `GOOGLE_CREDENTIALS_ENCRYPTION_KEY` agregada como opcional

### Impacto
- Archivo modificado: `.env.example`

---

## 2026-03-21 — Dockerización con 3 servicios separados y CI/CD

### Problema
El docker-compose original tenía 2 servicios: web (con scheduler como proceso background vía `&`) y worker. El scheduler no se reiniciaba si crasheaba. El worker apuntaba a un archivo incorrecto (`jobWorker.js` vs `jobWorkerMain.js`). Los path aliases `@/` no se resolvían en los archivos compilados de `dist/`, haciendo que el worker no pudiera arrancar en Docker.

### Decisión
- **3 servicios separados** (web, scheduler, worker) para que Docker reinicie cada uno independientemente.
- **`tsc-alias`** como post-procesador de `tsc` para reemplazar `@/` por paths relativos en `dist/`. Más simple que configurar `tsconfig-paths/register` o cambiar la estrategia de módulos.
- **`output: "standalone"`** en Next.js para generar una imagen más liviana (solo `server.js` + deps mínimas embebidas).
- **Production deps copiadas aparte** (`npm ci --omit=dev`) porque los jobs necesitan `googleapis`, `dotenv`, etc. que standalone no incluye.
- **Cloudflare Tunnel** como 4to servicio en el compose, configurado con `CLOUDFLARE_TUNNEL_TOKEN` en el `.env`.
- **ESLint** con `typescript-eslint` + `@next/eslint-plugin-next` como gate de CI.
- **GitHub Actions** con 3 jobs: check (lint+types), build (Docker), deploy (self-hosted runner).

### Alternativas descartadas
- Copiar solo paquetes específicos al runtime (google, openai, etc.): frágil por dependencias transitivas faltantes.
- Usar `tsx` en producción para los jobs: agrega overhead innecesario y dependencia de dev.
- Coolify/Dokku: más infraestructura de la necesaria para un deploy local con tunneling.

### Impacto
- Archivos creados: `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`, `eslint.config.mjs`, `src/lib/clientAuth.ts`, `src/types/canvas-shim.d.ts`
- Archivos modificados: `package.json` (scripts build:jobs, lint, check), `next.config.ts` (standalone), `tsconfig.jobs.json` (excludes)
- Fixes: encoding UTF-8 en close-period/route.ts, async params en receipt/route.ts, type cast en scan/route.ts

---

## 2026-03-21 — Sistema de logging centralizado para scheduler y worker

### Problema
Los logs del scheduler, worker y pipeline eran planos (`console.log` con strings concatenados), sin timestamps, sin separación visual entre ciclos, y silenciosos cuando no había trabajo. Cuando ocurría un error, era difícil correlacionar entre las 3 terminales y entender qué pasó en qué momento.

### Decisión
Crear `src/lib/logger.ts` como módulo centralizado con:
- **Timestamps ISO** en cada línea para correlacionar entre terminales
- **Tags de proceso** (`[SCHEDULER]`, `[WORKER]`, `[JOB]`, `[RUN-CYCLE]`) para filtrar
- **Emojis** como indicadores visuales instantáneos (✅ éxito, ❌ error, ⚠️ warning, 📄 archivo, 📊 resumen)
- **Separadores visuales** (`divider`, `miniDivider`) para marcar inicio/fin de ciclos y lotes
- **Logs específicos por contexto**: `schedulerLog`, `workerLog`, `pipelineLog`, `cycleLog`
- **Datos estructurados**: cada paso del pipeline muestra el dato extraído (consorcio, proveedor, CUIT, monto, vto)
- **Método de matching visible**: cuando se encuentra un consorcio/proveedor, se muestra si fue exacto, fuzzy o alias
- **Detección LSP visible**: se loguea qué tipo de LSP se detectó (EDESUR, AYSA, etc.)

### Alternativas descartadas
- **Winston/Pino**: librerías de logging profesionales. Descartado porque agregan dependencia, y el output estructurado en JSON no es legible en PowerShell sin herramientas extra. Los logs van a terminales locales, no a un servicio de monitoreo.
- **Log levels con env var**: configurar niveles (DEBUG/INFO/WARN). Descartado por ahora — se puede agregar después si el volumen de logs molesta.

### Impacto
- Archivo nuevo: `src/lib/logger.ts`
- Archivos modificados: `scheduler.ts`, `jobWorkerMain.ts`, `processPendingDocuments.job.ts`, `runProcessingCycle.ts`
- Sin cambios en interfaces exportadas (backward compatible)

---

## 2026-03-21 — Prompts LSP por empresa con CUIT hardcodeado

### Problema
La extracción IA de facturas de servicios públicos (LSP) tenía 3 errores recurrentes:
1. **CUIT confundido**: en LSPs el CUIT del consorcio (cliente/receptor) aparece prominente en el documento, y la IA lo tomaba como providerTaxId. En AySA el CUIT del cliente aparece al final con "IVA RESPONSABLE INSCRIPTO - CUIT No. XX-XXXXXXXX-X".
2. **Fecha CESP/CAE como dueDate**: en facturas de AySA aparece "C.E.S.P: XXXXX | Fecha Vto: DD/MM" donde "Fecha Vto" es del código electrónico de servicio público, no de pago. La IA lo tomaba como fecha de vencimiento de pago.
3. **Consorcio no matchea**: las LSPs formatean direcciones con ceros a la izquierda (00706), sufijos numéricos extras (706 018), código postal (C1414AWF) y localidad (CAPITAL FEDERAL). El normalizer no los limpiaba.

### Decisión
Refactorizar `extraction.ts` con un router `identifyLSPProvider()` que detecta la empresa y despacha a un prompt específico:
- `buildEdesurPrompt()` — CUIT 30-71079642-7 hardcodeado, regla de primer vencimiento
- `buildAysaPrompt()` — CUIT 30-70956507-5, advertencia explícita de trampa CESP y CUIT del cliente al final
- `buildEdenorPrompt()` — CUIT 30-65651651-4
- `buildGasPrompt()` — Metrogas, Naturgy, Camuzzi, Litoral Gas con CUITs respectivos
- `buildGenericUtilityBillPrompt()` — fallback para LSPs no identificadas

En `consortiumNormalizer.ts` se agregaron 4 funciones de limpieza: `stripLeadingZeros`, `stripTrailingNumericSuffix`, `stripPostalAndLocality`, `stripFloorUnit`.

### Alternativas descartadas
- **Prompt único mega-detallado**: no funcionaba porque las instrucciones genéricas no eran lo suficientemente específicas para cada formato de empresa.
- **Post-procesamiento del CUIT**: validar contra lista conocida después de la extracción. No resuelve el problema de raíz.

### Impacto
- Archivos modificados: `src/lib/extraction.ts`, `src/lib/consortiumNormalizer.ts`
- Interfaces exportadas: sin cambios (backward compatible)

---

## 2026-03-21 — Regla obligatoria de documentación en docs/

### Problema
El progreso y las decisiones no se documentaban consistentemente. Al retomar contexto se perdía tiempo redescubriendo qué se hizo y por qué.

### Decisión
Regla obligatoria: todo cambio significativo actualiza `docs/progreso.md`, `docs/decisiones.md` y `CHANGELOG.md`. Documentado en CLAUDE.md como sección prioritaria.

### Impacto
- Aplica a todas las sesiones futuras de desarrollo

---

## 2026-03-20 — Private key encriptada pasada directamente a GoogleSheetsService

### Problema
Al implementar la sincronización del archivo ALTA, se pasaba `client.googleConfigJson.privateKey` directamente. Estaba encriptada → error `error:1E08010C:DECODER routines::unsupported`.

### Decisión
Usar siempre `resolveGoogleConfig(client)` que desencripta antes de construir servicios Google.

### Impacto
- Archivo modificado: `src/app/api/client/sync-directory/route.ts`
- Regla: nunca acceder a `client.googleConfigJson.privateKey` directamente
