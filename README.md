# Drive Doc Processor

Backend multi-tenant en `Next.js + TypeScript` para procesar comprobantes PDF desde Google Drive, extraer datos con IA/OCR, cargar resultados en Google Sheets y mantener trazabilidad en PostgreSQL.

## Estado actual del sistema
- Multi-tenant por cliente (`Client` con rol `ADMIN` o `CLIENT`).
- Scheduler automatico con control `ON/OFF` por cliente.
- Dashboard admin con:
  - alta de clientes,
  - metricas por cliente,
  - estado de scheduler por cliente.
- Dashboard cliente con:
  - control de su propio scheduler,
  - ejecucion manual,
  - resumen de ultima corrida.
- Autenticacion por cookie httpOnly con expiracion de token a 24h.
- Persistencia en PostgreSQL (Prisma).
- Deteccion de duplicados por hash y clave de negocio.

## Flujo de procesamiento (por cliente)
1. Lista PDFs en carpeta `Pendientes` de Google Drive.
2. Descarga PDF.
3. Extrae texto:
  - texto embebido directo,
  - fallback OCR con Tesseract si no hay texto.
4. Extrae JSON estructurado con IA:
  - prioridad: Gemini del cliente -> OpenAI del cliente -> Gemini global -> OpenAI global -> OCR_ONLY.
5. Detecta duplicado:
  - por `documentHash` (sha256),
  - por clave de negocio normalizada.
6. Inserta fila en Google Sheets.
7. Mueve archivo a carpeta `Escaneados`.
8. Registra logs, totales y tokens en DB.

## Arquitectura resumida
- API/UI: Next.js App Router (`src/app`).
- Worker scheduler: proceso separado (`src/jobs/scheduler.ts`).
- Persistencia: Prisma + PostgreSQL (`prisma/schema.prisma`).
- Servicios:
  - Drive: `src/services/googleDrive.service.ts`
  - Sheets: `src/services/googleSheets.service.ts`
  - OCR: `src/services/ocr.service.ts`
  - PDF text: `src/services/pdfTextExtractor.service.ts`
  - Gemini: `src/services/geminiExtractor.service.ts`
  - OpenAI: `src/services/aiExtractor.service.ts`

## Modelos principales (Prisma)
- `Client`: usuario/tenant con config de Drive/Sheets e IA.
- `Invoice`: factura procesada + metadatos + deduplicacion.
- `ProcessingLog`: historial de ejecuciones.
- `SchedulerState`: estado runtime y acumulados por cliente.
- `TokenUsage`: consumo de tokens por corrida/proveedor/modelo.

## Variables de entorno
### Requeridas
- `DATABASE_URL`
- `DIRECT_URL` (para migraciones Prisma)
- `PROCESS_INTERVAL_MINUTES`
- `SESSION_SECRET`

### Opcionales (fallback global)
Estas son opcionales porque el modo recomendado es usar credenciales por cliente en DB:
- `GOOGLE_PROJECT_ID`
- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_DRIVE_PENDING_FOLDER_ID`
- `GOOGLE_DRIVE_SCANNED_FOLDER_ID`
- `GOOGLE_SHEETS_ID`
- `GOOGLE_SHEETS_SHEET_NAME` (default interno: `Datos`)
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

## Configuracion local
1. Instalar dependencias:
```bash
npm install
```

2. Crear/ajustar entorno:
```bash
cp .env.example .env.local
```

3. Generar cliente Prisma:
```bash
npm run prisma:generate
```

4. Aplicar migraciones:
```bash
npm run prisma:migrate:deploy
```

## Ejecutar en desarrollo
Necesitas 2 procesos:

1. Web/API:
```bash
npm run dev
```

2. Scheduler:
```bash
npm run schedule
```

Si solo ejecutas `npm run dev`, no hay procesamiento automatico.

## Scripts utiles
- `npm run dev`: levanta Next en desarrollo.
- `npm run schedule`: levanta loop automatico.
- `npm run build`: build de produccion.
- `npm run start`: servidor de produccion.
- `npm run diagnose -- <fileId>`: diagnostico Drive por archivo.
- `npm run diagnose:gemini`: test de extraccion Gemini.
- `npm run diagnose:db`: diagnostico de conexion DB.
- `npm run prisma:migrate:deploy`: aplica migraciones.

## Endpoints principales
### Auth
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/register` -> deshabilitado (retorna 403)

