# Decisiones técnicas — drive-doc-processor

Registro de decisiones tomadas ante problemas reales encontrados en producción.

---

## 2026-05-18 — Pin de imagen Docker por SHA en deploy (en vez de `:latest`)

### Problema
Después de mergear el commit `d33ff62` (soporte Claude), el job `deploy` del
CI corrió a éxito (Lint+Build+Deploy todos verdes en 14m 19s) y el step
`Build and restart` aparentemente ejecutó `docker pull ...:latest` +
`docker compose up -d --force-recreate`. Sin embargo, en producción el
contenedor `web-1` siguió corriendo la imagen `sha256:c8cc3d4b...` creada
el **7 de mayo**, con bundle de Next que **no contenía** el JSX nuevo del
input "Anthropic API Key". `docker image inspect ghcr.io/.../...:latest`
en el host también mostraba el SHA viejo con `Created: 2026-05-07`,
pese a que en GHCR el tag `:latest` apuntaba correctamente al digest nuevo
publicado hacía 1 hora.

Causa raíz: el `docker pull ...:latest` no actualizó realmente la imagen
local. El daemon mantuvo el manifest cacheado de `:latest` y el
`compose up --force-recreate` recreó los contenedores con la imagen vieja.
El job no falló porque el pull retornó exit 0 (pull "exitoso" sin descarga).
La fix manual fue: `docker logout ghcr.io && docker pull ...:<sha_largo>`,
retageo a `:latest` y `compose up --force-recreate`.

### Decisión
Eliminar `:latest` del path crítico del deploy. Cambios:

1. **`docker-compose.yml`**: los tres servicios (`web`, `scheduler`, `worker`)
   pasan a usar:
   ```yaml
   image: ghcr.io/johnydeev/ia-drive-doc-processor:${IMAGE_TAG:-latest}
   ```
   El default sigue siendo `:latest` para que `docker compose up` manual
   ad-hoc no se rompa.

2. **`.github/workflows/ci.yml`** (job `deploy`, step `Build and restart`):
   - Setear `IMAGE_TAG: ${{ github.sha }}` en el `env:` del step.
   - `docker pull ghcr.io/...:${{ github.sha }}` en vez de `:latest`.
     Si la imagen del SHA no existe en GHCR (build fallido silencioso,
     push denegado, etc.), el pull falla con error explícito → el job
     aborta → no se queda corriendo la imagen vieja.
   - `docker tag ...:${{ github.sha }} ...:latest` después del pull para
     mantener el alias local actualizado (preserva el flujo manual).
   - `compose run --rm web npx prisma migrate deploy` y
     `compose up -d --force-recreate` heredan `IMAGE_TAG` del step y
     usan la imagen pineada.

Beneficio adicional: el rollback manual ante un deploy malo queda trivial.
Hay que reapuntar `IMAGE_TAG` al SHA de la última versión buena y correr
`compose up`. No depende de moverse contra un tag mutable.

### Alternativas descartadas
- **Solo validar el digest después del pull y abortar si no cambió.**
  Funciona pero es frágil: requiere parsing y comparación de strings, y no
  soluciona el problema de que `:latest` siga siendo un tag mutable. Pinear
  por SHA elimina la categoría entera de problemas.
- **`docker pull --platform` o variantes de force-pull.** No existe un flag
  de `docker pull` que ignore el manifest cacheado. La única forma robusta
  es cambiar el tag.
- **Usar digest inmutable (`@sha256:...`) en lugar del SHA del commit.**
  Es la opción más estricta pero requiere capturar el digest del push en
  el build job y pasarlo al deploy. Más complejo sin un beneficio práctico
  significativo sobre pinear por SHA del commit (que ya es inmutable porque
  cada commit produce su propio tag).
- **Rollback automático ante deploy fallido.** Fuera de alcance — la
  detección ya existe vía el step "Wait for healthy"; un rollback
  automático merece su propia decisión.

### Impacto
- Archivos modificados:
  - `docker-compose.yml` — los tres servicios usan `${IMAGE_TAG:-latest}`.
  - `.github/workflows/ci.yml` — job `deploy` pin por SHA + retageo local.
- Sin cambios de schema, sin migración.
- Próximo push a master ejercita el nuevo flujo. Si el `docker pull
  :<sha>` falla, el deploy aborta antes de tocar contenedores en
  producción.

---

## 2026-05-18 — Claude (Anthropic) como tercer proveedor de IA en la cadena de extracción

### Problema
La extracción IA dependía de dos proveedores (Gemini → OpenAI). Cuando ambos
fallaban (rate limit simultáneo, error 5xx del lado del proveedor, key inválida
o quota agotada), el pipeline caía a `buildOcrOnlyPayload()` y la boleta
terminaba en "Sin Asignar". Sin un tercer proveedor independiente, cada
incidente en Gemini u OpenAI se traducía 1-a-1 en boletas no procesadas que
había que reintentar manualmente.

### Decisión
Sumar **Claude (Anthropic)** como tercer eslabón de fallback, manteniendo el
orden por costo/latencia: **Gemini → OpenAI → Claude → OCR_ONLY**. Anthropic
es independiente de Google (Gemini) y Microsoft/OpenAI, lo que reduce la
probabilidad de fallo simultáneo de los tres.

