"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { SchedulerRuntimeState } from "@/types/scheduler.types";
import { useAuthGuard } from "@/lib/useAuthGuard";

type AuthRole = "ADMIN" | "CLIENT" | "VIEWER";
type ThemeMode = "dark" | "light";
const THEME_STORAGE_KEY = "dpp_admin_theme";

type SchedulerStatusResponse = {
  ok: boolean; error?: string;
  providers?: { geminiConfigured: boolean; openaiConfigured: boolean };
  state?: SchedulerRuntimeState;
  auth?: { email: string; clientId: string; role: AuthRole };
  scope?: "all-clients" | "single-client";
};

type ClientMetricRow = {
  clientId: string; name: string; consortiumsEnabled: boolean;
  scheduler: { enabled: boolean; isRunning: boolean };
  totals: { runs: number; found: number; processed: number; duplicates: number; failed: number };
  tokensUsed: number; quota: { gemini: string; openai: string };
  consortiumCount: number;
  debugMode: boolean;
};

type ClientMetricsResponse = { ok: boolean; error?: string; clients?: ClientMetricRow[]; };

type CreateClientForm = {
  companyName: string; email: string; password: string;
  driveFolderPending: string; driveFolderScanned: string;
  driveFolderUnassigned: string; driveFolderFailed: string; driveFolderReceipts: string;
  sheetsId: string; altaSheetsId: string; sheetName: string;
  geminiApiKey: string; openaiApiKey: string; anthropicApiKey: string;
  googleProjectId: string; googleClientEmail: string; googlePrivateKey: string;
};

type PurgeTarget = { clientId: string; clientName: string } | null;
type PurgeStep = "preview" | "confirm" | "result";
type PurgeResult = { deleted: number; driveMovedBack: number; driveFailed: number; sheetsCleared: boolean } | null;

const EMPTY_DASH = "-";

const INITIAL_FORM: CreateClientForm = {
  companyName: "", email: "", password: "",
  driveFolderPending: "", driveFolderScanned: "",
  driveFolderUnassigned: "", driveFolderFailed: "", driveFolderReceipts: "",
  sheetsId: "", altaSheetsId: "", sheetName: "Datos",
  geminiApiKey: "", openaiApiKey: "", anthropicApiKey: "",
  googleProjectId: "", googleClientEmail: "", googlePrivateKey: "",
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return EMPTY_DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EMPTY_DASH;
  return date.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "medium" });
}
function formatNumber(v: number | undefined): string { return Number(v ?? 0).toLocaleString("es-AR"); }
function quotaLabel(v: string): "OK" | "LIMITED" | "UNKNOWN" {
  const n = v.toLowerCase();
  if (n === "ok") return "OK";
  if (n === "limited") return "LIMITED";
  return "UNKNOWN";
}

