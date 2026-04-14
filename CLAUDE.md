# CLAUDE.md — drive-doc-processor
Contexto completo del proyecto para Claude Code. Actualizado al 26/03/2026.
---
## Al iniciar sesión
Siempre leer docs/progreso.md antes de empezar para entender el estado actual del proyecto y los próximos pasos.
---
## ⚠️ Regla obligatoria de documentación
**Aplica a TODO contexto de desarrollo de software, sin excepciones.**
Cada vez que se realice un cambio significativo en el proyecto — ya sea una feature nueva, un bugfix, una refactorización, o una decisión de arquitectura — se DEBEN actualizar los siguientes archivos antes de considerar el trabajo terminado:
### `docs/progreso.md`
Registro vivo del estado de cada feature y tarea. Documenta:
- Qué se completó y cuándo
- Qué está en progreso y su estado actual
- Qué queda pendiente, con prioridad
- Problemas conocidos y workarounds
Actualizar este archivo es OBLIGATORIO al completar o avanzar cualquier tarea.
### `docs/decisiones.md`
Registro de decisiones técnicas tomadas ante problemas reales. Cada entrada documenta:
- **Fecha** del cambio
- **Problema** que se encontró (qué estaba fallando y por qué)
- **Decisión** que se tomó (qué se hizo y la razón técnica)
- **Alternativas descartadas** (si aplica)
- **Impacto** (qué archivos cambiaron, qué mejoró)
Actualizar este archivo es OBLIGATORIO cuando se toma una decisión de diseño o se resuelve un problema que otros desarrolladores (o el mismo contexto en el futuro) necesiten entender.
### `CHANGELOG.md`
Registro cronológico de cambios por fecha. Incluir highlights de lo que se hizo en cada sesión de trabajo.
> **La documentación no es opcional ni es "lo último que se hace". Es parte del entregable.** Si no se actualizaron estos 3 archivos, el trabajo no está terminado.
---
## Descripción del proyecto
Sistema multi-tenant en **Next.js + TypeScript + Prisma + PostgreSQL (Supabase)** para administración de consorcios de propiedad horizontal en Argentina.
Procesa automáticamente PDFs de facturas/boletas desde Google Drive usando IA (Gemini → OpenAI fallback), extrae datos estructurados, los guarda en la DB y los envía a Google Sheets.
---