Patrón de implementación: espejar exactamente `AiExtractorService` (OpenAI).
Mismo prompt (`buildExtractionPrompt`), mismo refinamiento posterior
(`refineExtractionWithRawText`), mismo tracking de tokens
(`AiUsageMetrics`/`accumulateTokenUsage`) — solo cambia el SDK
(`@anthropic-ai/sdk` con `messages.create`) y el provider tag
(`"anthropic"`). Esto garantiza que la salida sea intercambiable con los
otros dos proveedores y que la deduplicación, canonización y matching
posteriores no necesiten ramas especiales por proveedor.

La key se configura por cliente vía `extractionConfigJson.anthropicApiKey`
(encriptada con `encrypt()`, igual que `geminiApiKey`/`openaiApiKey`), con
fallback a `env.ANTHROPIC_API_KEY` para el modo legacy. El modelo default
es `claude-haiku-4-5-20251001` (haiku 4.5, el más barato y rápido de la
familia Claude 4.x, alineado al uso "extracción simple, latencia baja").

### Alternativas descartadas
- **Anthropic primero, OpenAI último.** Descartado: Gemini sigue siendo el
  más barato por token y el primer eslabón natural. Reordenar habría
  encarecido el costo promedio sin ganancia funcional clara.
- **Wrapper genérico tipo "LLM router" (LiteLLM, Vercel AI SDK, etc.).**
  Descartado: agrega una abstracción extra que no resuelve un problema
  real en este pipeline (solo tres proveedores, mismo prompt, misma
  respuesta JSON). El patrón actual de tres servicios espejo es trivial
  de mantener y deja explícito qué SDK se usa en cada eslabón.
- **Reintentar Gemini/OpenAI con backoff antes de saltar al siguiente.**
  Descartado por ahora: cuando un proveedor responde con quota exceeded o
  con auth fail, reintentar no ayuda. El backoff se podría agregar más
  adelante si en producción aparecen errores transitorios recuperables.

### Impacto
- Archivos nuevos:
  - `src/services/claudeExtractor.service.ts` (servicio espejo de
    `AiExtractorService`).
- Archivos modificados:
  - `src/config/env.ts` — `ANTHROPIC_API_KEY` y `ANTHROPIC_MODEL` opcionales.
  - `src/types/client.types.ts` — `ClientExtractionConfig.anthropicApiKey`
    y `anthropicModel`.
  - `src/types/aiUsage.types.ts` — `AiProvider` extendido a `"anthropic"`.
  - `src/lib/clientProcessingConfig.ts` — `resolveAiConfig` desencripta
    y retorna la key/modelo de Anthropic.
  - `src/lib/logger.ts` — `pipelineLog.aiExtraction` admite `"anthropic"`.
  - `src/jobs/processPendingDocuments.job.ts` — tercer eslabón de fallback
    en el flujo PDF; `ProcessJobConfig.aiConfig` y `ProcessingContext`
    extendidos con `anthropicApiKey`/`anthropicModel`/`claudeModule`.
  - `src/app/api/client/consortiums/[id]/invoices/scan/route.ts` —
    tercer fallback en el scan manual.
  - `src/app/api/admin/clients/route.ts` (POST alta) y
    `src/app/api/admin/clients/[id]/route.ts` (GET/PATCH edición) —
    validación, encriptación y flag `hasAnthropicApiKey`.
  - `src/app/admin/clients/[id]/page.tsx` y `src/app/admin/page.tsx` —
    inputs nuevos en la UI.
- Sin cambios de schema Prisma: `extractionConfigJson` es JSON libre.
- Verificado con `npx tsc --noEmit` y `npm run build:jobs` en limpio.

---

## 2026-05-17 — Tag de imagen Docker con SHA del commit para rollbacks

### Problema
El step "Build and push image" en `.github/workflows/ci.yml` publicaba la imagen
únicamente como `ghcr.io/johnydeev/ia-drive-doc-processor:latest`. Cada push a
master sobreescribía el tag `:latest` en GHCR y se perdía la referencia
direccionable a la versión anterior. Si una release rompía algo en producción,
no había forma trivial de hacer rollback: no existía un tag estable apuntando al
build previo, y reproducirlo localmente no es práctico (depende del estado del
caché de Buildx, secretos y entorno del runner).

### Decisión
Pasar de un tag único a una lista YAML con dos tags por build:

```yaml
tags: |
  ghcr.io/johnydeev/ia-drive-doc-processor:latest
  ghcr.io/johnydeev/ia-drive-doc-processor:${{ github.sha }}
```

`docker/build-push-action@v6` empuja ambos tags en un único push (capas
compartidas, sin overhead de almacenamiento ni de tiempo). `:latest` sigue
siendo el tag mutable que consume el job `deploy`; el SHA es un tag inmutable
que queda para siempre asociado a ese commit específico.

Rollback manual ante un deploy malo:
```
docker pull ghcr.io/johnydeev/ia-drive-doc-processor:<sha_estable>
docker tag  ghcr.io/johnydeev/ia-drive-doc-processor:<sha_estable> \
            ghcr.io/johnydeev/ia-drive-doc-processor:latest
docker compose -p ia-drive-doc-processor up -d --force-recreate
```

### Alternativas descartadas
- **Tag por timestamp** (`:20260517-1830`): legible pero no trazable al commit;
  hay que cruzar con `git log` para saber qué cambió. El SHA es la única
  referencia que ya es canónica en GitHub.
- **Tag por número de run** (`${{ github.run_number }}`): se resetea si se
  recrea el workflow o se mueve a otro repo, y no tiene vínculo con el árbol
  de git.