export default function AdminPage() {
  const router = useRouter();
  const { guardedFetch } = useAuthGuard();

  const [state, setState] = useState<SchedulerRuntimeState | null>(null);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [authRole, setAuthRole] = useState<AuthRole | null>(null);
  const [consortiumsEnabled, setConsortiumsEnabled] = useState(false);
  const [scope, setScope] = useState<"all-clients" | "single-client">("single-client");
  const [providers, setProviders] = useState({ geminiConfigured: false, openaiConfigured: false });
  const [loading, setLoading] = useState(true);
  const [serverOnline, setServerOnline] = useState(false);
  const [busyAction, setBusyAction] = useState<"toggle" | "run" | "create-client" | "logout" | "sync-directory" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [clientMetrics, setClientMetrics] = useState<ClientMetricRow[]>([]);
  const [createForm, setCreateForm] = useState<CreateClientForm>(INITIAL_FORM);
  const [isCreateClientOpen, setIsCreateClientOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [purgeTarget, setPurgeTarget] = useState<PurgeTarget>(null);
  const [purgeStep, setPurgeStep] = useState<PurgeStep>("preview");
  const [purgeCount, setPurgeCount] = useState(0);
  const [purgeResult, setPurgeResult] = useState<PurgeResult>(null);
  const [purgeLoading, setPurgeLoading] = useState(false);

  const isAdmin = authRole === "ADMIN";
  const canControlScheduler = authRole === "CLIENT";

  const set = (field: keyof CreateClientForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setCreateForm((c) => ({ ...c, [field]: e.target.value }));

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "dark" || stored === "light") setTheme(stored);
    } catch { /* no-op */ }
  }, []);

  const handleToggleTheme = () => {
    const next: ThemeMode = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { window.localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* no-op */ }
  };

  const fetchStatus = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await guardedFetch("/api/admin/scheduler/status", { method: "GET", cache: "no-store" });
      const data = (await res.json()) as SchedulerStatusResponse;
      if (!res.ok || !data.ok || !data.state || !data.auth) throw new Error(data.error ?? `HTTP ${res.status}`);
      setState(data.state);
      setAuthEmail(data.auth.email);
      setAuthRole(data.auth.role);
      if (data.auth.role === "CLIENT") {
        try {
          const meRes = await guardedFetch("/api/auth/me", { method: "GET", cache: "no-store" });
          const meData = (await meRes.json()) as { ok: boolean; user?: { consortiumsEnabled?: boolean } };
          if (meData.ok && meData.user) setConsortiumsEnabled(meData.user.consortiumsEnabled ?? false);
        } catch { /* ignore */ }
      }
      setScope(data.scope ?? "single-client");
      setProviders(data.providers ?? { geminiConfigured: false, openaiConfigured: false });
      setServerOnline(true);
    } catch (err) {
      setServerOnline(false);
      setError(err instanceof Error ? err.message : "No se pudo cargar el estado");
    } finally { setLoading(false); }
  }, [guardedFetch]);

  const fetchClientMetrics = useCallback(async () => {
    setMetricsLoading(true); setMetricsError(null);
    try {
      const res = await guardedFetch("/api/admin/audit/clients", { method: "GET", cache: "no-store" });
      const data = (await res.json()) as ClientMetricsResponse;
      if (!res.ok || !data.ok || !data.clients) throw new Error(data.error ?? `HTTP ${res.status}`);
      setClientMetrics(data.clients);
    } catch (err) {
      setMetricsError(err instanceof Error ? err.message : "No se pudieron cargar metricas");
    } finally { setMetricsLoading(false); }
  }, [guardedFetch]);

  useEffect(() => {
    void fetchStatus();
    const t = setInterval(() => void fetchStatus(), 30000);
    return () => clearInterval(t);
  }, [fetchStatus]);

  useEffect(() => {
    if (!isAdmin) { setClientMetrics([]); setMetricsError(null); return; }
    void fetchClientMetrics();
    const t = setInterval(() => void fetchClientMetrics(), 30000);
    return () => clearInterval(t);
  }, [isAdmin, fetchClientMetrics]);

  const handleToggle = async () => {
    if (!state || !canControlScheduler) return;
    setBusyAction("toggle"); setError(null); setInfo(null);
    try {
      const res = await guardedFetch("/api/admin/scheduler/toggle", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !state.enabled }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; state?: SchedulerRuntimeState };
      if (!res.ok || !data.ok || !data.state) throw new Error(data.error ?? `HTTP ${res.status}`);
      setState(data.state);
      setInfo(data.state.enabled ? "Scheduler encendido." : "Scheduler pausado.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el estado");
    } finally { setBusyAction(null); }
  };

  const handleRunNow = async () => {
    if (!canControlScheduler) return;
    setBusyAction("run"); setError(null); setInfo(null);
    try {
      const res = await guardedFetch("/api/admin/scheduler/run", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; scope?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInfo(data.scope === "all-clients"
        ? "Ejecucion manual completada para todos los clientes."
        : "Ejecucion manual completada para tu cliente.");
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo ejecutar manualmente");
    } finally { setBusyAction(null); }
  };

  const handleSyncDirectory = async () => {
    if (!canControlScheduler) return;
    setBusyAction("sync-directory"); setError(null); setInfo(null);
    try {
      const res = await guardedFetch("/api/client/sync-directory", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = (await res.json()) as {
        ok?: boolean; error?: string; warnings?: string[];
        consortiumsCount?: number; providersCount?: number;
        rubrosCount?: number; coeficientesCount?: number;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const counts = `Consorcios: ${data.consortiumsCount ?? 0} | Proveedores: ${data.providersCount ?? 0} | Rubros: ${data.rubrosCount ?? 0} | Coeficientes: ${data.coeficientesCount ?? 0}`;
      const warnings = data.warnings?.length ? ` — Advertencias: ${data.warnings.join("; ")}` : "";
      setInfo(`Directorio sincronizado. ${counts}${warnings}`);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo sincronizar el directorio");
    } finally { setBusyAction(null); }
  };

  const handleCreateClient = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusyAction("create-client"); setError(null); setInfo(null);
    try {
      const res = await guardedFetch("/api/admin/clients", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(createForm),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; client?: { id: string } };
      if (!res.ok || !data.ok || !data.client) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCreateForm(INITIAL_FORM);
      setInfo(`Cliente creado correctamente (ID: ${data.client.id}).`);
      await fetchStatus();
      if (isAdmin) await fetchClientMetrics();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el cliente");
    } finally { setBusyAction(null); }
  };

  const handleLogout = async () => {
    setBusyAction("logout"); setError(null); setInfo(null);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch {
      setError("No se pudo cerrar sesion");
    } finally { setBusyAction(null); }
  };

  const handleTogglePremium = async (clientId: string, current: boolean) => {
    const next = !current;
    setClientMetrics((prev) =>
      prev.map((c) => (c.clientId === clientId ? { ...c, consortiumsEnabled: next } : c))
    );
    try {
      const res = await guardedFetch(`/api/admin/clients/${clientId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consortiumsEnabled: next }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setClientMetrics((prev) =>
          prev.map((c) => (c.clientId === clientId ? { ...c, consortiumsEnabled: current } : c))
        );
        setError(data.error ?? "No se pudo cambiar Premium");
      }
    } catch {
      setClientMetrics((prev) =>
        prev.map((c) => (c.clientId === clientId ? { ...c, consortiumsEnabled: current } : c))
      );
      setError("No se pudo cambiar Premium");
    }
  };

  const handleToggleDebug = async (clientId: string, current: boolean) => {
    const next = !current;
    setClientMetrics((prev) =>
      prev.map((c) => (c.clientId === clientId ? { ...c, debugMode: next } : c))
    );
    try {
      const res = await guardedFetch(`/api/admin/clients/${clientId}/debug-mode`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ debugMode: next }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setClientMetrics((prev) =>
          prev.map((c) => (c.clientId === clientId ? { ...c, debugMode: current } : c))
        );
        setError(data.error ?? "No se pudo cambiar Debug Mode");
      }
    } catch {
      setClientMetrics((prev) =>
        prev.map((c) => (c.clientId === clientId ? { ...c, debugMode: current } : c))
      );
      setError("No se pudo cambiar Debug Mode");
    }
  };

  const handlePurgeOpen = async (clientId: string, clientName: string) => {
    setPurgeTarget({ clientId, clientName });
    setPurgeStep("preview");
    setPurgeResult(null);
    setPurgeLoading(true);
    try {
      const res = await guardedFetch(`/api/admin/clients/${clientId}/purge`, { method: "GET", cache: "no-store" });
      const data = (await res.json()) as { ok: boolean; count?: number; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPurgeCount(data.count ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo obtener preview de purga");
      setPurgeTarget(null);
    } finally { setPurgeLoading(false); }
  };

  const handlePurgeExecute = async () => {
    if (!purgeTarget) return;
    setPurgeLoading(true);
    try {
      const res = await guardedFetch(`/api/admin/clients/${purgeTarget.clientId}/purge`, {
        method: "DELETE", headers: { "content-type": "application/json" },
      });
      const data = (await res.json()) as { ok: boolean; error?: string; deleted?: number; driveMovedBack?: number; driveFailed?: number; sheetsCleared?: boolean };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPurgeResult({
        deleted: data.deleted ?? 0,
        driveMovedBack: data.driveMovedBack ?? 0,
        driveFailed: data.driveFailed ?? 0,
        sheetsCleared: data.sheetsCleared ?? false,
      });
      setPurgeStep("result");
      await fetchClientMetrics();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al ejecutar la purga");
      setPurgeTarget(null);
    } finally { setPurgeLoading(false); }
  };

  const handlePurgeClose = () => {
    setPurgeTarget(null);
    setPurgeResult(null);
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
            {canControlScheduler && (
              <>
                <button type="button" className={paused ? styles.successBtn : styles.warnBtn}
                  onClick={handleToggle} disabled={!state || busyAction !== null}>
                  {paused ? "Encender scheduler" : "Pausar scheduler"}
                </button>
                <button type="button" className={styles.secondaryBtn}
                  onClick={handleRunNow} disabled={busyAction !== null}>
                  Ejecutar ahora
                </button>
              </>
            )}
            {canControlScheduler && (
              <>
                <button type="button" className={styles.secondaryBtn}
                  onClick={handleSyncDirectory} disabled={busyAction !== null}>
                  {busyAction === "sync-directory" ? "Sincronizando..." : "Sincronizar directorio"}
                </button>
                <button type="button" className={styles.ghostBtn}
                  onClick={() => router.push("/admin/consortiums")}
                  disabled={busyAction !== null || !consortiumsEnabled}
                  title={!consortiumsEnabled ? "Funcion Premium" : undefined}>
                  Consorcios{!consortiumsEnabled && <span className={styles.premiumBadge}>Premium</span>}
                </button>
              </>
            )}
            {isAdmin && (
              <button type="button" className={styles.ghostBtn}
                onClick={() => router.push("/admin/invoices")}
                disabled={busyAction !== null}>
                Invoices
              </button>
            )}
            <button type="button" className={`${styles.ghostBtn} ${styles.themeBtn}`}
              onClick={handleToggleTheme} disabled={busyAction !== null}>
              {theme === "dark" ? "Modo claro" : "Modo oscuro"}
            </button>
            <button type="button" className={styles.ghostBtn}
              onClick={() => void fetchStatus()} disabled={loading || busyAction !== null}>
              Refrescar
            </button>
            <button type="button" className={styles.ghostBtn}
              onClick={handleLogout} disabled={busyAction !== null}>
              Cerrar sesion
            </button>
          </div>
        </section>

        <section className={styles.tokenBox}>
          <label>Sesion</label>
          <p className={styles.caption}>Usuario autenticado: <strong>{authEmail ?? "No autenticado"}</strong></p>
          <p className={styles.caption}>Rol: <strong>{authRole ?? EMPTY_DASH}</strong> | Scope: <strong>{scope}</strong></p>
        </section>

        {isAdmin && (
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
                        <th>Nombre</th><th>Premium</th><th>Scheduler</th>
                        <th>Totales Acumulados</th><th>Tokens Usados</th><th>Cuota</th><th>Edificios</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {clientMetrics.length === 0 && <tr><td colSpan={8}>No hay clientes con metricas todavia.</td></tr>}
                      {clientMetrics.map((client) => (
                        <tr key={client.clientId}>
                          <td>{client.name}</td>
                          <td>
                            <button
                              type="button"
                              className={`${styles.statusBadge} ${client.consortiumsEnabled ? styles.badgeOn : styles.badgeOff}`}
                              style={{ cursor: "pointer", border: "none" }}
                              onClick={() => handleTogglePremium(client.clientId, client.consortiumsEnabled)}
                            >
                              {client.consortiumsEnabled ? "ON" : "OFF"}
                            </button>
                          </td>
                          <td>
                            <div className={styles.badgeRow}>
                              <span className={`${styles.statusBadge} ${client.scheduler.enabled ? styles.badgeOn : styles.badgeOff}`}>{client.scheduler.enabled ? "ON" : "OFF"}</span>
                              {client.scheduler.isRunning && <span className={`${styles.statusBadge} ${styles.badgeRun}`}>RUN</span>}
                            </div>
                          </td>
                          <td>
                            <div className={styles.metricPills}>
                              <span className={styles.metricPill}>C {formatNumber(client.totals.runs)}</span>
                              <span className={styles.metricPill}>E {formatNumber(client.totals.found)}</span>
                              <span className={styles.metricPill}>P {formatNumber(client.totals.processed)}</span>
                              <span className={styles.metricPill}>D {formatNumber(client.totals.duplicates)}</span>
                              <span className={styles.metricPill}>F {formatNumber(client.totals.failed)}</span>
                            </div>
                          </td>
                          <td>{formatNumber(client.tokensUsed)}</td>
                          <td>
                            <div className={styles.badgeRow}>
                              <span className={`${styles.statusBadge} ${quotaLabel(client.quota.gemini) === "OK" ? styles.badgeOk : quotaLabel(client.quota.gemini) === "LIMITED" ? styles.badgeLimited : styles.badgeUnknown}`}>Gemini {quotaLabel(client.quota.gemini)}</span>
                              <span className={`${styles.statusBadge} ${quotaLabel(client.quota.openai) === "OK" ? styles.badgeOk : quotaLabel(client.quota.openai) === "LIMITED" ? styles.badgeLimited : styles.badgeUnknown}`}>OpenAI {quotaLabel(client.quota.openai)}</span>
                            </div>
                          </td>
                          <td><span className={styles.metricPill}>🏢 {formatNumber(client.consortiumCount)}</span></td>
                          <td>
                            <div style={{ display: "flex", gap: "6px" }}>
                              <button
                                type="button"
                                className={`${styles.statusBadge} ${client.debugMode ? styles.badgeOn : styles.badgeOff}`}
                                style={{ cursor: "pointer", border: "none", fontSize: "11px" }}
                                title="Activa logs detallados de OCR e IA en el pipeline"
                                onClick={() => handleToggleDebug(client.clientId, client.debugMode)}
                              >
                                {client.debugMode ? "🐛 Debug ON" : "🐛 Debug OFF"}
                              </button>
                              <button
                                type="button"
                                className={styles.ghostBtn}
                                style={{ padding: "5px 12px", fontSize: "12px" }}
                                onClick={() => router.push(`/admin/clients/${client.clientId}`)}
                              >
                                Editar
                              </button>
                              <button
                                type="button"
                                className={styles.purgeBtn}
                                disabled={busyAction !== null || purgeTarget !== null}
                                onClick={() => handlePurgeOpen(client.clientId, client.name)}
                              >
                                Purgar
                              </button>
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

        {isAdmin && (
          <section className={styles.tokenBox}>
            <button type="button" className={styles.collapseToggle}
              onClick={() => setIsCreateClientOpen((c) => !c)}
              disabled={busyAction !== null} aria-expanded={isCreateClientOpen}>
              <span className={styles.collapseTitle}>Alta de cliente</span>
              <span className={`${styles.collapseChevron} ${isCreateClientOpen ? styles.collapseChevronOpen : ""}`} aria-hidden="true" />
            </button>

            {isCreateClientOpen && (
              <form className={styles.createClientForm} onSubmit={handleCreateClient}>
                <p className={styles.formSectionLabel}>Cuenta</p>
                <div className={styles.formGrid}>
                  <input placeholder="Empresa *" value={createForm.companyName} onChange={set("companyName")} required />
                  <input type="email" placeholder="Email *" value={createForm.email} onChange={set("email")} required />
                  <input type="text" placeholder="Password temporal *" value={createForm.password} onChange={set("password")} required />
                </div>
                <p className={styles.formSectionLabel}>Carpetas Google Drive</p>
                <div className={styles.formGrid}>
                  <input placeholder="Carpeta Pendientes * (ID)" value={createForm.driveFolderPending} onChange={set("driveFolderPending")} required />
                  <input placeholder="Carpeta Escaneados * (ID)" value={createForm.driveFolderScanned} onChange={set("driveFolderScanned")} required />
                  <input placeholder="Carpeta Sin Asignar (ID, opcional)" value={createForm.driveFolderUnassigned} onChange={set("driveFolderUnassigned")} />
                  <input placeholder="Carpeta Fallidos (ID, opcional)" value={createForm.driveFolderFailed} onChange={set("driveFolderFailed")} />
                  <input placeholder="Carpeta Recibos (ID, opcional)" value={createForm.driveFolderReceipts} onChange={set("driveFolderReceipts")} />
                </div>
                <p className={styles.formSectionLabel}>Google Sheets</p>
                <div className={styles.formGrid}>
                  <input placeholder="Sheets File ID (Datos) *" value={createForm.sheetsId} onChange={set("sheetsId")} required />
                  <input placeholder="Sheets File ID (ALTA, opcional)" value={createForm.altaSheetsId} onChange={set("altaSheetsId")} />
                  <input placeholder="Nombre de hoja (default: Datos)" value={createForm.sheetName} onChange={set("sheetName")} />
                </div>
                <p className={styles.formSectionLabel}>Claves de IA (opcionales)</p>
                <div className={styles.formGrid}>
                  <input placeholder="Gemini API Key" value={createForm.geminiApiKey} onChange={set("geminiApiKey")} />
                  <input placeholder="OpenAI API Key" value={createForm.openaiApiKey} onChange={set("openaiApiKey")} />
                  <input placeholder="Anthropic API Key" value={createForm.anthropicApiKey} onChange={set("anthropicApiKey")} />
                </div>
                <p className={styles.formSectionLabel}>Credenciales Google Service Account</p>
                <div className={styles.formGrid}>
                  <input placeholder="Project ID *" value={createForm.googleProjectId} onChange={set("googleProjectId")} required />
                  <input type="email" placeholder="Service Account Email *" value={createForm.googleClientEmail} onChange={set("googleClientEmail")} required />
                </div>
                <textarea placeholder="Private Key * (-----BEGIN RSA PRIVATE KEY-----...)"
                  value={createForm.googlePrivateKey} onChange={set("googlePrivateKey")} required />
                <div className={styles.createClientSubmitWrap}>
                  <button type="submit" className={`${styles.secondaryBtn} ${styles.createClientSubmitBtn}`} disabled={busyAction !== null}>
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
          <article className={`${styles.card} ${isAdmin ? styles.cardFull : ""}`}>
            <h2>Estado actual</h2>
            <ul>
              <li>Servidor: <span className={`${styles.statusBadge} ${serverOnline ? styles.badgeOn : styles.badgeOff}`}>{serverOnline ? "ON" : "OFF"}</span></li>
              <li>Scheduler: <span className={`${styles.statusBadge} ${state?.enabled ? styles.badgeOn : styles.badgeOff}`}>{state?.enabled ? "ON" : "OFF"}</span></li>
              <li>Ejecucion activa: <span className={`${styles.statusBadge} ${state?.isRunning ? styles.badgeRun : styles.badgeIdle}`}>{state?.isRunning ? "RUN" : "IDLE"}</span></li>
              <li>Intervalo: <strong>{state?.intervalMinutes ?? EMPTY_DASH} min</strong></li>
              <li>Heartbeat: <strong>{formatDate(state?.lastHeartbeatAt)}</strong></li>
              <li>Ultimo inicio: <strong>{formatDate(state?.lastRunStartedAt)}</strong></li>
              <li>Ultimo fin: <strong>{formatDate(state?.lastRunEndedAt)}</strong></li>
              <li>Ultima sync directorio: <strong>{formatDate(state?.lastDirectorySyncAt)}</strong></li>
            </ul>
          </article>
          {!isAdmin && (
            <article className={styles.card}>
              <h2>Totales acumulados</h2>
              <ul>
                <li>Corridas: <strong>{formatNumber(state?.totals.runs)}</strong></li>
                <li>PDFs encontrados: <strong>{formatNumber(state?.totals.totalFound)}</strong></li>
                <li>Procesados: <strong>{formatNumber(state?.totals.processed)}</strong></li>
                <li>Duplicados: <strong>{formatNumber(state?.totals.duplicatesDetected)}</strong></li>
                <li>Fallidos: <strong>{formatNumber(state?.totals.failed)}</strong></li>
              </ul>
            </article>
          )}
          {!isAdmin && (
            <article className={styles.card}>
              <h2>Tokens usados</h2>
              <ul>
                <li>Input: <strong>{formatNumber(state?.totals.tokenUsage.inputTokens)}</strong></li>
                <li>Output: <strong>{formatNumber(state?.totals.tokenUsage.outputTokens)}</strong></li>
                <li>Total: <strong>{formatNumber(state?.totals.tokenUsage.totalTokens)}</strong></li>
                <li>Gemini: <strong>In {formatNumber(state?.totals.tokenUsage.byProvider.gemini?.inputTokens)} | Out {formatNumber(state?.totals.tokenUsage.byProvider.gemini?.outputTokens)} | Total {formatNumber(state?.totals.tokenUsage.byProvider.gemini?.totalTokens)}</strong></li>
                <li>OpenAI: <strong>In {formatNumber(state?.totals.tokenUsage.byProvider.openai?.inputTokens)} | Out {formatNumber(state?.totals.tokenUsage.byProvider.openai?.outputTokens)} | Total {formatNumber(state?.totals.tokenUsage.byProvider.openai?.totalTokens)}</strong></li>
              </ul>
            </article>
          )}
          {!isAdmin && (
            <article className={styles.card}>
              <h2>Cuota estimada</h2>
              <ul>
                <li>Gemini: <span className={`${styles.statusBadge} ${quotaLabel(state?.quota.gemini.status ?? "unknown") === "OK" ? styles.badgeOk : quotaLabel(state?.quota.gemini.status ?? "unknown") === "LIMITED" ? styles.badgeLimited : styles.badgeUnknown}`}>{quotaLabel(state?.quota.gemini.status ?? "unknown")}</span></li>
                <li className={styles.noteLine}>{state?.quota.gemini.note ?? EMPTY_DASH}</li>
                <li>OpenAI: <span className={`${styles.statusBadge} ${quotaLabel(state?.quota.openai.status ?? "unknown") === "OK" ? styles.badgeOk : quotaLabel(state?.quota.openai.status ?? "unknown") === "LIMITED" ? styles.badgeLimited : styles.badgeUnknown}`}>{quotaLabel(state?.quota.openai.status ?? "unknown")}</span></li>
                <li className={styles.noteLine}>{state?.quota.openai.note ?? EMPTY_DASH}</li>
                <li>APIs: <strong>Gemini {providers.geminiConfigured ? " ON" : " OFF"} | OpenAI{providers.openaiConfigured ? " ON" : " OFF"}</strong></li>
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
        {purgeTarget && (
          <div className={styles.purgeOverlay}>
            <div className={styles.purgeModal}>
              {purgeStep === "preview" && (
                <>
                  <h3 className={styles.purgeTitle}>Purgar boletas</h3>
                  {purgeLoading ? (
                    <p className={styles.purgeBody}>Cargando...</p>
                  ) : (
                    <>
                      <p className={styles.purgeBody}>
                        El cliente <strong>{purgeTarget.clientName}</strong> tiene <strong>{purgeCount}</strong> boletas.
                        Se eliminaran de la base de datos, se limpiaran las filas de Google Sheets
                        y se moveran los archivos de Drive de vuelta a Pendientes.
                      </p>
                      <div className={styles.purgeActions}>
                        <button type="button" className={styles.ghostBtn} onClick={handlePurgeClose}>Cancelar</button>
                        <button type="button" className={styles.purgeConfirmBtn} onClick={() => setPurgeStep("confirm")}>
                          Continuar
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
              {purgeStep === "confirm" && (
                <>
                  <h3 className={styles.purgeTitle}>Confirmar purga</h3>
                  <p className={styles.purgeBody}>
                    Esta accion <strong>no se puede deshacer</strong>. Se eliminaran {purgeCount} boletas
                    de <strong>{purgeTarget.clientName}</strong>.
                  </p>
                  <div className={styles.purgeActions}>
                    <button type="button" className={styles.ghostBtn} onClick={handlePurgeClose} disabled={purgeLoading}>Cancelar</button>
                    <button type="button" className={styles.purgeConfirmBtn} onClick={handlePurgeExecute} disabled={purgeLoading}>
                      {purgeLoading ? "Purgando..." : "Purgar todo"}
                    </button>
                  </div>
                </>
              )}
              {purgeStep === "result" && purgeResult && (
                <>
                  <h3 className={styles.purgeTitle}>Purga completada</h3>
                  <ul className={styles.purgeBody}>
                    <li>Boletas eliminadas: <strong>{purgeResult.deleted}</strong></li>
                    <li>Archivos movidos a Pendientes: <strong>{purgeResult.driveMovedBack}</strong></li>
                    <li>Fallos de Drive: <strong>{purgeResult.driveFailed}</strong></li>
                    <li>Sheets limpiado: <strong>{purgeResult.sheetsCleared ? "Si" : "No"}</strong></li>
                  </ul>
                  <div className={styles.purgeActions}>
                    <button type="button" className={styles.ghostBtn} onClick={handlePurgeClose}>Cerrar</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