## Arquitectura del sistema
### Tres procesos
| Proceso | Comando | Responsabilidad |
|---------|---------|-----------------|
| Web/API | `npm run dev` | UI + endpoints REST + autenticación |
| Scheduler | `npm run schedule` | Escanea Drive → crea ProcessingJob |
| Worker | `npm run worker` | Procesa cola → extrae → guarda → Sheets |
### Estructura de directorios relevante
```
src/
├── app/
│   ├── api/
│   │   ├── auth/              # login / logout / me
│   │   ├── admin/
│   │   │   ├── clients/       # CRUD clientes (admin)
│   │   │   │   └── [id]/      # GET + PATCH edición de cliente
│   │   │   │       └── purge/ # GET (preview count) + DELETE (purga completa)
│   │   │   ├── audit/         # logs de auditoría
│   │   │   └── scheduler/     # control scheduler
│   │   └── client/
│   │       ├── consortiums/   # CRUD + periods + invoices + scan + receipt
│   │       ├── providers/     # CRUD proveedores
│   │       ├── rubros/        # CRUD rubros (nivel cliente)
│   │       ├── coeficientes/  # CRUD coeficientes (nivel cliente)
│   │       ├── periods/
│   │       │   └── close-all/ # preview (GET) + execute (POST) cierre general
│   │       ├── sync-directory/ # POST: sincroniza archivo ALTA (Sheets → DB)
│   │       └── import/        # importación Excel (+ template)
│   └── admin/
│       ├── consortiums/       # UI principal de gestión
│       ├── clients/
│       │   └── [id]/          # UI edición de configuración de cliente
│       └── page.tsx           # Panel admin principal
├── jobs/
│   ├── processPendingDocuments.job.ts  # ← PIPELINE PRINCIPAL
│   ├── scheduler.ts
│   └── jobWorkerMain.ts
├── lib/
│   ├── extraction.ts           # Router LSP + prompts por empresa + prompt facturas
│   ├── consortiumNormalizer.ts # Normalización + fuzzy + alias match + limpieza LSP
│   ├── businessKey.ts          # Normalización de montos para deduplicación
│   └── clientProcessingConfig.ts
├── services/
│   ├── googleDrive.service.ts
│   ├── googleSheets.service.ts  # readDirectory() para sync ALTA
│   ├── geminiExtractor.service.ts
│   └── aiExtractor.service.ts
└── repositories/
    ├── consortium.repository.ts
    ├── invoice.repository.ts
    └── provider.repository.ts
```
---
## Schema de base de datos
```
Client          → Tenant. Roles: ADMIN / CLIENT / VIEWER. consortiumsEnabled (feature gate). batchSize (PDFs por ciclo)
  ├── Consortium  → Edificio. canonicalName + rawName + cuit + matchNames + paymentAlias
  │   ├── Period    → Período mensual. status: ACTIVE / CLOSED
  │   └── LspService → Servicio de empresa pública. provider + clientNumber + description
  ├── Provider    → Proveedor. canonicalName + cuit + matchNames + paymentAlias
  ├── Rubro       → Categoría de gasto (nivel cliente). name + description?
  ├── Coeficiente → Coeficiente de liquidación (nivel cliente). code + name
  ├── Invoice     → Boleta procesada. Liga a Consortium + Provider + Period + LspService?
  │                 lspServiceId / paymentMethod (nullable)
  │                 receiptDriveFileId / receiptDriveFileUrl (recibo de pago)
  │                 tokensInput / tokensOutput / tokensTotal / aiProvider / aiModel (IA tracking)
  ├── Receipt     → Recibo de pago (modelo separado, relacionado 1:1 con Invoice)
  ├── ProcessingJob → Cola de jobs (PENDING/PROCESSING/COMPLETED/FAILED)
  ├── SchedulerState → Estado runtime del scheduler por cliente
  │                    lastDirectorySyncAt: última sincronización ALTA
  ├── ProcessingLog  → Historial de ejecuciones
  └── TokenUsage     → Consumo de tokens IA por run
```
> **Nota:** Rubro y Coeficiente son a nivel CLIENT (no por consorcio).
### Campos importantes en Invoice
- `boletaNumberNorm`, `providerTaxIdNorm`, `dueDateNorm`, `amountNorm` → business key para deduplicación
- `isDuplicate` → flag (sigue yendo a Sheets, no se mueve en Drive)
- `tipoGasto` → enum: ORDINARIO / EXTRAORDINARIO / PARTICULAR
- `tipoComprobante` → string libre (A, B, C, Ticket, Recibo, etc.)
- `lspServiceId` → FK nullable a LspService (vincula factura LSP con servicio específico)
- `paymentMethod` → enum nullable: DEBITO_AUTOMATICO / TRANSFERENCIA / EFECTIVO
- `receiptDriveFileId` / `receiptDriveFileUrl` → recibo de pago adjunto manualmente desde UI
### Campos importantes en LspService
- `provider` → nombre normalizado de la empresa (EDESUR, AYSA, EDENOR, METROGAS, NATURGY, CAMUZZI, LITORAL_GAS, PERSONAL)
- `clientNumber` → número de cliente/cuenta en esa empresa
- `description` → opcional (ej: "Edificio", "Local 1", "Encargado")
- Unique constraint: `(consortiumId, provider, clientNumber)`
- El pipeline busca por `clientId + provider + clientNumber` tras la extracción IA
### Campos importantes en Consortium
- `matchNames` → nombres alternativos separados por `|` para matching interno con LSP (Edesur, AySA, etc.)
  - Ejemplo: `"BROWN ALMTE AV 708|ALMIRANTE BROWN 708"`
  - Campo interno — **no se muestra en la UI**
- `paymentAlias` → alias visible en la UI y en la columna "ALIAS" de Google Sheets
### Campos importantes en Provider
- `matchNames` → nombres alternativos separados por `|` para matching interno
  - Campo interno — **no se muestra en la UI**
