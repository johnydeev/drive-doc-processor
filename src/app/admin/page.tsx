"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { SchedulerRuntimeState } from "@/types/scheduler.types";

type AuthRole = "ADMIN" | "CLIENT";
type ThemeMode = "dark" | "light";
const THEME_STORAGE_KEY = "dpp_admin_theme";

type SchedulerStatusResponse = {
  ok: boolean;
  error?: string;
  providers?: {
    geminiConfigured: boolean;
    openaiConfigured: boolean;
  };
  state?: SchedulerRuntimeState;
  auth?: {
    email: string;
    clientId: string;
    role: AuthRole;
  };
  scope?: "all-clients" | "single-client";
};

type ClientMetricRow = {
  clientId: string;
  name: string;
  scheduler: {
    enabled: boolean;
    isRunning: boolean;
  };
  totals: {
    runs: number;
    found: number;
    processed: number;
    duplicates: number;
    failed: number;
  };
  tokensUsed: number;
  quota: {
    gemini: string;
    openai: string;
  };
};

type ClientMetricsResponse = {
  ok: boolean;
  error?: string;
  clients?: ClientMetricRow[];
};

type CreateClientForm = {
  companyName: string;
  email: string;
  password: string;
  driveFolderPending: string;
  driveFolderProcessed: string;
  sheetsId: string;
  sheetName: string;
  geminiApiKey: string;
  openaiApiKey: string;
  googleProjectId: string;
  googleClientEmail: string;
  googlePrivateKey: string;
};

const EMPTY_DASH = "-";