- **Tag por versión semántica desde `package.json`**: requeriría disciplina de
  bump manual o release-please; hoy no hay versionado semántico en el repo.
- **Modificar el job `deploy` para usar SHA en vez de `:latest`**: el owner
  quiere mantener el deploy automático apuntando a `:latest`. El SHA queda
  disponible solo para rollback intencional.

### Impacto
- `.github/workflows/ci.yml`: único cambio (step "Build and push image" del job `build`).
- No afecta `deploy`, ni `docker-compose.yml`, ni los servicios `web/scheduler/worker`.
- A partir del próximo push a master habrá tags `:${{ sha }}` disponibles en GHCR.

---

## 2026-05-11 — Resumen agregado en el worker al vaciarse la cola

### Problema
El worker (`src/jobs/jobWorkerMain.ts`) corre un loop infinito de polling cada 2s y procesa jobs uno por uno. No tenía noción de "ciclo": cuando drenaba la cola, simplemente dormía 2s y volvía a buscar, sin emitir ningún resumen agregado. Operativamente no había forma de saber, de un vistazo en los logs, cuántos archivos terminó procesando en una tanda (procesados / sin asignar / duplicados / fallidos) — solo los logs individuales por job (`jobCompleted` / `jobFailed`).

### Decisión
Aprovechar la transición natural "tenía jobs → ahora cola vacía" como delimitador de ciclo. Cambios:

1. **`workerLog.cycleSummary()`** nuevo en `src/lib/logger.ts` con cuatro contadores: procesados, sin asignar, duplicados, fallidos (mismo orden y formato que `pipelineLog.batchSummary` y `schedulerLog.cycleSummary` para consistencia visual entre procesos).
2. **`handleJob()` retorna `ProcessJobSummary | null`** en lugar de `void`, para que el loop pueda acumular los contadores reales del summary del pipeline (no inferirlos a partir de success/failure del job).
3. **`runWorker()` mantiene 4 acumuladores** vivos entre iteraciones del `while (true)`. Solo se acumulan cuando `summary !== null` (es decir, el archivo llegó al pipeline). Los casos `clientNotFound` / `clientInactive` retornan null y no contaminan los contadores del ciclo.
4. **Gate `cycleProcessed + cycleFailed + cycleUnassigned > 0`**: evita imprimir resumen vacío en el caso degenerado donde solo hubo jobs con summary null (cliente eliminado/inactivo). Los duplicados solos no disparan el resumen porque siempre vienen acompañados de un `processed`.
5. **Reset post-emisión**: los 4 acumuladores vuelven a 0 antes del `sleep`, listos para el próximo ciclo.

### Alternativas descartadas
- **Contar jobs (no archivos)**: si un job representara N archivos, perderíamos granularidad. Como cada job procesa exactamente un archivo (`processSingleDriveFileJob`), los números coinciden, pero usar los contadores del `ProcessJobSummary` mantiene la semántica correcta si el pipeline cambia.
- **Emisión periódica (cada N segundos)**: rompe la lectura del log — un ciclo activo de 3 minutos podría imprimir varios resúmenes parciales del mismo lote.
- **Persistir el resumen en DB**: ya existe `ProcessingLog` por cliente vía `recordClientRun`. El requerimiento era visibilidad operativa en consola, no un nuevo registro de auditoría.
- **Contar el caso `summary === null` por excepción**: ese fallo no llegó al pipeline (cliente eliminado/inactivo), no es comparable a un fallo de procesamiento, y contaminaría el contador `failed`.

### Impacto
- Modificado: `src/lib/logger.ts` — método nuevo `workerLog.cycleSummary`
- Modificado: `src/jobs/jobWorkerMain.ts` — firma de `handleJob` retorna summary; acumuladores y emisión condicional en `runWorker`
- No se tocó: `src/jobs/scheduler.ts` ni `src/jobs/runProcessingCycle.ts`

---

## 2026-05-11 — Resumen del ciclo automático del scheduler

### Problema
El scheduler automático (`src/jobs/scheduler.ts`) encola jobs directamente sin pasar por `runProcessingCycle`, por lo que nunca emitía el "RESUMEN TOTAL DEL CICLO" que sí se imprime en los flujos manuales (`/api/process` y `/api/admin/scheduler/run`). Operativamente no había forma rápida de saber, mirando los logs, cuántos archivos se encontraron, cuántos se encolaron y cuántos ya estaban en cola en un ciclo dado.

### Decisión
Agregar un resumen específico para el scheduler automático sin tocar `runProcessingCycle` (cuya semántica de "ciclo de procesamiento manual" es distinta). Cambios:

1. **`schedulerLog.cycleSummary()`** nuevo método en `src/lib/logger.ts` con tres contadores: `totalFound`, `totalQueued`, `totalSkipped`.
2. **`runOnce()` en `src/jobs/scheduler.ts`** acumula los contadores:
   - `totalFound += files.length` por cada cliente con archivos pendientes.
   - `totalQueued += 1` al crear un nuevo `ProcessingJob`.
   - `totalSkipped += 1` cuando el archivo ya tiene un job `PENDING`/`PROCESSING` (no se cuenta el caso `existingInvoice` porque no es "ya en cola" sino "ya procesado").
3. **Gate `totalFound >= 1`**: si no se encontró ningún archivo, no se imprime nada — evita ruido en ciclos vacíos que ya tienen su propio log `clientNoPdfs`.