- `paymentAlias` → alias visible en la UI (label "Alias") y escrito en la columna "ALIAS" de Google Sheets
  - Si no tiene valor, la celda de Sheets queda vacía
### googleConfigJson por cliente
```json
{
  "clientEmail":   "...",
  "privateKey":    "[ENCRYPTED]",
  "sheetsId":      "ID_ARCHIVO_DATOS",
  "altaSheetsId":  "ID_ARCHIVO_ALTA",
  "geminiApiKey":  "[ENCRYPTED]",
  "openaiApiKey":  "[ENCRYPTED]"
}
```
- `sheetsId` → archivo de boletas (Datos)
- `altaSheetsId` → archivo ALTA separado para sync de directorio (Consorcios, Proveedores, Rubros, Coeficientes)
- `privateKey`, `geminiApiKey`, `openaiApiKey` se guardan **encriptados** en DB. Usar `resolveGoogleConfig(client)` para obtenerlos desencriptados.
---
## Feature: Sincronización Directorio ALTA (Sheets → DB)
### Flujo
1. Usuario crea un archivo Google Sheets llamado **"ALTA"** en Drive, lo comparte con la service account.
2. Configura el `altaSheetsId` en el panel (botón **Editar** por cliente → campo "ID archivo ALTA").
3. Aprieta **"Sincronizar directorio"** en el panel → la app lee el archivo ALTA → upserta en DB.
4. Primera sincronización: si las hojas no existen se crean automáticamente con encabezados.
5. El usuario carga datos y vuelve a sincronizar.
### Formato del archivo ALTA (5 hojas)
| Hoja | Col A | Col B | Col C | Col D |
|---|---|---|---|---|
| `_Consorcios` | NOMBRE CANÓNICO | CUIT | NOMBRES ALTERNATIVOS (separado por `\|`, interno) | ALIAS (visible en UI) |
| `_Proveedores` | NOMBRE CANÓNICO | CUIT | NOMBRES ALTERNATIVOS (separado por `\|`, interno) | ALIAS (visible en UI) |
| `_Rubros` | NOMBRE | DESCRIPCIÓN (opcional) | — | — |
| `_Coeficientes` | NOMBRE | CÓDIGO | — | — |
| `_LspServices` | NOMBRE CANÓNICO (consorcio) | PROVEEDOR (normalizado) | NRO CLIENTE | DESCRIPCIÓN (opcional) |
### Estrategia de sync por entidad
- **Rubro / Coeficiente / LspService**: reemplazo total (`deleteMany` + `createMany`).
- **Consortium / Provider**: upsert + intento de delete de huérfanos. Si la FK falla → warning (no error fatal).
- **LspService**: resuelve `consortiumId` buscando por `canonicalName` dentro del `clientId`. Si no encuentra → warning.
### Archivos clave
- `src/services/googleSheets.service.ts` → método `readDirectory()`: lee las 5 hojas, auto-crea las faltantes, retorna `DirectoryData`.
- `src/app/api/client/sync-directory/route.ts` → POST endpoint. Usa `resolveGoogleConfig(client)` para desencriptar la private key.
- `src/services/schedulerControl.service.ts` → propaga `lastDirectorySyncAt` en `toRuntimeState()`.
### Bug crítico resuelto
Siempre usar `resolveGoogleConfig(client)` para construir el `GoogleSheetsService` del archivo ALTA.
**Nunca** pasar `client.googleConfigJson.privateKey` directo — está encriptada → error `error:1E08010C:DECODER routines::unsupported`.
---
## Pipeline de procesamiento (processPendingDocuments.job.ts)
1. **Download** PDF desde Drive
2. **Dedup hash** → SHA256 del binario
3. **Extracción texto** → pdf-parse → fallback OCR (tesseract)
4. **Extracción IA** → Gemini → fallback OpenAI → fallback OCR_ONLY
5. **Dedup business key** → boletaNumber + providerTaxId + dueDate + amount
6. **Resolve assignment** → match consorcio + proveedor + período activo del consorcio
7. **Canonización** → reemplazar datos OCR por datos canónicos de DB
8. **LspService lookup** → si es LSP y tiene clientNumber, buscar en tabla LspService
9. **Insert Sheets** → fila con monto formateado en es-AR ($ 118.000,00) + período (MM/YYYY)
10. **Mover archivo** → Escaneados (ok) / Sin Asignar (no matcheó)
11. **Guardar Invoice** + métricas (con lspServiceId y paymentMethod si aplica)
### Matching de consorcio (3 niveles, en orden)
1. **Exacto** → `normalizeConsortiumName(rawOcr) === canonicalName`
2. **Fuzzy** → todos los tokens de `canonicalName` aparecen en `rawOcr`
3. **Alias** → el rawOcr coincide con algún alias registrado en `consortium.aliases`
### Matching de proveedor (3 niveles)
1. **CUIT normalizado** (solo dígitos) — excluye el CUIT del consorcio
2. **Nombre exacto** o alias normalizado
3. **Nombre parcial** (substring)
---
## Extracción IA (src/lib/extraction.ts)
El sistema detecta automáticamente el tipo de documento con `identifyLSPProvider()` y rutea al prompt específico de cada empresa.
### Router LSP: `identifyLSPProvider(text)`
Analiza los primeros 4000 caracteres y retorna:
- `"EDESUR"` / `"EDENOR"` / `"AYSA"` / `"METROGAS"` / `"NATURGY"` / `"CAMUZZI"` / `"LITORAL_GAS"` / `"ABSA"` / `"PERSONAL"` → prompt específico
- `"GENERIC_LSP"` → prompt genérico LSP (fallback)
- `null` → no es LSP → usa `buildInvoicePrompt` (facturas normales)
### Prompts por empresa implementados
| Empresa | Función | CUIT hardcodeado |
|---------|---------|-----------------|
| Edesur | `buildEdesurPrompt()` | 30-65511651-2 |
| Edenor | `buildEdenorPrompt()` | 30-65511620-2 |
| AySA | `buildAysaPrompt()` | 30-70956507-5 |
| Metrogas | `buildGasPrompt()` | 30-65786442-4 |
| Naturgy | `buildGasPrompt()` | 30-53330905-7 |
| Camuzzi | `buildGasPrompt()` | 30-65786613-3 |
| Litoral Gas | `buildGasPrompt()` | 30-66176173-2 |
| Personal | `buildPersonalPrompt()` | 30-63945373-8 |
| Genérico LSP | `buildGenericUtilityBillPrompt()` | — |
| Facturas normales | `buildInvoicePrompt()` | — |
### Reglas compartidas entre prompts LSP
- **CUIT**: cada prompt indica explícitamente el CUIT de la empresa y advierte que el CUIT del cliente/consorcio NO debe usarse como providerTaxId.
- **Dirección**: reglas unificadas en `CONSORTIUM_ADDRESS_RULES` para limpiar ceros, sufijos, CP, piso/depto.
- **Fechas inválidas**: reglas en `INVALID_DATE_RULES` compartidas (CESP, CAE, emisión, próxima liquidación).
- **clientNumber**: cada prompt LSP indica dónde buscar el número de cliente específico de esa empresa.
- **paymentMethod**: reglas compartidas en `PAYMENT_METHOD_RULES` (DEBITO_AUTOMATICO, TRANSFERENCIA, EFECTIVO, null).
### Extracción limitada a página 1 para LSP
Cuando `identifyLSPProvider()` detecta un LSP, el pipeline re-extrae el texto limitando a la primera página (`{ max: 1 }` en pdf-parse). Esto reduce ruido y mejora la precisión de la extracción IA.
### Facturas normales (`buildInvoicePrompt`)
- `providerTaxId` = CUIT del **emisor** (NO el del consorcio receptor)
- `dueDate` = fecha de **pago** (NO fecha CAE, NO inicio de actividades)
- `amount` = Importe Total (nunca un subtotal)
### Regla crítica de dueDate (aplica a ambos tipos)
El vencimiento de PAGO siempre aparece asociado a un MONTO.
Si la fecha está junto a un número de CAE (secuencia larga de dígitos) → es del CAE → null.
Si la fecha dice explícitamente "para el pago" → siempre válida.
No deducir, no calcular. Ante la duda: null.
### Normalización de montos (src/lib/businessKey.ts → normalizeBusinessAmount)
Soporta todos los formatos para deduplicación:
- `118000` → `"118000.00"`
- `"$ 118.000,00"` (es-AR) → `"118000.00"`
- `"$ 118,000.00"` (en-US) → `"118000.00"`
### Formato en Google Sheets
Los montos se envían formateados como `"$ 118.000,00"` (es-AR) desde el backend.
No requiere configurar formato en la hoja.
---
## Normalización de consorcios (src/lib/consortiumNormalizer.ts)
```typescript
normalizeConsortiumName("CONSORCIO DE COPROPIETARIOS THAMES NUMEROS 647-649 CAPITAL F")
// → "THAMES 647"
normalizeConsortiumName("CONSORCIO DE PROPIETARIOS AV PUEYRREDON 2418")
// → "PUEYRREDON 2418"
normalizeConsortiumName("BROWN ALMTE AV 708")
// → "ALMIRANTE BROWN 708"  (expande abreviatura ALMTE)
normalizeConsortiumName("AV ALMIRANTE BROWN 00706 018")
// → "ALMIRANTE BROWN 706"  (quita ceros y sufijo numérico)
normalizeConsortiumName("CASTILLO 00246 C1414AWF CAPITAL FEDERAL")
// → "CASTILLO 246"  (quita ceros, CP y localidad)
normalizeConsortiumName("SAN ANTONIO 345 PB A")
// → "SAN ANTONIO 345"  (quita piso/depto)
```
### Pipeline de normalización (en orden)
1. Strip prefijo consorcio (CONSORCIO DE PROPIETARIOS, CONS. PROP., etc.)
2. Expandir abreviaturas de calles (ALMTE→ALMIRANTE, GRAL→GENERAL, etc.)
3. Quitar ceros a la izquierda (00706 → 706)
4. Quitar código postal y localidad (C1414AWF CAPITAL FEDERAL)
5. Quitar piso/depto/unidad (PB A, 3 B, DPTO 4)
6. Quitar sufijos numéricos extras de LSPs (706 018 → 706)
7. Extraer calle + número (sin tipo de vía)
### Fuzzy match mejorado
`consortiumFuzzyMatch()` ahora aplica `stripLeadingZeros` y `expandAbbreviations` en ambos lados antes de tokenizar. Esto permite que "ALMIRANTE BROWN 00706 018" matchee con "ALMIRANTE BROWN 706".
### Match por matchNames
`consortiumAliasMatch()` soporta matching en ambas direcciones (fuzzy directo + fuzzy inverso) contra los valores en `matchNames`.
**Número distinto entre factura y DB (ej: Edesur 708 vs DB 706):**
No se puede resolver automáticamente. Registrar en `matchNames` via Supabase:
```sql
UPDATE "Consortium"
SET "matchNames" = 'BROWN ALMTE AV 708|ALMIRANTE BROWN 708'
WHERE "canonicalName" = 'ALMIRANTE BROWN 706';
```
---
## Importación masiva desde Excel
**Endpoint:** `POST /api/client/import`
**Template:** `GET /api/client/import/template` (descarga .xlsx de ejemplo)
Hoja `Edificios`:
| Nombre | CUIT | Aliases | Alias de pago |
|--------|------|---------|---------------|
| ARENALES 2154 | 30-52312872-4 | CONS PROP ARENALES\|ARENALES 56 | ARENALES |
Hoja `Proveedores`:
| Nombre | CUIT | Alias | Alias de pago |
|--------|------|-------|---------------|
| TIGRE ASCENSORES S.A. | 27-33906838-6 | TIGRE ASCENSORES | TIGRE |
- Aliases en edificios/proveedores: separados por `|`, mapean a `matchNames` (interno)
- Alias de pago: campo único opcional, mapea a `paymentAlias` (visible en UI y Sheets)
- Duplicados: se omiten (skip), no sobreescriben
---
## Recibo de pago
**Endpoint:** `POST /api/client/consortiums/:id/invoices/:invoiceId/receipt`
Sube PDF de recibo a Drive en:
```
[receipts folder del cliente]
  └── [Nombre consorcio]
        └── [Mes Año]
              └── recibo.pdf
```
Si no hay `receipts` folder → usa `scanned` como raíz.
Los campos `receiptDriveFileId` y `receiptDriveFileUrl` se guardan en Invoice.
---
## Purga de boletas por cliente (Admin)
**Preview:** `GET /api/admin/clients/[id]/purge` — retorna `{ ok, count, clientName }`
**Ejecutar:** `DELETE /api/admin/clients/[id]/purge` — purga completa
Flujo del DELETE (en orden):
1. Obtener invoices del cliente (`driveFileId` de cada una)
2. Mover archivos de Drive: `scanned → pending` (fallback `unassigned → pending`). Si falla → `driveFailed++`, continúa
3. Limpiar Sheets: `clearAllDataRows(sheetName)` borra fila 2+ preservando headers
4. Borrar DB en transacción: `ProcessingJob.deleteMany` + `Invoice.deleteMany`
**NO borra:** Consorcios, Proveedores, Períodos, Rubros, Coeficientes, LspServices.
**NO borra archivos de Drive** — solo los mueve de vuelta a pendientes.
**Tolerancia a fallos:** Drive/Sheets fallan → warning + continúa. DB se borra siempre.
Respuesta: `{ ok, deleted, driveMovedBack, driveFailed, sheetsCleared }`
---
## Configuración por cliente (driveFoldersJson)
```json
{
  "pending":    "ID_CARPETA_PENDIENTES",
  "scanned":    "ID_CARPETA_ESCANEADOS",
  "unassigned": "ID_CARPETA_SIN_ASIGNAR",
  "failed":     "ID_CARPETA_FALLIDOS",
  "receipts":   "ID_CARPETA_RECIBOS"
}
```
Diagnóstico: `npx tsx scripts/fix-client-folders.ts`
---
## Autenticación
- Cookie `dpp_session` (httpOnly, sameSite=lax)
- JWT con 24h de expiración
- Middleware (`middleware.ts`) usa Web Crypto API (Edge Runtime compatible)
- Roles: ADMIN / CLIENT / VIEWER
---
## Google Sheets — columnas por defecto
```
A = boletaNumber     H = amount  (formato: "$ 118.000,00")
B = provider         I = alias
C = consortium       J = clientNumber  (NRO CLIENTE)
D = providerTaxId    K = sourceFileUrl
E = detail           L = isDuplicate
F = observation      M = period  (formato: "MM/YYYY")
G = dueDate
```
Customizable por cliente en `extractionConfigJson.columnMapping`.
---
## UI del panel cliente (`/admin/consortiums`)
### Estructura visual
- **Sidebar** colapsable en desktop (iconos / iconos + labels), menú hamburguesa en tablet/mobile (≤1024px).
  - Logo placeholder, nombre del cliente, separador.
  - Botones: Sincronizar directorio, Consorcios (con badge Premium si `consortiumsEnabled` es false), Cerrar Periodo General (solo rol CLIENT), Cerrar sesión.