### Procesamiento
- `POST /api/process` -> ejecuta corrida manual (global o segun sesion).

### Admin / Scheduler
- `GET /api/admin/scheduler/status`
- `POST /api/admin/scheduler/toggle`
- `POST /api/admin/scheduler/run`
- `GET /api/admin/audit/clients` (metricas por cliente)
- `POST /api/admin/clients` (alta de cliente)

### Documentacion API
- Swagger UI: `GET /api-docs`
- Alias: `GET /docs`
- OpenAPI JSON: `GET /api/openapi`

## Alta de cliente (desde panel ADMIN)
Se guarda en DB:
- Datos de cuenta: nombre, email, password temporal.
- Drive:
  - `driveFolderPending`
  - `driveFolderProcessed`
- Sheets:
  - `sheetsId`
  - `sheetName`
- Service account Google:
  - `projectId`
  - `clientEmail`
  - `privateKey`
- IA opcional por cliente:
  - `geminiApiKey`
  - `openaiApiKey`

## Validaciones importantes por cliente
Antes de procesar se valida:
- `driveFolderPending` obligatorio.
- `driveFolderProcessed` obligatorio.
- Pendientes y Escaneados deben ser distintos.
- `sheetName` obligatorio.
- Credenciales Google completas (`projectId/clientEmail/privateKey/sheetsId`).

Si falta algo, se registra error explicito por cliente en la corrida.

## Deduplicacion
- `documentHash` (sha256) por cliente.
- clave de negocio normalizada por cliente:
  - `boletaNumberNorm`
  - `providerTaxIdNorm`
  - `consortiumNorm`
  - `dueDateNorm`
  - `amountNorm`

## Docker
### Compose simple (actual)
- `docker-compose.yml`: app en un servicio.

### Compose recomendado prod
- `docker-compose.prod.yml`:
  - `web` (Next/API)
  - `worker` (scheduler)

Levantar:
```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Logs:
```bash
docker compose -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.prod.yml logs -f worker
```

## Checklist de produccion
### Seguridad
- Definir `SESSION_SECRET` fuerte (minimo 32 bytes aleatorios).
- Verificar que no haya credenciales reales en repositorio ni `.env` versionados.
- Rotar claves de service account y API keys antes de go-live.
- Forzar HTTPS y dominio final en el reverse proxy.

### Base de datos
- `DATABASE_URL` y `DIRECT_URL` apuntando a la DB productiva.
- Ejecutar `npm run prisma:migrate:deploy`.
- Confirmar que existe al menos un usuario `ADMIN`.

### Scheduler y worker
- Levantar `web` y `worker` (no solo `web`).
- Verificar en logs que aparezca: `[scheduler] starting. Interval: ...`.
- Confirmar que cada cliente puede activar/desactivar su scheduler de forma independiente.

### Integraciones por cliente
- Validar `driveFolderPending` y `driveFolderProcessed` (distintos).
- Validar `googleConfigJson` completo (`projectId/clientEmail/privateKey/sheetsId`).
- Compartir carpetas Drive y archivo Sheets al service account correspondiente.
- Confirmar `sheetName` correcto.

### Pruebas funcionales minimas
- Login ADMIN y CLIENT.
- Alta de cliente desde panel ADMIN.
- Toggle scheduler ON/OFF por cliente.
- Corrida manual (`Ejecutar ahora`) y corrida automatica.
- Verificar insercion en Sheets y movimiento a carpeta Escaneados.
- Verificar deduplicacion por hash y clave de negocio.

## Seguridad y sesiones
- Cookie `httpOnly`, `sameSite=lax`.
- Session cookie (se elimina al cerrar sesion de navegador).
- Token con expiracion dura de 24 horas.
- `SESSION_SECRET` obligatorio.

## Troubleshooting rapido
### `Unexpected token '<' ... is not valid JSON`
- Normalmente significa que un endpoint devolvio HTML por error 500.
- Revisar logs del server para identificar variable/config faltante.

### Scheduler no corre automatico
- Verificar que `npm run schedule` este activo (o servicio `worker` en Docker).
- Verificar `PROCESS_INTERVAL_MINUTES`.
- Verificar que el cliente tenga scheduler en `ON`.

---
Si agregamos funcionalidades nuevas, este README debe actualizarse en la misma PR para mantener trazabilidad del producto.