### Alternativas descartadas
- **Refactorizar el scheduler para reusar `runProcessingCycle`**: cambiaría la arquitectura scheduler-encola → worker-procesa, que es intencional (desacople).
- **Imprimir el resumen siempre**: ruido innecesario cuando no hay archivos.
- **Contar `existingInvoice` en `totalSkipped`**: confundiría "ya procesado" (estado terminal) con "ya en cola" (en progreso).

### Impacto
- Modificado: `src/lib/logger.ts` — método nuevo `schedulerLog.cycleSummary`
- Modificado: `src/jobs/scheduler.ts` — contadores + emisión condicional en `runOnce`
- No se tocó: `src/jobs/runProcessingCycle.ts` ni los endpoints `/api/process` ni `/api/admin/scheduler/run`

---

## 2026-04-15 — Fix lógica de deduplicación

### Problema
El pipeline marcaba como duplicados boletas con **distinto `boletaNumber`** pero **mismo monto y vencimiento**. Caso testigo: dos facturas mensuales de RANKO S.R.L. (0003-00154753 y 0003-00155282) con mismo monto y vencimiento idéntico se marcaban como duplicado, perdiendo la segunda. Además, los duplicados se persistían en DB con `isDuplicate=true` aunque el requerimiento era no guardarlos (solo registro en Sheets para auditoría).

El root cause estaba en `invoice.repository.ts::findDuplicateByBusinessKey`: el `WHERE` de Prisma usaba los 4 campos de la business key como condición obligatoria, pero cuando algún campo venía vacío ("") el query matcheaba contra filas que también tuvieran ese campo vacío, reduciendo el match efectivamente a los 2-3 campos poblados.

### Decisión
El `boletaNumber` es el identificador primario de una factura — si dos boletas tienen distinto `boletaNumber` son documentos distintos, sin excepción. Cambios:

1. **`WHERE` dinámico**: `findDuplicateByBusinessKey` ahora arma el `WHERE` incluyendo únicamente los campos no vacíos. Si `boletaNumber` está presente queda como condición obligatoria del match.
2. **Mínimo 2 campos**: para considerar un posible duplicado se requieren ≥ 2 campos presentes en la business key. Con solo 1 campo la heurística es demasiado débil.
3. **Nueva función `isDuplicateByPriority`** en `src/lib/businessKey.ts` para validar en memoria (dos `BusinessKeyParts`) con la misma regla: boletaNumber distinto → nunca duplicado.
4. **Duplicados no se persisten**: cuando `isDuplicate === true` el pipeline salta `saveProcessedInvoice`. Se mantiene la inserción en Sheets (columna L = "YES") y el move a Escaneados para auditoría, pero no se crea registro en DB.

### Alternativas descartadas
- **Mantener el `WHERE` estático y filtrar en código**: menos eficiente y duplicaría la lógica de comparación.
- **Usar la unique constraint `uq_invoice_business_key` de la DB**: no aplica porque el problema es detectar duplicados *antes* de insertar, no después.
- **Guardar duplicados con flag `isDuplicate=true`**: descartado por pedido explícito — los duplicados ensucian la DB y las queries de reporte tienen que filtrar el flag en todos lados.

### Impacto
- Modificado: `src/lib/businessKey.ts` — nueva función `isDuplicateByPriority`
- Modificado: `src/repositories/invoice.repository.ts` — `findDuplicateByBusinessKey` con `WHERE` dinámico y mínimo 2 condiciones
- Modificado: `src/jobs/processPendingDocuments.job.ts` — `saveProcessedInvoice` solo para no-duplicados
- Sin cambios de schema ni migraciones

---

## 2026-04-15 — Solapa Pagos en vista de consorcio

### Problema
La UI tenía una sola tabla que mezclaba visualización de boletas con estado de pago en una columna chica. Registrar pagos requería subir un recibo (endpoint `/receipt`) y no había forma de registrar pagos masivos ni sin PDF. Además, los medios de pago no eran consistentes ni tenían el banco del consorcio como contexto.

### Decisión
Separar la vista del consorcio en dos solapas: **Boletas** (sin cambios) y **Pagos** (nueva, inline editable). Los gastos no se pueden modificar desde Pagos y viceversa. El pago se registra inline en la tabla (no modal) y se confirma con GUARDAR en lote. 

Reglas:
- **Empleados** (`providerType = EMPLEADO`): solo editan fecha de pago — el importe siempre es el monto total (no se permiten pagos parciales a empleados).
- **Proveedores**: editan fecha + importe (vacío = saldo pendiente completo) + medio de pago (dropdown).
- **Medios de pago**: `Transferencia [BANCO]`, `Cheque propio [BANCO]` (cuando el consorcio tiene banco configurado), `Descuento`, `Efectivo`. Guardados como texto libre en `Payment.paymentMethod`.

Al guardar, la ruta `POST /api/client/invoices/:id/payments` crea el `Payment`, recalcula `isPaid`/`remainingBalance` y — si la boleta quedó totalmente pagada — actualiza la columna N ("ESTADO PAGO") en Google Sheets a "Pagado". La búsqueda de fila en Sheets usa `sourceFileUrl` como clave primaria, con fallback a `boletaNumber + providerTaxId`.

### Migración expand-contract
`Payment.driveFileId` y `Payment.driveFileUrl` pasan a opcionales (`String?`) porque los pagos desde la solapa Pagos no requieren adjuntar comprobante. Se agrega `Payment.paymentMethod String?` como texto libre.