- **Toolbar superior**: Pausar/Ejecutar scheduler a la izquierda, toggle dark/light (switch con iconos sol/luna) a la derecha.
- **Toggle de tema**: estado solo de sesión (no persiste en localStorage). Clase `dark` en `<html>`.
### Cerrar Periodo General (modal de 2 pasos)
1. **Preview** (`GET /api/client/periods/close-all/preview`): calcula mes mayoritario entre períodos ACTIVE del cliente. Retorna `{ majorityMonth, nextMonth, toClose, toSkip }`.
2. **Execute** (`POST /api/client/periods/close-all`): recalcula mes mayoritario server-side, cierra períodos del mes mayoritario (ACTIVE→CLOSED) y crea el siguiente como ACTIVE. Retorna `{ closed, created, skipped, warnings }`.
3. **Modal**: paso 1 muestra lista de consorcios a cerrar vs saltear (con razón). Paso 2 muestra resultado con contadores.
### Período por defecto (mes mayoritario)
`ConsortiumRepository.resolveMajorityMonth(clientId)`: retorna el mes más frecuente entre los períodos ACTIVE existentes del cliente, o el mes actual si no hay ninguno. Usado en: `createManual()`, import Excel, sync-directory.
---
## Convenciones de código
- **PowerShell:** No usar `&&`. Siempre comandos por separado.
- **Migraciones:** `npx prisma migrate deploy` → `npx prisma generate`. Nunca modificar tablas en Supabase Studio directamente.
- **Prisma generate:** Parar todos los procesos antes (el `.dll` queda bloqueado en Windows).
- **Edge Runtime (`middleware.ts`):** Usar Web Crypto API, no `import { createHmac } from "crypto"`.
- **Tokens de IA:** `extractRelevantLines(text, 80)` — primeras 80 líneas no vacías.
- **Formato de monto:** siempre `es-AR` con `Intl.NumberFormat`.
- **clientAuth vs adminAuth:** usar `requireClientSession` para endpoints de clientes, `requireAuthenticatedSession` para los del panel admin.
- **Documentación:** Siempre actualizar `docs/progreso.md`, `docs/decisiones.md` y `CHANGELOG.md` después de cada cambio significativo. Ver sección "Regla obligatoria de documentación" arriba.
---
## Pendientes conocidos
### Features pendientes
- [ ] UI de gestión de carpetas Drive por cliente desde el panel
- [ ] Resincronización automática con Sheets cuando Google falla
- [ ] Agregar URL de recibo a columna de Google Sheets
- [ ] UI para asignar Rubro y Coeficiente a invoices individuales desde el panel (Stage 2)
- [ ] Columna paymentMethod en Sheets (Stage 2)
- [ ] UI de gestión de LspServices desde el panel (hoy solo via archivo ALTA)
---
## Docker (producción)
### Imagen
- **Base:** `node:20-bookworm-slim` (Debian, NO Alpine — necesario para `@napi-rs/canvas`)
- **Multi-stage:** deps → prod-deps → builder → runner
- **Build:** `SKIP_ENV_VALIDATION=1` en builder para que no falle sin env vars
- **Runtime:** incluye `tesseract-ocr` + idiomas `spa`/`eng`, usuario `nextjs` (no root)
### docker-compose.yml (4 servicios)
| Servicio | Comando | Descripción |
|----------|---------|-------------|
| `web` | `node server.js` | Next.js standalone, puerto 3000, healthcheck |
| `scheduler` | `node dist/jobs/scheduler.js` | Escanea Drive, depende de web healthy |
| `worker` | `node dist/jobs/jobWorkerMain.js` | Procesa cola, depende de web healthy |
| `tunnel` | `cloudflared tunnel run` | Cloudflare Tunnel, token via env |
Los 3 servicios comparten `image: drive-doc-processor:latest`. Solo `web` tiene `build:`.