const INITIAL_CREATE_CLIENT_FORM: CreateClientForm = {
  companyName: "",
  email: "",
  password: "",
  driveFolderPending: "",
  driveFolderProcessed: "",
  sheetsId: "",
  sheetName: "Datos",
  geminiApiKey: "",
  openaiApiKey: "",
  googleProjectId: "",
  googleClientEmail: "",
  googlePrivateKey: "",
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) {
    return EMPTY_DASH;
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return EMPTY_DASH;
  }

  return date.toLocaleString("es-AR", {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

function formatNumber(value: number | undefined): string {
  return Number(value ?? 0).toLocaleString("es-AR");
}

function quotaLabel(value: string): "OK" | "LIMITED" | "UNKNOWN" {
  const normalized = value.toLowerCase();
  if (normalized === "ok") {
    return "OK";
  }
  if (normalized === "limited") {
    return "LIMITED";
  }
  return "UNKNOWN";
}

export default function AdminPage() {
  const router = useRouter();
  const [state, setState] = useState<SchedulerRuntimeState | null>(null);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [authRole, setAuthRole] = useState<AuthRole | null>(null);
  const [scope, setScope] = useState<"all-clients" | "single-client">("single-client");
  const [providers, setProviders] = useState({ geminiConfigured: false, openaiConfigured: false });
  const [loading, setLoading] = useState(true);
  const [serverOnline, setServerOnline] = useState(false);
  const [busyAction, setBusyAction] = useState<"toggle" | "run" | "create-client" | "logout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [clientMetrics, setClientMetrics] = useState<ClientMetricRow[]>([]);
  const [createForm, setCreateForm] = useState<CreateClientForm>(INITIAL_CREATE_CLIENT_FORM);
  const [isCreateClientOpen, setIsCreateClientOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("dark");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "dark" || stored === "light") {
        setTheme(stored);
      }
    } catch {
      // no-op
    }
  }, []);

  const handleToggleTheme = () => {
    const next: ThemeMode = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // no-op
    }
  };

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/scheduler/status", {
        method: "GET",
        cache: "no-store",
      });

      const data = (await response.json()) as SchedulerStatusResponse;
      if (!response.ok || !data.ok || !data.state || !data.auth) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      setState(data.state);
      setAuthEmail(data.auth.email);
      setAuthRole(data.auth.role);
      setScope(data.scope ?? "single-client");
      setProviders(
        data.providers ?? {
          geminiConfigured: false,
          openaiConfigured: false,
        }
      );
      setServerOnline(true);
    } catch (err) {
      setServerOnline(false);
      setError(err instanceof Error ? err.message : "No se pudo cargar el estado");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchClientMetrics = useCallback(async () => {
    setMetricsLoading(true);
    setMetricsError(null);

    try {
      const response = await fetch("/api/admin/audit/clients", {
        method: "GET",
        cache: "no-store",
      });

      const data = (await response.json()) as ClientMetricsResponse;
      if (!response.ok || !data.ok || !data.clients) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      setClientMetrics(data.clients);
    } catch (err) {
      setMetricsError(err instanceof Error ? err.message : "No se pudieron cargar metricas");
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const statusTimer = setInterval(() => {
      void fetchStatus();
    }, 30000);

    return () => clearInterval(statusTimer);
  }, [fetchStatus]);

  useEffect(() => {
    if (authRole !== "ADMIN") {
      setClientMetrics([]);
      setMetricsError(null);
      return;
    }

    void fetchClientMetrics();
    const metricsTimer = setInterval(() => {
      void fetchClientMetrics();
    }, 30000);

    return () => clearInterval(metricsTimer);
  }, [authRole, fetchClientMetrics]);

  const handleToggle = async () => {
    if (!state || authRole === "ADMIN") {
      return;
    }

    setBusyAction("toggle");
    setError(null);
    setInfo(null);

    try {
      const response = await fetch("/api/admin/scheduler/toggle", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: !state.enabled }),
      });

      const data = (await response.json()) as {
        ok?: boolean;
        error?: string;
        state?: SchedulerRuntimeState;
      };
      if (!response.ok || !data.ok || !data.state) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      setState(data.state);
      setInfo(data.state.enabled ? "Scheduler encendido." : "Scheduler pausado.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el estado");
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunNow = async () => {
    if (authRole === "ADMIN") {
      return;
    }

    setBusyAction("run");
    setError(null);
    setInfo(null);

    try {
      const response = await fetch("/api/admin/scheduler/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });

      const data = (await response.json()) as { ok?: boolean; error?: string; scope?: string };
      if (!response.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      setInfo(
        data.scope === "all-clients"
          ? "Ejecucion manual completada para todos los clientes."
          : "Ejecucion manual completada para tu cliente."
      );
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo ejecutar manualmente");
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateClient = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusyAction("create-client");
    setError(null);
    setInfo(null);

    try {
      const response = await fetch("/api/admin/clients", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(createForm),
      });

      const data = (await response.json()) as { ok?: boolean; error?: string; client?: { id: string } };
      if (!response.ok || !data.ok || !data.client) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      setCreateForm(INITIAL_CREATE_CLIENT_FORM);
      setInfo(`Cliente creado correctamente (ID: ${data.client.id}).`);
      await fetchStatus();
      if (authRole === "ADMIN") {
        await fetchClientMetrics();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el cliente");
    } finally {
      setBusyAction(null);
    }
  };

  const handleLogout = async () => {
    setBusyAction("logout");
    setError(null);
    setInfo(null);

    try {
      await fetch("/api/auth/logout", {
        method: "POST",
      });

      router.push("/login");
      router.refresh();
    } catch {
      setError("No se pudo cerrar sesion");
    } finally {
      setBusyAction(null);
    }
  };

  const paused = state ? !state.enabled : false;

  return (
    <div className={styles.page} data-theme={theme}>
      <div className={styles.gridBackdrop} />
      <main className={styles.panel}>
        <section className={styles.topBar}>
          <div>
            <p className={styles.eyebrow}>Control de Produccion</p>
            <h1>Scheduler de PDFs</h1>
            <p className={styles.caption}>Estado del procesamiento y consumo de tokens.</p>
          </div>

          <div className={styles.actions}>
            {authRole !== "ADMIN" && (
              <>
                <button
                  type="button"
                  className={paused ? styles.successBtn : styles.warnBtn}
                  onClick={handleToggle}
                  disabled={!state || busyAction !== null}
                >
                  {paused ? "Encender scheduler" : "Pausar scheduler"}
                </button>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={handleRunNow}
                  disabled={busyAction !== null}
                >
                  Ejecutar ahora
                </button>
              </>
            )}
            <button
              type="button"
              className={`${styles.ghostBtn} ${styles.themeBtn}`}
              onClick={handleToggleTheme}
              disabled={busyAction !== null}
            >
              {theme === "dark" ? "Modo claro" : "Modo oscuro"}
            </button>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => void fetchStatus()}
              disabled={loading || busyAction !== null}
            >
              Refrescar
            </button>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={handleLogout}
              disabled={busyAction !== null}
            >
              Cerrar sesion
            </button>
          </div>
        </section>

        <section className={styles.tokenBox}>
          <label>Sesion</label>
          <p className={styles.caption}>
            Usuario autenticado: <strong>{authEmail ?? "No autenticado"}</strong>
          </p>
          <p className={styles.caption}>
            Rol: <strong>{authRole ?? EMPTY_DASH}</strong> | Scope: <strong>{scope}</strong>
          </p>
        </section>

        {authRole === "ADMIN" && (
          <section className={styles.auditBlock}>
            <h2>Metricas por cliente</h2>
            <div className={styles.auditBody}>
              {metricsLoading && <p>Cargando metricas...</p>}
              {metricsError && <p className={styles.error}>{metricsError}</p>}
              {!metricsLoading && !metricsError && (
                <div className={styles.auditTableWrap}>
                  <table className={styles.auditTable}>
                    <thead>
                      <tr>
                        <th>ClientId</th>
                        <th>Nombre</th>
                        <th>Scheduler</th>
                        <th>Totales Acumulados</th>
                        <th>Tokens Usados</th>
                        <th>Cuota</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clientMetrics.length === 0 && (
                        <tr>
                          <td colSpan={6}>No hay clientes con metricas todavia.</td>
                        </tr>
                      )}
                      {clientMetrics.map((client) => (
                        <tr key={client.clientId}>
                          <td>{client.clientId}</td>
                          <td>{client.name}</td>
                          <td>
                            <div className={styles.badgeRow}>
                              <span
                                className={`${styles.statusBadge} ${
                                  client.scheduler.enabled ? styles.badgeOn : styles.badgeOff
                                }`}
                              >
                                {client.scheduler.enabled ? "ON" : "OFF"}
                              </span>
                              {client.scheduler.isRunning && (
                                <span className={`${styles.statusBadge} ${styles.badgeRun}`}>RUN</span>
                              )}
                            </div>
                          </td>
                          <td>
                            <div className={styles.metricPills}>
                              <span className={styles.metricPill}>C {formatNumber(client.totals.runs)}</span>
                              <span className={styles.metricPill}>E {formatNumber(client.totals.found)}</span>
                              <span className={styles.metricPill}>
                                P {formatNumber(client.totals.processed)}
                              </span>
                              <span className={styles.metricPill}>
                                D {formatNumber(client.totals.duplicates)}
                              </span>
                              <span className={styles.metricPill}>F {formatNumber(client.totals.failed)}</span>
                            </div>
                          </td>
                          <td>{formatNumber(client.tokensUsed)}</td>
                          <td>
                            <div className={styles.badgeRow}>
                              <span
                                className={`${styles.statusBadge} ${
                                  quotaLabel(client.quota.gemini) === "OK"
                                    ? styles.badgeOk
                                    : quotaLabel(client.quota.gemini) === "LIMITED"
                                      ? styles.badgeLimited
                                      : styles.badgeUnknown
                                }`}
                              >
                                Gemini {quotaLabel(client.quota.gemini)}
                              </span>
                              <span
                                className={`${styles.statusBadge} ${
                                  quotaLabel(client.quota.openai) === "OK"
                                    ? styles.badgeOk
                                    : quotaLabel(client.quota.openai) === "LIMITED"
                                      ? styles.badgeLimited
                                      : styles.badgeUnknown
                                }`}
                              >
                                OpenAI {quotaLabel(client.quota.openai)}
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        )}

        {authRole === "ADMIN" && (
          <section className={styles.tokenBox}>
            <button
              type="button"
              className={styles.collapseToggle}
              onClick={() => setIsCreateClientOpen((current) => !current)}
              disabled={busyAction !== null}
              aria-expanded={isCreateClientOpen}
            >
              <span className={styles.collapseTitle}>Alta de cliente</span>
              <span
                className={`${styles.collapseChevron} ${
                  isCreateClientOpen ? styles.collapseChevronOpen : ""
                }`}
                aria-hidden="true"
              />
            </button>

            {isCreateClientOpen && (
              <form className={styles.createClientForm} onSubmit={handleCreateClient}>
                <div className={styles.formGrid}>
                  <input
                    placeholder="Empresa"
                    value={createForm.companyName}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, companyName: event.target.value }))
                    }
                    required
                  />
                  <input
                    type="email"
                    placeholder="Email"
                    value={createForm.email}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, email: event.target.value }))
                    }
                    required
                  />
                  <input
                    type="text"
                    placeholder="Password temporal"
                    value={createForm.password}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, password: event.target.value }))
                    }
                    required
                  />
                  <input
                    placeholder="Drive Pending Folder ID"
                    value={createForm.driveFolderPending}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, driveFolderPending: event.target.value }))
                    }
                    required
                  />
                  <input
                    placeholder="Drive Processed Folder ID"
                    value={createForm.driveFolderProcessed}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, driveFolderProcessed: event.target.value }))
                    }
                    required
                  />
                  <input
                    placeholder="Sheets File ID"
                    value={createForm.sheetsId}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, sheetsId: event.target.value }))
                    }
                    required
                  />
                  <input
                    placeholder="Sheets Tab Name"
                    value={createForm.sheetName}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, sheetName: event.target.value }))
                    }
                  />
                  <input
                    placeholder="Gemini API Key (opcional)"
                    value={createForm.geminiApiKey}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, geminiApiKey: event.target.value }))
                    }
                  />
                  <input
                    placeholder="OpenAI API Key (opcional)"
                    value={createForm.openaiApiKey}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, openaiApiKey: event.target.value }))
                    }
                  />
                  <input
                    placeholder="Google Project ID"
                    value={createForm.googleProjectId}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, googleProjectId: event.target.value }))
                    }
                    required
                  />
                  <input
                    type="email"
                    placeholder="Service Account Email"
                    value={createForm.googleClientEmail}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, googleClientEmail: event.target.value }))
                    }
                    required
                  />
                </div>

                <textarea
                  placeholder="Service Account Private Key"
                  value={createForm.googlePrivateKey}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, googlePrivateKey: event.target.value }))
                  }
                  required
                />

                <div className={styles.createClientSubmitWrap}>
                  <button
                    type="submit"
                    className={`${styles.secondaryBtn} ${styles.createClientSubmitBtn}`}
                    disabled={busyAction !== null}
                  >
                    {busyAction === "create-client" ? "Creando..." : "Crear cliente"}
                  </button>
                </div>
              </form>
            )}
          </section>
        )}

        {error && <p className={styles.error}>{error}</p>}
        {info && <p className={styles.info}>{info}</p>}

        <section className={styles.cards}>
          <article className={`${styles.card} ${authRole === "ADMIN" ? styles.cardFull : ""}`}>
            <h2>Estado actual</h2>
            <ul>
              <li>
                Servidor:
                <span
                  className={`${styles.statusBadge} ${serverOnline ? styles.badgeOn : styles.badgeOff}`}
                >
                  {serverOnline ? "ON" : "OFF"}
                </span>
              </li>
              <li>
                Scheduler:
                <span
                  className={`${styles.statusBadge} ${
                    state?.enabled ? styles.badgeOn : styles.badgeOff
                  }`}
                >
                  {state?.enabled ? "ON" : "OFF"}
                </span>
              </li>
              <li>
                Ejecucion activa:
                <span
                  className={`${styles.statusBadge} ${
                    state?.isRunning ? styles.badgeRun : styles.badgeIdle
                  }`}
                >
                  {state?.isRunning ? "RUN" : "IDLE"}
                </span>
              </li>
              <li>
                Intervalo: <strong>{state?.intervalMinutes ?? EMPTY_DASH} min</strong>
              </li>
              <li>
                Heartbeat: <strong>{formatDate(state?.lastHeartbeatAt)}</strong>
              </li>
              <li>
                Ultimo inicio: <strong>{formatDate(state?.lastRunStartedAt)}</strong>
              </li>
              <li>
                Ultimo fin: <strong>{formatDate(state?.lastRunEndedAt)}</strong>
              </li>
            </ul>
          </article>

          {authRole !== "ADMIN" && (
            <article className={styles.card}>
              <h2>Totales acumulados</h2>
              <ul>
                <li>
                  Corridas: <strong>{formatNumber(state?.totals.runs)}</strong>
                </li>
                <li>
                  PDFs encontrados: <strong>{formatNumber(state?.totals.totalFound)}</strong>
                </li>
                <li>
                  Procesados: <strong>{formatNumber(state?.totals.processed)}</strong>
                </li>
                <li>
                  Duplicados: <strong>{formatNumber(state?.totals.duplicatesDetected)}</strong>
                </li>
                <li>
                  Fallidos: <strong>{formatNumber(state?.totals.failed)}</strong>
                </li>
              </ul>
            </article>
          )}

          {authRole !== "ADMIN" && (
            <article className={styles.card}>
              <h2>Tokens usados</h2>
              <ul>
                <li>
                  Input: <strong>{formatNumber(state?.totals.tokenUsage.inputTokens)}</strong>
                </li>
                <li>
                  Output: <strong>{formatNumber(state?.totals.tokenUsage.outputTokens)}</strong>
                </li>
                <li>
                  Total: <strong>{formatNumber(state?.totals.tokenUsage.totalTokens)}</strong>
                </li>
                <li>
                  Gemini: <strong>{formatNumber(state?.totals.tokenUsage.byProvider.gemini)}</strong>
                </li>
                <li>
                  OpenAI: <strong>{formatNumber(state?.totals.tokenUsage.byProvider.openai)}</strong>
                </li>
              </ul>
            </article>
          )}

          {authRole !== "ADMIN" && (
            <article className={styles.card}>
              <h2>Cuota estimada</h2>
              <ul>
                <li>
                  Gemini:
                  <span
                    className={`${styles.statusBadge} ${
                      quotaLabel(state?.quota.gemini.status ?? "unknown") === "OK"
                        ? styles.badgeOk
                        : quotaLabel(state?.quota.gemini.status ?? "unknown") === "LIMITED"
                          ? styles.badgeLimited
                          : styles.badgeUnknown
                    }`}
                  >
                    {quotaLabel(state?.quota.gemini.status ?? "unknown")}
                  </span>
                </li>
                <li className={styles.noteLine}>{state?.quota.gemini.note ?? EMPTY_DASH}</li>
                <li>
                  OpenAI:
                  <span
                    className={`${styles.statusBadge} ${
                      quotaLabel(state?.quota.openai.status ?? "unknown") === "OK"
                        ? styles.badgeOk
                        : quotaLabel(state?.quota.openai.status ?? "unknown") === "LIMITED"
                          ? styles.badgeLimited
                          : styles.badgeUnknown
                    }`}
                  >
                    {quotaLabel(state?.quota.openai.status ?? "unknown")}
                  </span>
                </li>
                <li className={styles.noteLine}>{state?.quota.openai.note ?? EMPTY_DASH}</li>
                <li>
                  APIs:
                  <strong>
                    Gemini {providers.geminiConfigured ? " ON" : " OFF"} | OpenAI
                    {providers.openaiConfigured ? " ON" : " OFF"}
                  </strong>
                </li>
              </ul>
            </article>
          )}
        </section>

        <section className={styles.lastRun}>
          <h2>Ultima ejecucion</h2>
          <div className={styles.lastRunBody}>
            {!state?.lastSummary && loading && <p>Cargando...</p>}
            {!state?.lastSummary && !loading && <p>No hay ejecuciones registradas todavia.</p>}
            {state?.lastSummary && (
              <>
                {loading && <p className={styles.updateHint}>Actualizando datos...</p>}
                <div className={styles.summaryStrip}>
                  <span>Encontrados: {state.lastSummary.totalFound}</span>
                  <span>Procesados: {state.lastSummary.processed}</span>
                  <span>Skips: {state.lastSummary.skipped}</span>
                  <span>Errores: {state.lastSummary.failed}</span>
                </div>
                {state.lastSummary.errors.length > 0 && (
                  <div className={styles.errorList}>
                    {state.lastSummary.errors.slice(0, 8).map((item) => (
                      <p key={`${item.fileId}:${item.error}`}>
                        <strong>{item.fileName}</strong>: {item.error}
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