### Alternativas descartadas
- **Enum `PaymentMethod`**: el set de opciones depende del banco del consorcio (dinámico) y textos como "Transferencia [GALICIA]" no caben en un enum. Texto libre con dropdown controlado en UI es más flexible.
- **Modal por pago**: lento para cargar pagos masivos del mes. La tabla editable + GUARDAR en lote es más eficiente.
- **Pago parcial a empleados**: descartado por pedido explícito del owner (los sueldos se pagan completos).

### Impacto
- Migración: `prisma/migrations/20260415000200_payment_optional_drive_add_payment_method`
- Modificado: `prisma/schema.prisma` — `Payment.driveFileId?`, `driveFileUrl?`, nuevo `paymentMethod`
- Modificado: `src/repositories/payment.repository.ts` — `CreatePaymentInput` con campos opcionales + `paymentMethod`
- Modificado: `src/app/api/client/invoices/[id]/payments/route.ts` — schema Zod, sync con Sheets
- Modificado: `src/app/api/client/consortiums/[id]/invoices/route.ts` — agrega `providerType` al response
- Modificado: `src/services/googleSheets.service.ts` — nuevo `updatePaymentStatus()`
- Modificado: `src/app/admin/consortiums/page.tsx` — tabs + componente `PagosView`
- Modificado: `src/app/admin/consortiums/page.module.css` — estilos tabs + pagos

---

## 2026-04-15 — Soporte de imágenes JPG/PNG en pipeline

### Problema
El scheduler solo detectaba PDFs. Imágenes JPG/PNG en la carpeta Pendientes eran ignoradas completamente. Algunos proveedores envían fotos de facturas en lugar de PDFs.

### Decisión
Extender el filtro de mimeType en GoogleDriveService para incluir image/jpeg e image/png. En el pipeline, cuando el archivo es una imagen, saltear pdf-parse y OCR y usar Gemini Vision directamente con el buffer de la imagen. El flujo de matching, deduplicación y movimiento de archivos permanece igual. `lspProvider` queda como `null` para imágenes (no tiene sentido correr el router LSP sin texto).

### Alternativas descartadas
- **Convertir imagen a PDF primero**: agrega complejidad y dependencia (ImageMagick), sin beneficio real ya que Gemini Vision procesa imágenes nativamente.
- **OCR con Tesseract sobre la imagen**: peor calidad que Gemini Vision directo.

### Impacto
- Modificado: `src/services/googleDrive.service.ts` — query mimeType ampliado
- Modificado: `src/services/geminiExtractor.service.ts` — `extractStructuredDataFromImage()`
- Modificado: `src/jobs/processPendingDocuments.job.ts` — detección `isImage`, rama visual
- Modificado: `ProcessDriveFileInput` — nuevo campo `mimeType`

---

## 2026-04-15 — Empleados de consorcio como tipo de proveedor

### Problema
Los consorcios tienen empleados (encargados) cuyos recibos de haberes necesitan ser trackeados igual que las facturas de proveedores. Los recibos tienen estructura diferente: CUIL en lugar de CUIT, neto a cobrar en lugar de importe total, período de liquidación.

### Decisión
Extender la tabla Provider con un campo `providerType` (enum PROVEEDOR/EMPLEADO) en lugar de crear una tabla Employee separada. Los empleados se dan de alta en la misma hoja `_Proveedores` del archivo ALTA con una columna TIPO. El pipeline detecta recibos de haberes por keywords (`isReciboHaberes()`) y usa un prompt dedicado que extrae CUIL y neto a cobrar correctamente.

### Alternativas descartadas
- **Tabla Employee separada**: requiere migración más compleja, duplica infraestructura de matching y Sheets. El modelo de datos es el mismo.
- **Campo libre en matchNames**: poco explícito y no permite filtrar en UI.

### Impacto
- Migración: `20260415000100_add_provider_type`
- Modificado: `src/services/googleSheets.service.ts` (DirectoryData, readDirectory, header TIPO)
- Modificado: `src/app/api/client/sync-directory/route.ts` (providerType en upsert)
- Modificado: `src/lib/extraction.ts` (isReciboHaberes, buildReciboHaberesPrompt)
- Modificado: `src/app/admin/consortiums/page.tsx` (badge EMPLEADO, label CUIL)

---

## 2026-04-14 — Fallback visual Gemini Vision para emisor en imagen

### Problema
Facturas generadas con GESTIONPRO tienen el bloque del emisor (nombre, CUIT) en imagen vectorial no seleccionable. pdf-parse y Tesseract no capturan ese texto. El pipeline terminaba en Sin Asignar aunque el consorcio sí matcheaba.

### Decisión
Agregar un paso de fallback visual como ÚLTIMA instancia antes de Sin Asignar. Condiciones estrictas para activarlo: proveedor no encontrado (unassigned=true), consorcio sí encontrado (consortiumId!=null), bloque emisor no detectado (hasEmitterBlock=false), PNG disponible del OCR, y geminiModule configurado. Gemini recibe el PNG y un prompt focalizado solo en identificar el emisor. Si retorna datos, se reintenta resolveAssignment. Si falla por cualquier razón, fallo silencioso y el flujo continúa normal.

### Alternativas descartadas
- **Siempre enviar imagen a Gemini**: desperdicio de tokens y latencia en facturas que ya se procesan bien con texto.
- **OCR más agresivo (Tesseract con configuración especial)**: el bloque es una imagen vectorial embebida, Tesseract la captura parcialmente pero no de forma confiable.