## ⚠️ Reglas obligatorias para migraciones de base de datos

Estas reglas son de cumplimiento estricto. No hay excepciones.

### Procedimiento de migración (lo ejecuta el owner, no Claude)
Las migraciones y el deploy en producción los realiza el owner manualmente. Claude **nunca** debe ejecutar `docker compose down`, `prisma migrate deploy`, ni `docker compose up --build -d` en producción.

Cuando hay cambios en el schema de Prisma, Claude debe:
1. Crear la carpeta de migración: `prisma/migrations/YYYYMMDDNNNNNN_nombre_descriptivo/`
2. Crear el archivo `migration.sql` con el SQL correspondiente
3. Avisar al owner que hay una migración pendiente y que debe ejecutar el procedimiento completo

## Variables de entorno requeridas
```env
DATABASE_URL=               # PostgreSQL Supabase (pooler)
DIRECT_URL=                 # PostgreSQL Supabase (directo, para migraciones)
SESSION_SECRET=             # JWT signing key (mín 32 chars)
PROCESS_INTERVAL_MINUTES=   # Intervalo scheduler (ej: 5)
# Opcionales (fallback global si el cliente no tiene config propia)
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_DRIVE_PENDING_FOLDER_ID=
GOOGLE_DRIVE_SCANNED_FOLDER_ID=
GOOGLE_SHEETS_ID=
GOOGLE_SHEETS_SHEET_NAME=
GEMINI_API_KEY=
GEMINI_MODEL=
OPENAI_API_KEY=
OPENAI_MODEL=
GOOGLE_CREDENTIALS_ENCRYPTION_KEY=   # default: SESSION_SECRET
```
