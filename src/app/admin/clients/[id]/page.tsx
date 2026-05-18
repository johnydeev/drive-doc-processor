"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import styles from "./page.module.css";
import { useAuthGuard } from "@/lib/useAuthGuard";

type ThemeMode = "dark" | "light";
const THEME_STORAGE_KEY = "dpp_admin_theme";

type ClientConfig = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  batchSize: number;
  intervalMinutes: number;
  sheetsId: string;
  altaSheetsId: string;
  sheetName: string;
  googleProjectId: string;
  googleClientEmail: string;
  driveFolderPending: string;
  driveFolderScanned: string;
  driveFolderUnassigned: string;
  driveFolderFailed: string;
  driveFolderReceipts: string;
  hasPrivateKey: boolean;
  hasGeminiApiKey: boolean;
  hasOpenaiApiKey: boolean;
  hasAnthropicApiKey: boolean;
};

type FormState = {
  name: string;
  isActive: boolean;
  batchSize: number;
  intervalMinutes: number;
  sheetsId: string;
  altaSheetsId: string;
  sheetName: string;
  googleProjectId: string;
  googleClientEmail: string;
  googlePrivateKey: string;
  driveFolderPending: string;
  driveFolderScanned: string;
  driveFolderUnassigned: string;
  driveFolderFailed: string;
  driveFolderReceipts: string;
  geminiApiKey: string;
  openaiApiKey: string;
  anthropicApiKey: string;
};