### Impacto
- Modificado: `src/services/pdfTextExtractor.service.ts` — `getLastOcrPng()`, `getLastHasEmitterBlock()`
- Modificado: `src/services/ocr.service.ts` — `getLastFirstPagePng()`
- Modificado: `src/services/geminiExtractor.service.ts` — `extractProviderFromImage()`
- Modificado: `src/jobs/processPendingDocuments.job.ts` — bloque fallback visual
- Sin cambios de schema ni migraciones
- Opt-in automático: solo se activa cuando las condiciones lo justifican

---

## 2026-04-13 — Modo Debug por cliente usando extractionConfigJson

### Problema
Diagnosticar problemas de extracción (OCR confuso, Gemini confundiendo emisor/receptor, etc.) requería agregar logs temporales al pipeline, deployar, y luego removerlos. Sin un mecanismo de debug on-demand, cada incidente requería un ciclo de deploy.

### Decisión
Agregar un flag `debugMode` dentro de `extractionConfigJson` (campo JSON flexible existente en Client). Cuando está activo, el pipeline logea:
1. El texto completo post-OCR (después de la re-extracción de página 1 para LSPs)
2. La respuesta raw de la extracción IA (Gemini/OpenAI)

Se controla desde el panel admin con un toggle por cliente (botón en la tabla de métricas). El endpoint `PATCH /api/admin/clients/[id]/debug-mode` solo requiere rol ADMIN.

### Alternativas descartadas
- **Variable de entorno global**: afectaría todos los clientes, no se puede activar selectivamente.
- **Campo dedicado en schema**: requiere migración innecesaria — el JSON flexible ya existe.

### Impacto
- Nuevo: `src/app/api/admin/clients/[id]/debug-mode/route.ts`
- Modificado: `src/jobs/processPendingDocuments.job.ts` — campo `debugMode` en `ProcessJobConfig`, logs condicionales
- Modificado: `src/jobs/runProcessingCycle.ts` y `src/jobs/jobWorkerMain.ts` — propagan `debugMode`
- Modificado: `src/app/api/admin/audit/clients/route.ts` — incluye `debugMode` en respuesta
- Modificado: `src/app/admin/page.tsx` — toggle en tabla de clientes

---

## 2026-04-09 — Lock de archivo vía carpeta Procesando en Drive

### Problema
Race condition entre ciclos concurrentes: un run manual y el scheduler podían empezar al mismo tiempo, listar Pendientes, y tomar el mismo PDF antes de que el primero lo moviera a Escaneados. Resultado: doble procesamiento, doble inserción en Sheets (con la dedup por hash/business key como único colchón — no siempre suficiente si el segundo ciclo llega antes de guardar el Invoice).

### Decisión
Usar una carpeta intermedia "Procesando" como lock atómico a nivel Drive:

1. Nuevo campo opcional `processing` en `driveFoldersJson` (sin migración — el JSON es flexible).
2. Tras descargar el PDF, el pipeline lo mueve inmediatamente a `processing` con `moveFileToFolder`. La operación de Drive es atómica: si dos ciclos intentan moverlo, solo uno gana.
3. Los movimientos finales (Escaneados / Sin Asignar / Fallidos) usan `processingFolderId ?? drivePendingFolderId` como carpeta origen. Cuando el lock está activo, vienen desde Procesando; si no hay lock configurado, cae al comportamiento legacy desde Pendientes.
4. El move al lock está en try/catch: si falla (permisos, carpeta inexistente), se loguea warning y el procesamiento continúa desde Pendientes. Esto hace el feature opt-in y no bloqueante para clientes existentes.

### Alternativas descartadas
- **Lock en DB (flag `processing` en un registro)**: requiere migración, agrega dependencia transaccional y no protege contra crashes del worker (lock huérfano).
- **Lista de IDs in-memory en cada ciclo**: no protege contra múltiples procesos (scheduler + worker son containers separados).
- **Advisory lock de PostgreSQL**: añade acoplamiento y no es visible desde Drive (más difícil de diagnosticar).

### Impacto
- Modificado: `src/types/client.types.ts` — campo `processing?: string | null` en `ClientDriveFolders`
- Modificado: `src/lib/clientProcessingConfig.ts` — `ResolvedFolders.processing` + `resolveFolders()`
- Modificado: `src/jobs/processPendingDocuments.job.ts` — `ProcessJobConfig.driveProcessingFolderId`, move al lock post-download, origen de movimientos finales
- Modificado: `src/jobs/runProcessingCycle.ts` y `src/jobs/jobWorkerMain.ts` — pasan `folders.processing` al config
- Sin cambios de schema ni migraciones
- Opt-in: clientes existentes siguen funcionando sin configurar `processing`

---

## 2026-04-09 — Fix providerId/providerTaxId en LSP fast path

### Problema
El LSP fast path resolvía correctamente consortiumId y lspServiceId pero no asignaba providerId ni providerTaxId al Invoice. Quedaban NULL aunque el LspService ya tuviera su FK a Provider resuelta.

### Decisión
En el fast path, después de encontrar el LspService, incluir `providerRef` en el query para obtener id, cuit y paymentAlias del Provider. Usar cascada: primero el CUIT lookup (ya existente), luego la FK del LspService como fallback. Sin campos nuevos en AssignmentResult — el campo `providerId` existente ya servía, solo no se estaba poblando correctamente.

### Impacto
- Modificado: `processPendingDocuments.job.ts`
- Sin cambios de schema ni migraciones

---

## 2026-04-09 — Mapa router→canonicalName para LspService lookup

