export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "drive-doc-processor API",
    version: "1.0.0",
    description: "Documentacion Swagger del backend de procesamiento de PDFs.",
  },
  servers: [
    {
      url: "/",
      description: "Servidor actual",
    },
  ],
  tags: [
    { name: "Auth", description: "Sesion y autenticacion" },
    { name: "Scheduler", description: "Control del scheduler de procesamiento" },
    { name: "Admin", description: "Gestion administrativa de clientes" },
    { name: "Process", description: "Ejecucion manual del pipeline" },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: "dpp_session",
      },
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: false },
          error: { type: "string", example: "Unauthorized" },
        },
      },
      LoginRequest: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 1 },
        },
      },
      LoginResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          user: {
            type: "object",
            properties: {
              id: { type: "string" },
              email: { type: "string", format: "email" },
              name: { type: "string" },
              role: { type: "string", enum: ["ADMIN", "CLIENT"] },
            },
          },
        },
      },
      ToggleSchedulerRequest: {
        type: "object",
        required: ["enabled"],
        properties: {
          enabled: { type: "boolean", example: true },
        },
      },
      CreateClientRequest: {
        type: "object",
        required: [
          "email",
          "password",
          "companyName",
          "driveFolderPending",
          "driveFolderProcessed",
          "sheetsId",
        ],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8 },
          companyName: { type: "string", minLength: 2 },
          driveFolderPending: { type: "string" },
          driveFolderProcessed: { type: "string" },
          sheetsId: { type: "string" },
          sheetName: { type: "string", example: "Datos" },
          googleProjectId: { type: "string" },
          googleClientEmail: { type: "string", format: "email" },
          googlePrivateKey: { type: "string" },
          googleServiceAccountJson: {
            type: "object",
            properties: {
              project_id: { type: "string" },
              client_email: { type: "string", format: "email" },
              private_key: { type: "string" },
            },
          },
        },
      },
    },
  },
  paths: {
    "/api/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Login y creacion de cookie de sesion",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/LoginRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Login correcto",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LoginResponse" },
              },
            },
          },
          "400": { description: "Request invalido" },
          "401": { description: "Credenciales invalidas" },
          "403": { description: "Usuario inactivo" },
        },
      },
    },
    "/api/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Retorna el usuario autenticado",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": { description: "Sesion valida" },
          "401": {
            description: "No autenticado",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Cierra sesion y borra cookie",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": { description: "Sesion cerrada" },
        },
      },
    },
    "/api/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Registro publico deshabilitado",
        responses: {
          "403": { description: "Endpoint deshabilitado" },
        },
      },
    },
    "/api/admin/scheduler/status": {
      get: {
        tags: ["Scheduler"],
        summary: "Estado del scheduler",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": { description: "Estado actual" },
          "401": { description: "No autenticado" },
        },
      },
    },
    "/api/admin/scheduler/toggle": {
      post: {
        tags: ["Scheduler"],
        summary: "Pausar/encender scheduler",
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ToggleSchedulerRequest" },
            },
          },
        },
        responses: {
          "200": { description: "Estado actualizado" },
          "400": { description: "Body invalido" },
          "401": { description: "No autenticado" },
        },
      },
    },
    "/api/admin/scheduler/run": {
      post: {
        tags: ["Scheduler"],
        summary: "Ejecuta el procesamiento manual",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": { description: "Ejecucion completada" },
          "401": { description: "No autenticado" },
          "500": { description: "Error en ejecucion" },
        },
      },
    },
    "/api/admin/clients": {
      post: {
        tags: ["Admin"],
        summary: "Alta de cliente (solo ADMIN)",
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateClientRequest" },
            },
          },
        },
        responses: {
          "200": { description: "Cliente creado" },
          "400": { description: "Body invalido" },
          "401": { description: "No autenticado" },
          "403": { description: "No autorizado" },
          "409": { description: "Email existente" },
        },
      },
    },
    "/api/admin/audit/clients": {
      get: {
        tags: ["Admin"],
        summary: "Auditoria (temporalmente deshabilitada)",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": { description: "Audit deshabilitado" },
          "401": { description: "No autenticado" },
        },
      },
    },
    "/api/process": {
      post: {
        tags: ["Process"],
        summary: "Ejecuta proceso manual sin UI",
        responses: {
          "200": { description: "Proceso ejecutado" },
          "500": { description: "Error de ejecucion" },
        },
      },
    },
  },
} as const;