export default function EditClientPage() {
  const params = useParams();
  const clientId = params.id as string;
  const router = useRouter();
  const { guardedFetch } = useAuthGuard();

  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [form, setForm] = useState<FormState>({
    name: "",
    isActive: true,
    batchSize: 10,
    intervalMinutes: 60,
    sheetsId: "",
    altaSheetsId: "",
    sheetName: "",
    googleProjectId: "",
    googleClientEmail: "",
    googlePrivateKey: "",
    driveFolderPending: "",
    driveFolderScanned: "",
    driveFolderUnassigned: "",
    driveFolderFailed: "",
    driveFolderReceipts: "",
    geminiApiKey: "",
    openaiApiKey: "",
    anthropicApiKey: "",
  });

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "dark" || stored === "light") setTheme(stored);
    } catch { /* no-op */ }
  }, []);

  const set = (field: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));

  const fetchClient = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await guardedFetch(`/api/admin/clients/${clientId}`, { cache: "no-store" });
      const data = (await res.json()) as { ok?: boolean; error?: string; client?: ClientConfig };
      if (!res.ok || !data.ok || !data.client) throw new Error(data.error ?? `HTTP ${res.status}`);
      setConfig(data.client);
      setForm({
        name: data.client.name,
        isActive: data.client.isActive,
        batchSize: data.client.batchSize ?? 10,
        intervalMinutes: data.client.intervalMinutes ?? 60,
        sheetsId: data.client.sheetsId,
        altaSheetsId: data.client.altaSheetsId,
        sheetName: data.client.sheetName,
        googleProjectId: data.client.googleProjectId,
        googleClientEmail: data.client.googleClientEmail,
        googlePrivateKey: "",
        driveFolderPending: data.client.driveFolderPending,
        driveFolderScanned: data.client.driveFolderScanned,
        driveFolderUnassigned: data.client.driveFolderUnassigned,
        driveFolderFailed: data.client.driveFolderFailed,
        driveFolderReceipts: data.client.driveFolderReceipts,
        geminiApiKey: "",
        openaiApiKey: "",
        anthropicApiKey: "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el cliente");
    } finally {
      setLoading(false);
    }
  }, [clientId, guardedFetch]);

  useEffect(() => { void fetchClient(); }, [fetchClient]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        isActive: form.isActive,
        batchSize: Number(form.batchSize),
        intervalMinutes: Number(form.intervalMinutes),
        sheetsId: form.sheetsId,
        altaSheetsId: form.altaSheetsId || null,
        sheetName: form.sheetName,
        googleProjectId: form.googleProjectId,
        googleClientEmail: form.googleClientEmail,
        driveFolderPending: form.driveFolderPending,
        driveFolderScanned: form.driveFolderScanned,
        driveFolderUnassigned: form.driveFolderUnassigned || null,
        driveFolderFailed: form.driveFolderFailed || null,
        driveFolderReceipts: form.driveFolderReceipts || null,
      };
      // Solo enviar claves sensibles si el usuario las rellenó
      if (form.googlePrivateKey.trim()) payload.googlePrivateKey = form.googlePrivateKey.trim();
      if (form.geminiApiKey.trim()) payload.geminiApiKey = form.geminiApiKey.trim();
      if (form.openaiApiKey.trim()) payload.openaiApiKey = form.openaiApiKey.trim();
      if (form.anthropicApiKey.trim()) payload.anthropicApiKey = form.anthropicApiKey.trim();

      const res = await guardedFetch(`/api/admin/clients/${clientId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSuccess("Configuración guardada correctamente.");
      await fetchClient();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.page} data-theme={theme}>
      <div className={styles.gridBackdrop} />
      <main className={styles.panel}>

        <header className={styles.header}>
          <div className={styles.headerText}>
            <p className={styles.eyebrow}>Configuración de cliente</p>
            <h1>{loading ? "Cargando..." : (config?.name ?? "Cliente")}</h1>
            {config && (
              <p className={styles.caption}>
                {config.email}&nbsp;&nbsp;
                <span className={`${styles.badge} ${config.isActive ? styles.badgeActive : styles.badgeInactive}`}>
                  {config.isActive ? "ACTIVO" : "INACTIVO"}
                </span>
              </p>
            )}
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => router.push("/admin")}
            >
              Volver al panel
            </button>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => setTheme((t) => t === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? "Modo claro" : "Modo oscuro"}
            </button>
          </div>
        </header>

        {error && <p className={styles.error}>{error}</p>}
        {success && <p className={styles.success}>{success}</p>}

        {loading && <p className={styles.loader}>Cargando configuración...</p>}

        {!loading && config && (
          <form className={styles.form} onSubmit={handleSubmit}>

            {/* General */}
            <section className={styles.section}>
              <p className={styles.sectionLabel}>General</p>
              <div className={styles.grid}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Nombre de empresa</label>
                  <input className={styles.input} value={form.name} onChange={set("name")} required />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Email (solo lectura)</label>
                  <input className={styles.input} value={config.email} readOnly disabled />
                </div>
                <div className={`${styles.field} ${styles.gridFull}`}>
                  <div className={styles.toggleRow}>
                    <label className={styles.toggle}>
                      <input
                        type="checkbox"
                        checked={form.isActive}
                        onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                      />
                      <span className={styles.toggleSlider} />
                    </label>
                    <span className={styles.toggleLabel}>
                      Cliente {form.isActive ? "activo" : "inactivo"} — el scheduler{form.isActive ? " procesa" : " no procesa"} sus archivos
                    </span>
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Tamano de lote</label>
                  <input
                    className={styles.input}
                    type="number"
                    min={1}
                    max={500}
                    value={form.batchSize}
                    onChange={(e) => setForm((f) => ({ ...f, batchSize: Math.max(1, Number(e.target.value) || 1) }))}
                  />
                  <span className={styles.configuredHint}>PDFs procesados por ciclo del scheduler</span>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Intervalo del scheduler</label>
                  <input
                    className={styles.input}
                    type="number"
                    min={1}
                    max={1440}
                    value={form.intervalMinutes}
                    onChange={(e) => setForm((f) => ({ ...f, intervalMinutes: Math.max(1, Number(e.target.value) || 60) }))}
                  />
                  <span className={styles.configuredHint}>Minutos entre cada ciclo de escaneo (1-1440)</span>
                </div>
              </div>
            </section>

            {/* Google Sheets */}
            <section className={styles.section}>
              <p className={styles.sectionLabel}>Google Sheets</p>
              <div className={styles.grid}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>ID archivo Datos *</label>
                  <input className={styles.input} value={form.sheetsId} onChange={set("sheetsId")} required placeholder="1BxiMVs0XRA..." />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>ID archivo ALTA (directorio)</label>
                  <input className={styles.input} value={form.altaSheetsId} onChange={set("altaSheetsId")} placeholder="Opcional — para sincronizar directorio" />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Nombre de hoja</label>
                  <input className={styles.input} value={form.sheetName} onChange={set("sheetName")} placeholder="Datos" />
                </div>
              </div>
            </section>

            {/* Drive */}
            <section className={styles.section}>
              <p className={styles.sectionLabel}>Carpetas Google Drive</p>
              <div className={styles.grid}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Pendientes *</label>
                  <input className={styles.input} value={form.driveFolderPending} onChange={set("driveFolderPending")} required placeholder="ID de carpeta" />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Escaneados *</label>
                  <input className={styles.input} value={form.driveFolderScanned} onChange={set("driveFolderScanned")} required placeholder="ID de carpeta" />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Sin asignar</label>
                  <input className={styles.input} value={form.driveFolderUnassigned} onChange={set("driveFolderUnassigned")} placeholder="Opcional" />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Fallidos</label>
                  <input className={styles.input} value={form.driveFolderFailed} onChange={set("driveFolderFailed")} placeholder="Opcional" />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Recibos</label>
                  <input className={styles.input} value={form.driveFolderReceipts} onChange={set("driveFolderReceipts")} placeholder="Opcional" />
                </div>
              </div>
            </section>

            {/* Credenciales Google */}
            <section className={styles.section}>
              <p className={styles.sectionLabel}>Credenciales Google Service Account</p>
              <div className={styles.grid}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Project ID</label>
                  <input className={styles.input} value={form.googleProjectId} onChange={set("googleProjectId")} placeholder="mi-proyecto-123" />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Service Account Email</label>
                  <input className={styles.input} type="email" value={form.googleClientEmail} onChange={set("googleClientEmail")} placeholder="sa@proyecto.iam.gserviceaccount.com" />
                </div>
                <div className={`${styles.field} ${styles.gridFull}`}>
                  <label className={styles.fieldLabel}>Private Key</label>
                  <textarea
                    className={styles.textarea}
                    value={form.googlePrivateKey}
                    onChange={set("googlePrivateKey")}
                    placeholder={config.hasPrivateKey ? "Configurado — dejalo vacío para no cambiar" : "-----BEGIN RSA PRIVATE KEY-----..."}
                  />
                  {config.hasPrivateKey && !form.googlePrivateKey && (
                    <span className={styles.configuredHint}>Clave configurada</span>
                  )}
                </div>
              </div>
            </section>

            {/* Claves IA */}
            <section className={styles.section}>
              <p className={styles.sectionLabel}>Claves de IA</p>
              <div className={styles.grid}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Gemini API Key</label>
                  <input
                    className={styles.input}
                    value={form.geminiApiKey}
                    onChange={set("geminiApiKey")}
                    placeholder={config.hasGeminiApiKey ? "Configurado — dejalo vacío para no cambiar" : "AIza..."}
                  />
                  {config.hasGeminiApiKey && !form.geminiApiKey && (
                    <span className={styles.configuredHint}>Clave configurada</span>
                  )}
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>OpenAI API Key</label>
                  <input
                    className={styles.input}
                    value={form.openaiApiKey}
                    onChange={set("openaiApiKey")}
                    placeholder={config.hasOpenaiApiKey ? "Configurado — dejalo vacío para no cambiar" : "sk-..."}
                  />
                  {config.hasOpenaiApiKey && !form.openaiApiKey && (
                    <span className={styles.configuredHint}>Clave configurada</span>
                  )}
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Anthropic API Key</label>
                  <input
                    className={styles.input}
                    value={form.anthropicApiKey}
                    onChange={set("anthropicApiKey")}
                    placeholder={config.hasAnthropicApiKey ? "Configurado — dejalo vacío para no cambiar" : "sk-ant-..."}
                  />
                  {config.hasAnthropicApiKey && !form.anthropicApiKey && (
                    <span className={styles.configuredHint}>Clave configurada</span>
                  )}
                </div>
              </div>
            </section>

            <div className={styles.footer}>
              <button type="button" className={styles.ghostBtn} onClick={() => router.push("/admin")} disabled={saving}>
                Cancelar
              </button>
              <button type="submit" className={styles.saveBtn} disabled={saving}>
                {saving ? "Guardando..." : "Guardar cambios"}
              </button>
            </div>

          </form>
        )}

      </main>
    </div>
  );
}