### Problema
El router `identifyLSPProvider()` usa nombres cortos ("PERSONAL", "EDESUR") mientras que en LspService los proveedores se cargan con razón social completa ("TELECOM ARGENTINA S.A.", "EDESUR S.A."). El lookup por `providerName` fallaba silenciosamente.

### Decisión
Constante `LSP_ROUTER_TO_CANONICAL` que mapea cada nombre del router a su razón social canónica. Se aplica antes del fallback lookup por nombre en LspService. El lookup por `providerId` (FK) no cambia — es más robusto y no necesita el mapa.

### Impacto
- Modificado: `processPendingDocuments.job.ts`
- Sin cambios de schema ni migraciones

---

## 2026-04-09 — Rename LspService.provider → providerName

### Problema
El campo `provider` en LspService era ambiguo — mismo nombre que la tabla Provider. Con la adición de `providerId` como FK, tener `provider` (texto) y `providerId` (FK) era confuso. `providerName` clarifica que es el nombre en texto.

### Decisión
Rename provider→providerName. Expand-contract para zero-downtime. La tabla Provider no se toca — es un rename de columna solamente.

### Impacto
- Migración: `20260409000200_rename_lspservice_provider`
- Modificados: schema.prisma, processPendingDocuments.job.ts, sync-directory/route.ts, lsp-services/route.ts, consortiums/page.tsx

---

## 2026-04-09 — Fix resolución providerId en sync-directory LspServices

### Problema
Al sincronizar la hoja _LspServices desde el archivo ALTA, el campo providerId quedaba NULL aunque el proveedor existiera en la tabla Provider con el mismo canonicalName. No había warning visible cuando el match fallaba.

### Decisión
Mantener ambos campos en LspService: provider (texto, para el pipeline) y providerId (FK, para integridad referencial). Agregar warning cuando providerId no se resuelve. Incluir paso retroactivo al final del bloque que resuelve providerId NULL en registros históricos en cada sync.

### Impacto
- Modificado: src/app/api/client/sync-directory/route.ts
- Sin cambios de schema ni migraciones

---

## 2026-04-09 — Fix normalización clientNumber con espacios internos

### Problema
La normalización de clientNumber solo eliminaba ceros a la izquierda. Edenor formatea el número de cuenta con espacios (ej: "8 620 004 726") mientras la DB lo guarda sin espacios. El lookup de LspService fallaba silenciosamente y lspServiceId quedaba NULL.

### Decisión
Normalización en dos pasos: primero `.replace(/\s+/g, "")` para eliminar todos los espacios, luego `.replace(/^0+/, "")` para eliminar ceros. Aplicado en los 3 puntos donde se procesa clientNumber: pipeline, sync-directory y endpoint UI.

### Impacto
- Modificados: `processPendingDocuments.job.ts`, `sync-directory/route.ts`, `lsp-services/route.ts`
- Sin cambios de schema ni migraciones

---

## 2026-04-09 — Bloqueo de boletas LSP con clientNumber no registrado

### Problema
El pipeline procesaba boletas LSP aunque el clientNumber extraído no existiera en la tabla LspService. Esto generaba boletas en Sheets sin vínculo al servicio correcto.

### Decisión
Si se detecta lspProvider y el lookup de LspService falla → `unassigned: true` con razón descriptiva. El archivo se mueve a Sin Asignar en Drive. No se guarda Invoice ni se escribe en Sheets. El administrador debe cargar el LspService correspondiente y luego usar "Reprocesar Sin Asignar".

### Impacto
- Modificados: `processPendingDocuments.job.ts`, `logger.ts`
- Sin cambios de schema ni migraciones

---

## 2026-04-09 — Convención de nombres de campos en inglés

### Problema
Los campos `banco` y `claveSuterh` se crearon en español, inconsistente con el resto del schema (`canonicalName`, `matchNames`, `paymentAlias`, etc.).

### Decisión
Todos los campos nuevos del schema usan camelCase en inglés. Rename `banco`→`bank`, `claveSuterh`→`suterhKey`. El header visible en Sheets ("BANCO") no cambia — es presentación, no schema.

### Impacto
- Migración: `20260409000100_rename_consortium_banco_suterh`
- Modificados: `schema.prisma` + todos los archivos que referenciaban `banco`/`claveSuterh`

---

## 2026-04-07 — Campos banco y claveSuterh en Consortium

### Problema
Los consorcios necesitan registrar el banco asociado (visible en Sheets) y la clave SUTERH (dato interno).

### Decisión
Dos campos nullable en Consortium. Solo `banco` va a Sheets (columna O). `claveSuterh` es dato interno sin UI por ahora. Sin UI de edición en esta iteración.

### Impacto
- Migración: `20260407000100_add_consortium_banco_suterh`
- Modificados: `schema.prisma`, `googleSheets.service.ts`, `clientProcessingConfig.ts`, `processPendingDocuments.job.ts`, `invoices/route.ts`, `extractedDocument.types.ts`

---

## 2026-04-04 — Refactor layout 3 columnas + modal configuracion

### Problema
El layout fusionaba navSidebar y lista de consorcios en un solo `<aside>`, lo que hacía que colapsar el nav también ocultara la lista. Además, la edicion de matchNames estaba inline ocupando espacio permanente en el área de contenido.

### Decision
Separar en 3 columnas independientes: navSidebar (colapsable, 220px/56px) | sidebar de consorcios (fija 220px) | contenido. La lista de consorcios ya no depende del estado colapsado del nav. La edicion de matchNames se movió a un modal de configuración accesible via botón "Configuración" en detailActions. El botón "Cerrar sesión" se reubicó al fondo del navSidebar con un spacer flex. En mobile (≤1024px) el sidebar de consorcios se oculta (los consorcios se acceden via el nav mobile).

### Impacto
- Modificados: `page.tsx`, `page.module.css`
- Nuevas clases CSS: `.sidebar`, `.contentCol`, `.configBtn`, `.configSection`, `.configSectionTitle`, `.configSectionDesc`
- Nuevo estado: `showConfigModal`
- Sin cambios de schema ni migraciones

---

## 2026-04-04 — Correcciones UX consorcios + fix build CSS Modules

### Problema
5 bugs en page.tsx de consorcios: sidebar duplicado, boletas sin renderizar (page flex-direction:column rompia el layout row), monto total concatenado (Prisma Decimal + number = string), tabla LSP sin badge identificador, toggle de tema sin efecto en DOM. Ademas, build roto por selectores globales `[data-theme]` en CSS Modules.

### Decision
Correccion de reduce() para sumar Decimals con `Number()`. Badge visual "LSP" en la columna proveedor. useEffect para aplicar `data-theme` al `document.documentElement`. Variables de tema movidas a globals.css (CSS Modules no permite selectores globales).

### Impacto
- Modificados: `page.tsx`, `page.module.css`, `globals.css`
- Sin cambios de schema ni migraciones

---

## 2026-04-02 — Sistema de pagos parciales: tabla Payment separada

### Problema
Las boletas (Invoice) podían tener un único comprobante de pago (`receiptDriveFileId`/`receiptDriveFileUrl`) pero no soportaban pagos parciales ni cuotas.

### Decisión
Tabla `Payment` separada (one-to-many con Invoice) en lugar de agregar campos de pago directamente a Invoice. Dos modos: cuotas pactadas (monto total / N cuotas, autoincremento) y pagos libres (monto manual). El modo se define en el primer pago y es inmutable. `isPaid` y `remainingBalance` en Invoice se actualizan automáticamente en cada transacción. El último pago de cuotas ajusta el monto para absorber redondeos.

### Alternativas descartadas
- Campos de pago directo en Invoice: no soporta múltiples pagos.
- Tabla Payment + tabla Installment separada: overengineering; `installmentNumber`/`totalInstallments` en Payment es suficiente.

### Impacto
- Migración: `20260402000200_add_payment_tracking`
- Nuevos archivos: `payment.repository.ts`, `invoices/[id]/payments/route.ts`, `invoices/[id]/payments/[paymentId]/route.ts`
- Modificados: `schema.prisma`, `page.tsx` (consortiums), `receipt/route.ts`
- Eliminados de Invoice: `receiptDriveFileId`, `receiptDriveFileUrl`

---

## 2026-04-02 — CUITs alternativos de consorcio en matchNames

### Problema
Algunos consorcios tienen más de un CUIT (ej: re-inscripción en AFIP). El schema solo soporta un campo `cuit` por consorcio. Cuando una factura usa el CUIT alternativo, el matching por CUIT falla y el archivo va a Sin Asignar.

### Decisión
Reutilizar el campo `matchNames` para almacenar CUITs alternativos (pipe-separated junto con aliases de nombre). El pipeline detecta si un valor en `matchNames` tiene formato CUIT (10+ dígitos numéricos tras normalización) y lo incluye en el matching por CUIT de allTaxIds. Sin migración — reutiliza infraestructura existente.

### Uso
En el archivo ALTA de Google Sheets, agregar el CUIT alternativo en la columna Aliases del consorcio: "30-71893736-8" (se guarda en matchNames).

### Alternativas descartadas
- Campo `cuitAlt` en schema: más limpio semánticamente pero requiere migración y cambios en sync-directory.
- Actualizar el CUIT principal: no aplica cuando ambos CUITs son válidos simultáneamente.

### Impacto
- Modificado: `src/jobs/processPendingDocuments.job.ts` (matching CUIT consorcio)
- Sin cambios en schema ni migraciones

---

## 2026-04-02 — OCR híbrido para PDFs con bloque emisor en imagen

### Problema
PDFs como Ikarus Seguridad tienen el bloque del emisor (nombre, CUIT) renderizado como imagen dentro del PDF. pdf-parse extrae el texto del cuerpo pero omite la imagen. El resultado no está vacío, por lo que el fallback a Tesseract no se activaba. La IA recibía texto sin CUIT del emisor y extraía proveedor=null.

### Decisión
Implementar detección semántica del bloque emisor AFIP en `pdfTextExtractor.service.ts`: si el texto extraído no contiene etiquetas exclusivas del emisor ("ING. BRUTOS", "INICIO DE ACTIVIDADES", "RESPONSABLE INSCRIPTO", "MONOTRIBUTO"), se activa OCR con pdftoppm + Tesseract. Los textos se combinan con separador `--- OCR ---`. OcrService reescrito para usar pdftoppm (poppler-utils) en lugar de pdfjs-dist + @napi-rs/canvas. Fallo silencioso: si OCR falla, el pipeline continúa con texto de pdf-parse.

### Impacto
- Reescrito: `src/services/ocr.service.ts` (pdftoppm en lugar de pdfjs-dist)
- Modificado: `src/services/pdfTextExtractor.service.ts` (detección bloque emisor + try/catch)
- Modificado: `Dockerfile` (agregado `poppler-utils`)

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
