"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { useAuthGuard } from "@/lib/useAuthGuard";

const TIPOS_COMPROBANTE = [
  "A", "B", "C", "E", "M", "X",
  "Ticket", "Recibo", "Liq. Serv. Público", "Otro",
] as const;

const TIPOS_GASTO = [
  { value: "ORDINARIO",      label: "Ordinario" },
  { value: "EXTRAORDINARIO", label: "Extraordinario" },
  { value: "PARTICULAR",     label: "Particular" },
] as const;

type Period      = { id: string; year: number; month: number; status: "ACTIVE" | "CLOSED"; };
type Coeficiente = { id: string; name: string; value: number; };
type Rubro       = { id: string; name: string; };
type Consortium  = { id: string; canonicalName: string; rawName: string; cuit: string | null; cutoffDay: number; matchNames: string | null; bank: string | null; periods: Period[]; _count: { invoices: number }; };
type Provider    = { id: string; canonicalName: string; cuit: string | null; paymentAlias: string | null; providerType?: "PROVEEDOR" | "EMPLEADO"; };
type Invoice     = {
  id: string; boletaNumber: string | null; provider: string | null; providerTaxId: string | null;
  detail: string | null; observation: string | null; issueDate: string | null; dueDate: string | null;
  amount: number | null; isDuplicate: boolean; isManual: boolean; sourceFileUrl: string | null;
  tipoGasto: string; tipoComprobante: string | null; createdAt: string;
  coeficienteRef: { id: string; name: string; value: number } | null;
  rubroRef: { id: string; name: string } | null;
  isPaid: boolean;
  remainingBalance: number | null;
  lspServiceId: string | null;
  providerType?: "PROVEEDOR" | "EMPLEADO";
};
type ScannedData = {
  boletaNumber: string | null; provider: string | null; providerTaxId: string | null;
  detail: string | null; observation: string | null; issueDate: string | null;
  dueDate: string | null; amount: number | null; tipoComprobante: string | null;
};

const MONTH_NAMES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

function formatPeriod(p: Period | null | undefined) {
  if (!p) return "Sin período activo";
  return `${MONTH_NAMES[p.month - 1]} ${p.year}`;
}
function formatAmount(v: number | null | undefined) {
  if (v == null) return "—";
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(v);
}
// Formato es-AR sin símbolo de moneda — útil para placeholders de inputs.
function formatAmountPlain(v: number | null | undefined) {
  if (v == null) return "";
  return new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}
// Acepta lo que el usuario tipea: "97500,40", "97.500,40", "97500.40", "97,500.40".
// Decide cuál es el separador decimal por el último que aparezca.
function parseAmountInput(raw: string): number {
  if (!raw) return NaN;
  const cleaned = raw.replace(/\s/g, "").replace(/[^\d.,-]/g, "");
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized: string;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, "");
  } else {
    normalized = cleaned.replace(",", ".");
  }
  return Number(normalized);
}
function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-AR");
}
function toInputDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}
function todayInputDate(): string {
  return new Date().toISOString().slice(0, 10);
}
function normCuit(v: string | null | undefined): string { return (v ?? "").replace(/\D/g, ""); }
function normName(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/[.,\-_]/g, " ").replace(/\s+/g, " ").trim();
}
function matchProvider(providers: Provider[], extracted: ScannedData): Provider | undefined {
  if (extracted.providerTaxId) {
    const norm = normCuit(extracted.providerTaxId);
    if (norm.length >= 10) {
      const hit = providers.find((p) => normCuit(p.cuit) === norm);
      if (hit) return hit;
    }
  }
  if (extracted.provider) {
    const norm = normName(extracted.provider);
    if (norm.length >= 3) {
      const hit = providers.find((p) => normName(p.canonicalName) === norm || (p.paymentAlias && normName(p.paymentAlias) === norm));
      if (hit) return hit;
    }
  }
  return undefined;
}

type InvoiceForm = {
  providerId: string; boletaNumber: string; providerTaxId: string;
  detail: string; observation: string; issueDate: string; dueDate: string;
  amount: string; coeficienteId: string; newCoefName: string; newCoefValue: string;
  rubroId: string; newRubroName: string;
  tipoGasto: string; tipoComprobante: string;
};

const EMPTY_INVOICE_FORM: InvoiceForm = {
  providerId: "", boletaNumber: "", providerTaxId: "", detail: "", observation: "",
  issueDate: todayInputDate(), dueDate: "", amount: "",
  coeficienteId: "", newCoefName: "", newCoefValue: "",
  rubroId: "", newRubroName: "",
  tipoGasto: "ORDINARIO", tipoComprobante: "",
};

type LspService = {
  id: string; providerName: string; clientNumber: string; description: string | null;
};

const LSP_PROVIDERS = [
  { value: "EDESUR",      label: "Edesur" },
  { value: "AYSA",        label: "AySA" },
  { value: "EDENOR",      label: "Edenor" },
  { value: "METROGAS",    label: "Metrogas" },
  { value: "NATURGY",     label: "Naturgy" },
  { value: "CAMUZZI",     label: "Camuzzi" },
  { value: "LITORAL_GAS", label: "Litoral Gas" },
  { value: "PERSONAL",    label: "Personal" },
] as const;

type ThemeMode = "dark" | "light";

type CloseAllPreview = {
  majorityMonth: string | null;
  nextMonth: string | null;
  toClose: { id: string; canonicalName: string; currentPeriod: string }[];
  toSkip: { id: string; canonicalName: string; currentPeriod: string }[];
};

export default function ConsortiumsPage() {
  const router = useRouter();
  const { guardedFetch } = useAuthGuard();
  const [accessChecked, setAccessChecked] = useState(false);
  const [userName, setUserName] = useState("");
  const [userRole, setUserRole] = useState<string>("");
  const [consortiumsEnabled, setConsortiumsEnabled] = useState(false);

  // Theme (session-only). El toggle vive en el panel principal (/admin); acá solo
  // leemos el data-theme que dejó esa página al cargar (si existe) y default a "dark".
  const [theme, setTheme] = useState<ThemeMode>("dark");

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    if (current === "light" || current === "dark") setTheme(current);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Nav sidebar
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [navMobileOpen, setNavMobileOpen] = useState(false);

  // Close all periods
  const [showCloseAllModal, setShowCloseAllModal] = useState(false);
  const [closeAllStep, setCloseAllStep] = useState<"preview" | "result">("preview");
  const [closeAllPreview, setCloseAllPreview] = useState<CloseAllPreview | null>(null);
  const [closeAllLoading, setCloseAllLoading] = useState(false);
  const [closeAllResult, setCloseAllResult] = useState<{ closed: number; skipped: number; warnings: string[] } | null>(null);
  const [closeAllError, setCloseAllError] = useState<string | null>(null);

  // Unassigned requeue
  const [showUnassignedModal, setShowUnassignedModal] = useState(false);
  const [unassignedStep, setUnassignedStep] = useState<"preview" | "result">("preview");
  const [unassignedFiles, setUnassignedFiles] = useState<{ id: string; name: string }[]>([]);
  const [unassignedFolderConfigured, setUnassignedFolderConfigured] = useState(true);
  const [unassignedResult, setUnassignedResult] = useState<{ moved: number; failed: number } | null>(null);
  const [loadingUnassigned, setLoadingUnassigned] = useState(false);

  // Scheduler control
  const [schedulerEnabled, setSchedulerEnabled] = useState<boolean | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toolbarInfo, setToolbarInfo] = useState<string | null>(null);
  const [toolbarError, setToolbarError] = useState<string | null>(null);

  // Autodismiss del toast (4s). Antes los mensajes vivían en el toolbar y se
  // quedaban hasta la próxima acción — ahora son un toast flotante, así que
  // los limpiamos solos para que no queden colgados.
  useEffect(() => {
    if (!toolbarInfo) return;
    const t = setTimeout(() => setToolbarInfo(null), 4000);
    return () => clearTimeout(t);
  }, [toolbarInfo]);
  useEffect(() => {
    if (!toolbarError) return;
    const t = setTimeout(() => setToolbarError(null), 5000);
    return () => clearTimeout(t);
  }, [toolbarError]);

  useEffect(() => {
    (async () => {
      try {
        const res = await guardedFetch("/api/auth/me", { method: "GET", cache: "no-store" });
        const data = (await res.json()) as { ok: boolean; user?: { name?: string; role?: string; consortiumsEnabled?: boolean } };
        if (!data.ok || !data.user?.consortiumsEnabled) {
          router.replace("/admin");
          return;
        }
        setUserName(data.user.name ?? data.user.role ?? "");
        setUserRole(data.user.role ?? "");
        setConsortiumsEnabled(data.user.consortiumsEnabled ?? false);
        setAccessChecked(true);
      } catch {
        router.replace("/admin");
      }
    })();
  }, [guardedFetch, router]);

  // Fetch scheduler status for toolbar
  useEffect(() => {
    if (!accessChecked) return;
    (async () => {
      try {
        const res = await guardedFetch("/api/admin/scheduler/status", { method: "GET", cache: "no-store" });
        const data = await res.json();
        if (data.ok && data.state) setSchedulerEnabled(data.state.enabled);
      } catch { /* silent */ }
    })();
  }, [accessChecked, guardedFetch]);

  const handleToggleScheduler = async () => {
    if (schedulerEnabled === null) return;
    setBusyAction("toggle"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/admin/scheduler/toggle", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !schedulerEnabled }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSchedulerEnabled(data.state.enabled);
      setToolbarInfo(data.state.enabled ? "Scheduler encendido." : "Scheduler pausado.");
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleRunNow = async () => {
    setBusyAction("run"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/admin/scheduler/run", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setToolbarInfo("Ejecución manual completada.");
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleSyncDirectory = async () => {
    setBusyAction("sync"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/sync-directory", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const counts = `C: ${data.consortiumsCount ?? 0} | P: ${data.providersCount ?? 0} | R: ${data.rubrosCount ?? 0}`;
      setToolbarInfo(`Directorio sincronizado. ${counts}`);
      void fetchConsortiums();
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleSyncPayments = async () => {
    setBusyAction("syncPayments"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/sync-payments", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const counts = `Creados: ${data.paymentsCreated ?? 0} | Actualizados: ${data.paymentsUpdated ?? 0} | Boletas: ${data.invoicesAffected ?? 0}`;
      setToolbarInfo(`Pagos sincronizados. ${counts}`);
      if (selectedId && selectedPeriod) {
        void fetchInvoices(selectedId, selectedPeriod.id);
      }
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleSetupSheetProtection = async () => {
    setBusyAction("protectSheet"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/setup-sheet-protection", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const syncInfo = data.sync
        ? ` Sync previo: ${data.sync.paymentsCreated} creados, ${data.sync.paymentsUpdated} actualizados.`
        : "";
      setToolbarInfo(`Hoja protegida (${data.columnsProtected ?? 0} columnas).${syncInfo}`);
      if (selectedId && selectedPeriod) {
        void fetchInvoices(selectedId, selectedPeriod.id);
      }
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleUnprotectSheet = async () => {
    if (!window.confirm(
      "Vas a desproteger la hoja. Vas a poder editar las columnas en Google Sheets " +
      "directamente. Recordá apretar 'Proteger hoja' cuando termines — eso disparará " +
      "una sincronización automática para volcar tus cambios a la base.\n\n¿Continuar?"
    )) return;

    setBusyAction("unprotectSheet"); setToolbarError(null); setToolbarInfo(null);
    try {
      const res = await guardedFetch("/api/client/setup-sheet-protection", {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setToolbarInfo(
        data.removedRanges > 0
          ? `Hoja desprotegida. Acordate de re-bloquearla cuando termines.`
          : `La hoja ya estaba desprotegida.`
      );
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error");
    } finally { setBusyAction(null); }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch { /* silent */ }
  };

  const handleCloseAllPreview = async () => {
    setCloseAllLoading(true); setCloseAllError(null); setCloseAllResult(null); setCloseAllStep("preview");
    try {
      const res = await guardedFetch("/api/client/periods/close-all/preview", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCloseAllPreview(data);
      setShowCloseAllModal(true);
    } catch (err) {
      setCloseAllError(err instanceof Error ? err.message : "Error");
      setShowCloseAllModal(true);
    } finally { setCloseAllLoading(false); }
  };

  const handleCloseAllExecute = async () => {
    setCloseAllLoading(true); setCloseAllError(null);
    try {
      const res = await guardedFetch("/api/client/periods/close-all", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCloseAllResult({ closed: data.closed, skipped: data.skipped, warnings: data.warnings ?? [] });
      setCloseAllStep("result");
      void fetchConsortiums();
    } catch (err) {
      setCloseAllError(err instanceof Error ? err.message : "Error");
    } finally { setCloseAllLoading(false); }
  };

  const handleOpenUnassigned = async () => {
    setShowUnassignedModal(true);
    setUnassignedStep("preview");
    setUnassignedResult(null);
    setUnassignedFiles([]);
    setUnassignedFolderConfigured(true);
    setLoadingUnassigned(true);
    try {
      const res = await guardedFetch("/api/client/unassigned/preview", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUnassignedFolderConfigured(data.folderConfigured ?? false);
      setUnassignedFiles(data.files ?? []);
    } catch (err) {
      setUnassignedFolderConfigured(false);
      setUnassignedFiles([]);
    } finally { setLoadingUnassigned(false); }
  };

  const handleRequeue = async () => {
    setLoadingUnassigned(true);
    try {
      const res = await guardedFetch("/api/client/unassigned/requeue", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUnassignedResult({ moved: data.moved ?? 0, failed: data.failed ?? 0 });
      setUnassignedStep("result");
    } catch (err) {
      setUnassignedResult({ moved: 0, failed: unassignedFiles.length });
      setUnassignedStep("result");
    } finally { setLoadingUnassigned(false); }
  };

  const [consortiums, setConsortiums] = useState<Consortium[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConsortium, setSelectedConsortium] = useState<Consortium | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<Period | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"boletas" | "pagos">("boletas");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [coeficientes, setCoeficientes] = useState<Coeficiente[]>([]);
  const [rubros, setRubros] = useState<Rubro[]>([]);

  // Receipt upload state — un input ref oculto por invoice
  const receiptInputRef = useRef<HTMLInputElement>(null);
  const [uploadingReceiptId, setUploadingReceiptId] = useState<string | null>(null);

  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closingPeriod, setClosingPeriod] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closeSuccess, setCloseSuccess] = useState<string | null>(null);

  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanWarning, setScanWarning] = useState<string | null>(null);
  const [matchedProvider, setMatchedProvider] = useState<Provider | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [invoiceForm, setInvoiceForm] = useState<InvoiceForm>(EMPTY_INVOICE_FORM);
  const [savingInvoice, setSavingInvoice] = useState(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);

  const [showMismatchModal, setShowMismatchModal] = useState(false);
  const [mismatchFoundConsortium, setMismatchFoundConsortium] = useState<string | null>(null);

  const [showProviderModal, setShowProviderModal] = useState(false);
  const [providerForm, setProviderForm] = useState({ canonicalName: "", cuit: "", paymentAlias: "" });
  const [savingProvider, setSavingProvider] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerSuccess, setProviderSuccess] = useState<string | null>(null);

  const [showConsortiumModal, setShowConsortiumModal] = useState(false);
  const [consortiumForm, setConsortiumForm] = useState({ canonicalName: "", cuit: "" });
  const [savingConsortium, setSavingConsortium] = useState(false);
  const [consortiumError, setConsortiumError] = useState<string | null>(null);
  const [consortiumSuccess, setConsortiumSuccess] = useState<string | null>(null);

  // matchNames editing (inside config modal)
  const [editingMatchNames, setEditingMatchNames] = useState(false);
  const [matchNamesValue, setMatchNamesValue] = useState("");
  const [savingMatchNames, setSavingMatchNames] = useState(false);
  const [matchNamesMsg, setMatchNamesMsg] = useState<string | null>(null);
  const [showConfigModal, setShowConfigModal] = useState(false);

  // LspServices
  const [lspServices, setLspServices] = useState<LspService[]>([]);
  const [lspForm, setLspForm] = useState({ provider: "", clientNumber: "", description: "" });
  const [savingLsp, setSavingLsp] = useState(false);
  const [lspError, setLspError] = useState<string | null>(null);
  const [deletingLspId, setDeletingLspId] = useState<string | null>(null);
  const [confirmDeleteLspId, setConfirmDeleteLspId] = useState<string | null>(null);

  // Eliminar boleta (pestaña Boletas)
  const [confirmDeleteInvoiceId, setConfirmDeleteInvoiceId] = useState<string | null>(null);
  const [deletingInvoiceId, setDeletingInvoiceId] = useState<string | null>(null);
  // Sección LSP colapsable. Default colapsada para ahorrar espacio visual —
  // la mayoría de las veces los servicios públicos ya están cargados y no
  // se necesita interactuar. Se abre on-demand para ver, agregar o eliminar.
  const [lspCollapsed, setLspCollapsed] = useState(true);

  // Payment modal — soporta dos modos según PaymentRepository:
  //   Modo A (cuotas pactadas): primer pago define totalInstallments. El backend calcula
  //     el monto fijo como amount/totalInstallments. El installmentNumber arranca en 1 y
  //     autoincrementa. Última cuota absorbe redondeo.
  //   Modo B (libre): sin totalInstallments. El usuario fija el monto cada vez.
  //   El modo se fija en el primer pago y NO se puede cambiar después.
  type PaymentMode = "cuotas" | "libre";
  type PaymentRecord = {
    id: string; amount: string | number; paymentDate: string;
    installmentNumber: number | null; totalInstallments: number | null;
    paymentMethod: string | null; driveFileUrl: string | null; observation: string | null;
  };

  const [payModalInvoice, setPayModalInvoice] = useState<Invoice | null>(null);
  const [existingPayments, setExistingPayments] = useState<PaymentRecord[]>([]);
  const [loadingExistingPayments, setLoadingExistingPayments] = useState(false);
  // Modo elegido en primer pago — solo aplica cuando existingPayments.length === 0
  const [chosenMode, setChosenMode] = useState<PaymentMode>("libre");
  const [payForm, setPayForm] = useState({
    amount: "",
    paymentDate: todayInputDate(),
    totalInstallments: "",
    paymentMethod: "",
    observation: "",
  });
  const [payFile, setPayFile] = useState<File | null>(null);
  const [savingPayment, setSavingPayment] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const payFileInputRef = useRef<HTMLInputElement>(null);

  // Derivados del modo activo
  const activeMode: PaymentMode | null = existingPayments.length === 0
    ? null
    : existingPayments[0].totalInstallments !== null ? "cuotas" : "libre";
  const effectiveMode: PaymentMode = activeMode ?? chosenMode;
  const isFirstPayment = existingPayments.length === 0;
  const installmentsLocked = existingPayments[0]?.totalInstallments ?? null;
  const currentInstallmentNumber = installmentsLocked ? existingPayments.length + 1 : null;
  const isLastInstallment = installmentsLocked !== null && currentInstallmentNumber === installmentsLocked;
  const invoiceAmount = Number(payModalInvoice?.amount ?? 0);
  const invoiceRemaining = payModalInvoice?.remainingBalance !== null && payModalInvoice?.remainingBalance !== undefined
    ? Number(payModalInvoice.remainingBalance)
    : invoiceAmount;

  // Monto que efectivamente se va a registrar (lo calculamos siempre para mostrarlo,
  // aunque en cuotas el backend lo recalcula)
  let computedAmount = 0;
  if (effectiveMode === "cuotas") {
    if (isLastInstallment) {
      computedAmount = invoiceRemaining;
    } else {
      const total = installmentsLocked ?? (Number(payForm.totalInstallments) || 0);
      computedAmount = total > 0 ? Number((invoiceAmount / total).toFixed(2)) : 0;
    }
  } else {
    computedAmount = Number(payForm.amount) || 0;
  }

  const handleOpenPayModal = async (inv: Invoice) => {
    setPayModalInvoice(inv);
    setPayFile(null);
    setPayError(null);
    setChosenMode("libre");
    setPayForm({
      amount: String(inv.remainingBalance ?? inv.amount ?? ""),
      paymentDate: todayInputDate(),
      totalInstallments: "",
      paymentMethod: "",
      observation: "",
    });
    setExistingPayments([]);
    setLoadingExistingPayments(true);
    try {
      const res = await guardedFetch(`/api/client/invoices/${inv.id}/payments`, { cache: "no-store" });
      const data = await res.json();
      if (data.ok && Array.isArray(data.payments)) {
        setExistingPayments(data.payments);
      }
    } catch { /* silent — sin historial seguimos como primer pago */ }
    finally { setLoadingExistingPayments(false); }
  };

  const handleClosePayModal = () => {
    if (savingPayment) return;
    setPayModalInvoice(null);
    setPayFile(null);
    setPayError(null);
    setExistingPayments([]);
  };

  const handleSubmitPayment = async () => {
    if (!payModalInvoice) return;

    // Validación de campos requeridos. Se acumulan todos los errores y se
    // muestran juntos para no obligar al usuario a corregir uno por uno.
    const missing: string[] = [];
    if (!payForm.paymentDate) missing.push("fecha de pago");

    let amountToSend = 0;
    let installmentsToSend: number | null = null;
    let modeErr: string | null = null;

    if (effectiveMode === "cuotas") {
      if (installmentsLocked !== null) {
        installmentsToSend = installmentsLocked;
        amountToSend = computedAmount;
      } else {
        const inst = Number(payForm.totalInstallments);
        if (!Number.isInteger(inst) || inst < 2) {
          modeErr = "Las cuotas deben ser un entero mayor o igual a 2";
        } else {
          installmentsToSend = inst;
          amountToSend = computedAmount;
        }
      }
    } else {
      amountToSend = Number(payForm.amount);
      if (!Number.isFinite(amountToSend) || amountToSend <= 0) {
        modeErr = "El monto debe ser un número positivo";
      }
    }

    if (!payForm.paymentMethod) missing.push("medio de pago");
    if (!payFile) missing.push("comprobante PDF");

    if (missing.length > 0 || modeErr) {
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`Faltan campos: ${missing.join(", ")}.`);
      if (modeErr) parts.push(modeErr);
      setPayError(parts.join(" "));
      return;
    }

    setSavingPayment(true);
    setPayError(null);
    try {
      const formData = new FormData();
      formData.append("amount", String(amountToSend));
      formData.append("paymentDate", payForm.paymentDate);
      if (installmentsToSend && isFirstPayment) {
        formData.append("totalInstallments", String(installmentsToSend));
      }
      if (payForm.paymentMethod) formData.append("paymentMethod", payForm.paymentMethod);
      if (payForm.observation) formData.append("observation", payForm.observation);
      if (payFile) formData.append("receipt", payFile);

      const res = await fetch(`/api/client/invoices/${payModalInvoice.id}/payments`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      setPayModalInvoice(null);
      setPayFile(null);
      setExistingPayments([]);
      if (selectedId && selectedPeriod) void fetchInvoices(selectedId, selectedPeriod.id);
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "Error al registrar el pago");
    } finally {
      setSavingPayment(false);
    }
  };

  // ─── Modal Ver pagos (read-only para invoice.isPaid) ───
  const [viewPaymentsInvoice, setViewPaymentsInvoice] = useState<Invoice | null>(null);
  const [viewPaymentsList, setViewPaymentsList] = useState<PaymentRecord[]>([]);
  const [loadingViewPayments, setLoadingViewPayments] = useState(false);

  const handleOpenViewPayments = async (inv: Invoice) => {
    setViewPaymentsInvoice(inv);
    setViewPaymentsList([]);
    setLoadingViewPayments(true);
    try {
      const res = await guardedFetch(`/api/client/invoices/${inv.id}/payments`, { cache: "no-store" });
      const data = await res.json();
      if (data.ok && Array.isArray(data.payments)) setViewPaymentsList(data.payments);
    } catch { /* silent */ }
    finally { setLoadingViewPayments(false); }
  };

  const fetchConsortiums = useCallback(async () => {
    setLoadingList(true); setListError(null);
    try {
      const res = await guardedFetch("/api/client/consortiums", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setConsortiums(data.consortiums ?? []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Error al cargar consorcios");
    } finally { setLoadingList(false); }
  }, [guardedFetch]);

  useEffect(() => { void fetchConsortiums(); }, [fetchConsortiums]);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await guardedFetch("/api/client/providers", { cache: "no-store" });
      const data = await res.json();
      if (data.ok) setProviders(data.providers ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  useEffect(() => { void fetchProviders(); }, [fetchProviders]);

  const fetchPeriodsAndInvoices = useCallback(async (consortiumId: string, periodId?: string) => {
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/periods`);
      const data = await res.json();
      if (!data.ok) return;
      const allPeriods: Period[] = data.periods ?? [];
      setPeriods(allPeriods);
      const target = periodId
        ? allPeriods.find((p) => p.id === periodId)
        : allPeriods.find((p) => p.status === "ACTIVE") ?? allPeriods[0];
      setSelectedPeriod(target ?? null);
      return target?.id;
    } catch { return undefined; }
  }, [guardedFetch]);

  const fetchInvoices = useCallback(async (consortiumId: string, periodId: string) => {
    setLoadingInvoices(true); setInvoicesError(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/invoices?periodId=${periodId}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInvoices(data.invoices ?? []);
    } catch (err) {
      setInvoicesError(err instanceof Error ? err.message : "Error al cargar boletas");
    } finally { setLoadingInvoices(false); }
  }, [guardedFetch]);

  const fetchCoeficientes = useCallback(async (consortiumId: string) => {
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/coeficientes`);
      const data = await res.json();
      if (data.ok) setCoeficientes(data.coeficientes ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  const fetchRubros = useCallback(async (consortiumId: string) => {
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/rubros`);
      const data = await res.json();
      if (data.ok) setRubros(data.rubros ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  const fetchLspServices = useCallback(async (consortiumId: string) => {
    try {
      const res = await guardedFetch(`/api/client/consortiums/${consortiumId}/lsp-services`);
      const data = await res.json();
      if (data.ok) setLspServices(data.lspServices ?? []);
    } catch { /* silent */ }
  }, [guardedFetch]);

  const handleSaveMatchNames = async () => {
    if (!selectedId) return;
    setSavingMatchNames(true); setMatchNamesMsg(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${selectedId}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ matchNames: matchNamesValue.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSelectedConsortium((prev) => prev ? { ...prev, matchNames: data.consortium.matchNames } : prev);
      setEditingMatchNames(false);
      setMatchNamesMsg("Guardado correctamente");
      setTimeout(() => setMatchNamesMsg(null), 3000);
    } catch (err) {
      setMatchNamesMsg(err instanceof Error ? err.message : "Error al guardar");
    } finally { setSavingMatchNames(false); }
  };

  const handleAddLsp = async () => {
    if (!selectedId) return;
    if (!lspForm.provider) { setLspError("Seleccioná una empresa"); return; }
    if (!lspForm.clientNumber.trim()) { setLspError("El número de cliente es obligatorio"); return; }
    setSavingLsp(true); setLspError(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${selectedId}/lsp-services`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: lspForm.provider,
          clientNumber: lspForm.clientNumber.trim(),
          description: lspForm.description.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLspServices((prev) => [data.lspService, ...prev]);
      setLspForm({ provider: "", clientNumber: "", description: "" });
    } catch (err) {
      setLspError(err instanceof Error ? err.message : "Error al agregar servicio");
    } finally { setSavingLsp(false); }
  };

  const handleDeleteLsp = async (lspId: string) => {
    if (!selectedId) return;
    setDeletingLspId(lspId);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${selectedId}/lsp-services/${lspId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLspServices((prev) => prev.filter((s) => s.id !== lspId));
    } catch (err) {
      setLspError(err instanceof Error ? err.message : "Error al eliminar servicio");
    } finally { setDeletingLspId(null); setConfirmDeleteLspId(null); }
  };

  // Elimina la boleta + recibo asociado + mueve el PDF en Drive scanned→pending +
  // borra fila de Sheets. Bloqueado si tiene pagos (el backend responde 409).
  const handleDeleteInvoice = async (invoiceId: string) => {
    if (!selectedId) return;
    setDeletingInvoiceId(invoiceId);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${selectedId}/invoices/${invoiceId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInvoices((prev) => prev.filter((i) => i.id !== invoiceId));
      setToolbarInfo("Boleta eliminada.");
    } catch (err) {
      setToolbarError(err instanceof Error ? err.message : "Error al eliminar boleta");
    } finally {
      setDeletingInvoiceId(null);
      setConfirmDeleteInvoiceId(null);
    }
  };

  const handleSelectConsortium = useCallback(async (c: Consortium) => {
    setSelectedId(c.id); setSelectedConsortium(c);
    setActiveTab("boletas");
    setInvoices([]); setSearch(""); setCloseSuccess(null); setCloseError(null);
    setEditingMatchNames(false); setMatchNamesMsg(null);
    setMatchNamesValue(c.matchNames ?? "");
    setLspServices([]); setLspError(null); setLspForm({ provider: "", clientNumber: "", description: "" });
    setConfirmDeleteLspId(null);
    setConfirmDeleteInvoiceId(null);
    void fetchCoeficientes(c.id);
    void fetchRubros(c.id);
    void fetchLspServices(c.id);
    const periodId = await fetchPeriodsAndInvoices(c.id);
    if (periodId) void fetchInvoices(c.id, periodId);
  }, [fetchPeriodsAndInvoices, fetchInvoices, fetchCoeficientes, fetchRubros, fetchLspServices]);

  const handleSelectPeriod = useCallback((p: Period) => {
    setSelectedPeriod(p);
    if (selectedId) void fetchInvoices(selectedId, p.id);
  }, [selectedId, fetchInvoices]);

  const periodIndex = periods.findIndex((p) => p.id === selectedPeriod?.id);
  const canGoPrev = periodIndex < periods.length - 1;
  const canGoNext = periodIndex > 0;
  const goPrevPeriod = () => { if (canGoPrev) handleSelectPeriod(periods[periodIndex + 1]); };
  const goNextPeriod = () => { if (canGoNext) handleSelectPeriod(periods[periodIndex - 1]); };

  const handleClosePeriod = async () => {
    if (!selectedId || !selectedPeriod) return;
    setClosingPeriod(true); setCloseError(null);
    try {
      const res = await guardedFetch(`/api/client/consortiums/${selectedId}/close-period`, { method: "POST", headers: { "content-type": "application/json" } });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCloseSuccess("Período cerrado. Se creó el siguiente período activo.");
      setShowCloseModal(false);
      void fetchConsortiums();
      const periodId = await fetchPeriodsAndInvoices(selectedId);
      if (periodId) void fetchInvoices(selectedId, periodId);
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "Error al cerrar el período");
    } finally { setClosingPeriod(false); }
  };

  // ── Upload de recibo ──────────────────────────────────────────────────────
  const handleReceiptUpload = async (invoiceId: string, file: File) => {
    if (!selectedId) return;
    setUploadingReceiptId(invoiceId);
    try {
      const fd = new FormData();
      fd.append("receipt", file);
      const res = await guardedFetch(
        `/api/client/consortiums/${selectedId}/invoices/${invoiceId}/receipt`,
        { method: "POST", body: fd }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      // Actualizar la invoice en el estado local con los nuevos campos
      setInvoices((prev) => prev.map((inv) =>
        inv.id === invoiceId
          ? { ...inv, isPaid: data.invoice.isPaid ?? inv.isPaid, remainingBalance: data.invoice.remainingBalance ?? inv.remainingBalance }
          : inv
      ));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error al subir el recibo");
    } finally {
      setUploadingReceiptId(null);
      if (receiptInputRef.current) receiptInputRef.current.value = "";
    }
  };

  const handleScanPdf = async (file: File) => {
    if (!selectedId) return;
    setScanning(true); setScanWarning(null); setMatchedProvider(null);
    try {
      const fd = new FormData();
      fd.append("pdf", file);
      const res = await guardedFetch(`/api/client/consortiums/${selectedId}/invoices/scan`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      if (data.consortiumMismatch && data.foundConsortium) {
        setMismatchFoundConsortium(data.foundConsortium as string);
        setShowMismatchModal(true);
        return;
      }

      if (data.warning) setScanWarning(data.warning);
      if (data.extracted) {
        const e: ScannedData = data.extracted;
        const hit = matchProvider(providers, e);
        setMatchedProvider(hit ?? null);
        setInvoiceForm((f) => ({
          ...f,
          boletaNumber:    e.boletaNumber    ?? f.boletaNumber,
          providerTaxId:   hit?.cuit         ?? e.providerTaxId ?? f.providerTaxId,
          detail:          e.detail          ?? f.detail,
          observation:     e.observation     ?? f.observation,
          issueDate:       toInputDate(e.issueDate) || f.issueDate,
          dueDate:         toInputDate(e.dueDate)   || f.dueDate,
          amount:          e.amount != null  ? String(e.amount) : f.amount,
          tipoComprobante: e.tipoComprobante ?? f.tipoComprobante,
          ...(hit ? { providerId: hit.id } : {}),
        }));
      }
    } catch (err) {
      setScanWarning(err instanceof Error ? err.message : "Error al escanear el PDF");
    } finally { setScanning(false); }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanFile(file);
    void handleScanPdf(file);
  };

  const handleSaveInvoice = async () => {
    if (!selectedId || !selectedPeriod) return;
    if (!invoiceForm.providerId) { setInvoiceError("Seleccioná un proveedor"); return; }
    setSavingInvoice(true); setInvoiceError(null);
    try {
      let coefId = invoiceForm.coeficienteId === "__new__" ? "" : invoiceForm.coeficienteId;
      if (invoiceForm.coeficienteId === "__new__" && invoiceForm.newCoefName && invoiceForm.newCoefValue) {
        const coefRes = await guardedFetch(`/api/client/consortiums/${selectedId}/coeficientes`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: invoiceForm.newCoefName, value: parseFloat(invoiceForm.newCoefValue) }),
        });
        const coefData = await coefRes.json();
        if (!coefRes.ok || !coefData.ok) throw new Error(coefData.error ?? "Error al crear coeficiente");
        coefId = coefData.coeficiente.id;
        setCoeficientes((prev) => [...prev, coefData.coeficiente]);
      }

      let rubroId = invoiceForm.rubroId === "__new__" ? "" : invoiceForm.rubroId;
      if (invoiceForm.rubroId === "__new__" && invoiceForm.newRubroName) {
        const rubroRes = await guardedFetch(`/api/client/consortiums/${selectedId}/rubros`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: invoiceForm.newRubroName }),
        });
        const rubroData = await rubroRes.json();
        if (!rubroRes.ok || !rubroData.ok) throw new Error(rubroData.error ?? "Error al crear rubro");
        rubroId = rubroData.rubro.id;
        setRubros((prev) => [...prev, rubroData.rubro]);
      }

      const res = await guardedFetch(`/api/client/consortiums/${selectedId}/invoices`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId:      invoiceForm.providerId,
          periodId:        selectedPeriod.id,
          boletaNumber:    invoiceForm.boletaNumber    || undefined,
          providerTaxId:   invoiceForm.providerTaxId   || undefined,
          detail:          invoiceForm.detail          || undefined,
          observation:     invoiceForm.observation     || undefined,
          issueDate:       invoiceForm.issueDate       || undefined,
          dueDate:         invoiceForm.dueDate         || undefined,
          amount:          invoiceForm.amount ? parseFloat(invoiceForm.amount) : undefined,
          coeficienteId:   coefId   || undefined,
          rubroId:         rubroId  || undefined,
          tipoGasto:       invoiceForm.tipoGasto,
          tipoComprobante: invoiceForm.tipoComprobante || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInvoices((prev) => [data.invoice, ...prev]);
      setShowInvoiceModal(false);
      resetInvoiceForm();
    } catch (err) {
      setInvoiceError(err instanceof Error ? err.message : "Error al guardar la boleta");
    } finally { setSavingInvoice(false); }
  };

  const resetInvoiceForm = () => {
    setScanFile(null); setScanWarning(null); setInvoiceError(null); setMatchedProvider(null);
    setInvoiceForm({ ...EMPTY_INVOICE_FORM, issueDate: todayInputDate() });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSaveProvider = async () => {
    if (!providerForm.canonicalName || !providerForm.cuit) { setProviderError("Razón social y CUIT son obligatorios"); return; }
    setSavingProvider(true); setProviderError(null); setProviderSuccess(null);
    try {
      const res = await guardedFetch("/api/client/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(providerForm) });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setProviders((prev) => [...prev, data.provider]);
      const requeuedMsg = data.requeued > 0 ? ` Se reencolarán ${data.requeued} boleta(s) para revalidación.` : "";
      setProviderSuccess(`Proveedor creado correctamente.${requeuedMsg}`);
      setProviderForm({ canonicalName: "", cuit: "", paymentAlias: "" });
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : "Error al guardar el proveedor");
    } finally { setSavingProvider(false); }
  };

  const handleSaveConsortium = async () => {
    if (!consortiumForm.canonicalName.trim()) { setConsortiumError("El nombre del consorcio es obligatorio"); return; }
    setSavingConsortium(true); setConsortiumError(null); setConsortiumSuccess(null);
    try {
      const res = await guardedFetch("/api/client/consortiums", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ canonicalName: consortiumForm.canonicalName.trim(), cuit: consortiumForm.cuit.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setConsortiumSuccess("Consorcio creado correctamente.");
      setConsortiumForm({ canonicalName: "", cuit: "" });
      void fetchConsortiums();
    } catch (err) {
      setConsortiumError(err instanceof Error ? err.message : "Error al guardar el consorcio");
    } finally { setSavingConsortium(false); }
  };

  const filteredInvoices = invoices.filter((inv) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return inv.boletaNumber?.toLowerCase().includes(q) || inv.provider?.toLowerCase().includes(q) || inv.providerTaxId?.includes(q);
  });

  // Los totales del header se calculan sobre el período completo, no sobre
  // el subset filtrado — el filtro afecta la tabla visible, no las métricas.
  const totalAmount = invoices.reduce((s, i) => s + (i.amount != null ? Number(i.amount) : 0), 0);
  const duplicates = invoices.filter((i) => i.isDuplicate).length;

  if (!accessChecked) return null;

  const isClient = userRole === "CLIENT";
  const paused = schedulerEnabled === false;

  return (
    <div className={styles.page} data-theme={theme}>
      <div className={styles.gridBackdrop} />

      {/* Input oculto compartido para subir recibos */}
      <input
        ref={receiptInputRef}
        type="file"
        accept=".pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          const invoiceId = receiptInputRef.current?.dataset.invoiceId;
          if (file && invoiceId) void handleReceiptUpload(invoiceId, file);
        }}
      />

      {/* Mobile overlay */}
      {navMobileOpen && (
        <div className={styles.navSidebarOverlay} onClick={() => setNavMobileOpen(false)} />
      )}

      {/* ── Columna 1: NavSidebar ── */}
      <aside className={`${styles.navSidebar} ${navCollapsed ? styles.navSidebarCollapsed : ""} ${navMobileOpen ? styles.navSidebarOpen : ""}`}>
        <div className={styles.navSidebarLogo}>
          <div className={styles.navSidebarLogoIcon}>🏢</div>
          {!navCollapsed && <span className={styles.navSidebarLogoText}>{userName || "Cliente"}</span>}
        </div>
        <div className={styles.navSidebarDivider} />
        <nav className={styles.navSidebarNav}>
          <button type="button" className={styles.navSidebarItem} onClick={() => { handleSyncDirectory(); setNavMobileOpen(false); }} disabled={busyAction !== null}>
            <span className={styles.navSidebarItemIcon}>🔄</span>
            {!navCollapsed && <span className={styles.navSidebarItemLabel}>{busyAction === "sync" ? "Sincronizando..." : "Sincronizar directorio"}</span>}
          </button>
          {isClient && (
            <button type="button" className={styles.navSidebarItem} onClick={() => { handleSyncPayments(); setNavMobileOpen(false); }} disabled={busyAction !== null} title="Lee la hoja PAGOS del Sheets y actualiza los pagos en la base">
              <span className={styles.navSidebarItemIcon}>💵</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>{busyAction === "syncPayments" ? "Sincronizando..." : "Sincronizar pagos"}</span>}
            </button>
          )}
          {isClient && (
            <button type="button" className={styles.navSidebarItem} onClick={() => { handleSetupSheetProtection(); setNavMobileOpen(false); }} disabled={busyAction !== null} title="Sincroniza pagos pendientes y protege las columnas A:U de la hoja de boletas">
              <span className={styles.navSidebarItemIcon}>🔒</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>{busyAction === "protectSheet" ? "Protegiendo..." : "Proteger hoja"}</span>}
            </button>
          )}
          {isClient && (
            <button type="button" className={styles.navSidebarItem} onClick={() => { handleUnprotectSheet(); setNavMobileOpen(false); }} disabled={busyAction !== null} title="Desbloquea la hoja para editarla manualmente en casos puntuales">
              <span className={styles.navSidebarItemIcon}>🔓</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>{busyAction === "unprotectSheet" ? "Desprotegiendo..." : "Desproteger hoja"}</span>}
            </button>
          )}
          <button type="button" className={styles.navSidebarItem} disabled={!consortiumsEnabled} title={!consortiumsEnabled ? "Función Premium" : undefined}>
            <span className={styles.navSidebarItemIcon}>🏢</span>
            {!navCollapsed && (
              <span className={styles.navSidebarItemLabel}>
                Consorcios
                {!consortiumsEnabled && <span className={styles.premiumBadge}>Premium</span>}
              </span>
            )}
          </button>
          {isClient && (
            <button type="button" className={styles.navSidebarItem} onClick={() => { handleCloseAllPreview(); setNavMobileOpen(false); }} disabled={closeAllLoading || busyAction !== null}>
              <span className={styles.navSidebarItemIcon}>📅</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>{closeAllLoading ? "Cargando..." : "Cerrar Periodo General"}</span>}
            </button>
          )}
          {isClient && (
            <button type="button" className={styles.navSidebarItem} onClick={() => { handleOpenUnassigned(); setNavMobileOpen(false); }} disabled={loadingUnassigned || busyAction !== null}>
              <span className={styles.navSidebarItemIcon}>♻️</span>
              {!navCollapsed && <span className={styles.navSidebarItemLabel}>{loadingUnassigned ? "Consultando..." : "Sin Asignar"}</span>}
            </button>
          )}
        </nav>
        <div style={{ flex: 1 }} />

        {/* ── Controles del scheduler (movidos desde el toolbar superior) ── */}
        {isClient && schedulerEnabled !== null && (
          <button
            type="button"
            className={styles.navSidebarItem}
            onClick={() => { handleToggleScheduler(); setNavMobileOpen(false); }}
            disabled={busyAction !== null}
            title={paused ? "Reanudar el scheduler" : "Pausar el scheduler"}
          >
            <span className={styles.navSidebarItemIcon}>{paused ? "▶️" : "⏸️"}</span>
            {!navCollapsed && (
              <span className={styles.navSidebarItemLabel}>
                {paused ? "Encender scheduler" : "Pausar scheduler"}
              </span>
            )}
          </button>
        )}
        {isClient && (
          <button
            type="button"
            className={styles.navSidebarItem}
            onClick={() => { handleRunNow(); setNavMobileOpen(false); }}
            disabled={busyAction !== null}
            title="Forzar una corrida inmediata del scheduler"
          >
            <span className={styles.navSidebarItemIcon}>⚡</span>
            {!navCollapsed && <span className={styles.navSidebarItemLabel}>Ejecutar ahora</span>}
          </button>
        )}

        <div className={styles.navSidebarDivider} />

        <button type="button" className={styles.navSidebarItem} onClick={() => { handleLogout(); setNavMobileOpen(false); }}>
          <span className={styles.navSidebarItemIcon}>🚪</span>
          {!navCollapsed && <span className={styles.navSidebarItemLabel}>Cerrar sesión</span>}
        </button>
        <button type="button" className={styles.navSidebarCollapse} onClick={() => setNavCollapsed((c) => !c)}>
          {navCollapsed ? "»" : "«"}
        </button>
      </aside>

      {/* ── Columna 2: Lista de consorcios ── */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarTitle}>Consorcios</span>
          <span className={styles.sidebarCount}>{loadingList ? "..." : consortiums.length}</span>
        </div>
        {loadingList && <div className={styles.sidebarLoading}>Cargando...</div>}
        {listError && <div className={styles.sidebarError}>{listError}</div>}
        <nav className={styles.sidebarNav}>
          {consortiums.map((c) => {
            const active = c.periods.find((p) => p.status === "ACTIVE");
            const isSelected = selectedId === c.id;
            return (
              <button key={c.id} type="button"
                className={`${styles.sidebarItem} ${isSelected ? styles.sidebarItemActive : ""}`}
                onClick={() => void handleSelectConsortium(c)}>
                <span className={styles.sidebarItemIcon}>🏢</span>
                <span className={styles.sidebarItemBody}>
                  <span className={styles.sidebarItemName}>{c.rawName}</span>
                  <span className={styles.sidebarItemMeta}>{active ? formatPeriod(active) : "Sin periodo"} · {c._count.invoices} bol.</span>
                </span>
                {isSelected && <span className={styles.sidebarItemArrow}>›</span>}
              </button>
            );
          })}
          {!loadingList && !listError && consortiums.length === 0 && (
            <p className={styles.sidebarEmpty}>No hay consorcios cargados.</p>
          )}
        </nav>
      </aside>

      {/* ── Botón hamburger flotante (solo mobile/tablet ≤1024px) ── */}
      <button
        type="button"
        className={styles.fabHamburger}
        onClick={() => setNavMobileOpen(true)}
        aria-label="Abrir menú lateral"
      >
        ☰
      </button>

      {/* ── Toasts flotantes (arriba a la derecha) ── */}
      {(toolbarInfo || toolbarError) && (
        <div className={styles.toastContainer} role="status" aria-live="polite">
          {toolbarInfo && (
            <div className={`${styles.toastItem} ${styles.toastInfoItem}`}>{toolbarInfo}</div>
          )}
          {toolbarError && (
            <div className={`${styles.toastItem} ${styles.toastErrorItem}`}>{toolbarError}</div>
          )}
        </div>
      )}

      {/* ── Columna 3: Contenido principal ── */}
      <div className={styles.contentCol}>

        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Gestion de consorcios</p>
            <h1>Edificios</h1>
          </div>
          <div className={styles.headerActions}>
            <button type="button" className={styles.consortiumBtn} onClick={() => { setShowConsortiumModal(true); setConsortiumError(null); setConsortiumSuccess(null); }}>
              + Nuevo consorcio
            </button>
            <button type="button" className={styles.providerBtn} onClick={() => { setShowProviderModal(true); setProviderError(null); setProviderSuccess(null); }}>
              + Nuevo proveedor
            </button>
            <button type="button" className={styles.ghostBtn} onClick={() => router.push("/admin")}>
              ← Volver al panel
            </button>
          </div>
        </header>

        <main className={styles.main}>
          {!selectedId && (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>🏢</span>
              <p>Seleccioná un consorcio para ver sus boletas.</p>
            </div>
          )}

          {selectedId && selectedConsortium && (
            <>
              <div className={styles.detailHeader}>
                <div>
                  <div className={styles.detailTitleRow}>
                    <h2 className={styles.detailTitle}>{selectedConsortium.rawName}</h2>
                    {/* Navegador de período inline al lado del nombre */}
                    <div className={styles.periodNav}>
                      <button type="button" className={styles.periodNavBtn} onClick={goPrevPeriod} disabled={!canGoPrev} aria-label="Período anterior">‹</button>
                      <span className={styles.periodNavLabel}>
                        {selectedPeriod ? formatPeriod(selectedPeriod) : "Sin período"}
                        {selectedPeriod?.status === "CLOSED" && <span className={styles.closedTag}>Cerrado</span>}
                      </span>
                      <button type="button" className={styles.periodNavBtn} onClick={goNextPeriod} disabled={!canGoNext} aria-label="Período siguiente">›</button>
                    </div>
                  </div>
                  {selectedConsortium.cuit && <p className={styles.detailMeta}>CUIT: {selectedConsortium.cuit}</p>}
                </div>
                <div className={styles.detailActions}>
                  {selectedPeriod?.status === "ACTIVE" && (
                    <button type="button" className={styles.closePeriodBtn} onClick={() => setShowCloseModal(true)}>Cerrar período</button>
                  )}
                  <button type="button" className={styles.addInvoiceBtn} onClick={() => { resetInvoiceForm(); setShowInvoiceModal(true); }}>
                    + Cargar boleta
                  </button>
                  <button type="button" className={styles.configBtn} onClick={() => {
                    setMatchNamesValue(selectedConsortium.matchNames ?? "");
                    setEditingMatchNames(false);
                    setMatchNamesMsg(null);
                    setShowConfigModal(true);
                  }}>
                    Configuración
                  </button>
                </div>
              </div>

              {/* ── LspServices section (colapsable) ── */}
              <div className={styles.lspSection}>
                <button
                  type="button"
                  className={styles.lspToggle}
                  onClick={() => setLspCollapsed((c) => !c)}
                  aria-expanded={!lspCollapsed}
                  aria-controls="lsp-content"
                >
                  <span className={styles.lspToggleChevron} aria-hidden="true">
                    {lspCollapsed ? "▸" : "▾"}
                  </span>
                  <span className={styles.lspTitle}>Servicios públicos (LSP)</span>
                  {lspServices.length > 0 && (
                    <span className={styles.lspToggleCount}>{lspServices.length}</span>
                  )}
                </button>
                {!lspCollapsed && (
                <div id="lsp-content" className={styles.lspContent}>
                {lspServices.length > 0 && (
                  <div className={styles.lspTableWrap}>
                    <table className={styles.lspTable}>
                      <thead>
                        <tr>
                          <th>Empresa</th><th>Nro. Cliente</th><th>Descripción</th><th>Acciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lspServices.map((s) => (
                          <tr key={s.id}>
                            <td>{LSP_PROVIDERS.find((p) => p.value === s.providerName)?.label ?? s.providerName}</td>
                            <td className={styles.tdMono}>{s.clientNumber}</td>
                            <td>{s.description ?? "—"}</td>
                            <td>
                              {confirmDeleteLspId === s.id ? (
                                <span className={styles.lspConfirmDelete}>
                                  ¿Confirmar?{" "}
                                  <button type="button" className={styles.lspConfirmYes} onClick={() => handleDeleteLsp(s.id)} disabled={deletingLspId === s.id}>
                                    {deletingLspId === s.id ? "..." : "Sí"}
                                  </button>
                                  <button type="button" className={styles.lspConfirmNo} onClick={() => setConfirmDeleteLspId(null)}>No</button>
                                </span>
                              ) : (
                                <button type="button" className={styles.lspDeleteBtn} onClick={() => setConfirmDeleteLspId(s.id)}>Eliminar</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {lspServices.length === 0 && (
                  <p className={styles.lspEmpty}>No hay servicios públicos cargados para este consorcio.</p>
                )}
                <div className={styles.lspAddForm}>
                  <select className={styles.formSelect} value={lspForm.provider} onChange={(e) => setLspForm((f) => ({ ...f, provider: e.target.value }))}>
                    <option value="">Empresa...</option>
                    {LSP_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                  <input className={styles.formInput} value={lspForm.clientNumber} onChange={(e) => setLspForm((f) => ({ ...f, clientNumber: e.target.value }))} placeholder="Nro. de cliente" />
                  <input className={styles.formInput} value={lspForm.description} onChange={(e) => setLspForm((f) => ({ ...f, description: e.target.value }))} placeholder="Descripción (opcional)" />
                  <button type="button" className={styles.addInvoiceBtn} onClick={handleAddLsp} disabled={savingLsp}>
                    {savingLsp ? "Agregando..." : "Agregar"}
                  </button>
                </div>
                {lspError && <p className={styles.errorMsg}>{lspError}</p>}
                </div>
                )}
              </div>

              {closeSuccess && <p className={styles.infoMsg}>{closeSuccess}</p>}
              {closeError && <p className={styles.errorMsg}>{closeError}</p>}
              {invoicesError && <p className={styles.errorMsg}>{invoicesError}</p>}

              <div className={styles.tabBar}>
                <button
                  type="button"
                  className={activeTab === "boletas" ? styles.tabActive : styles.tab}
                  onClick={() => setActiveTab("boletas")}
                >
                  Boletas
                </button>
                <button
                  type="button"
                  className={activeTab === "pagos" ? styles.tabActive : styles.tab}
                  onClick={() => setActiveTab("pagos")}
                >
                  Pagos
                </button>
              </div>

              {activeTab === "boletas" && (
              <>
              <div className={styles.statsStrip}>
                <div className={styles.statCard}><span className={styles.statLabel}>Boletas</span><span className={styles.statValue}>{invoices.length}</span></div>
                <div className={styles.statCard}><span className={styles.statLabel}>Total período</span><span className={styles.statValue}>{formatAmount(totalAmount)}</span></div>
                <div className={styles.statCard}><span className={styles.statLabel}>Duplicados</span><span className={`${styles.statValue} ${duplicates > 0 ? styles.statWarn : ""}`}>{duplicates}</span></div>
                <div className={styles.statCard}><span className={styles.statLabel}>Rubros</span><span className={styles.statValue}>{rubros.length}</span></div>
              </div>

              <div className={styles.searchRow}>
                <input type="text" className={styles.searchInput} placeholder="Buscar por proveedor, N° boleta o CUIT..." value={search} onChange={(e) => setSearch(e.target.value)} />
                {search && <button type="button" className={styles.clearSearch} onClick={() => setSearch("")}>✕</button>}
              </div>

              {loadingInvoices ? (
                <div className={styles.emptyState}><p>Cargando boletas...</p></div>
              ) : (
                <div className={styles.tableWrap}>
                  {filteredInvoices.length === 0 ? (
                    <div className={styles.tableEmpty}>{search ? "No hay boletas que coincidan con la búsqueda." : "No hay boletas para este período."}</div>
                  ) : (
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>N° Boleta</th><th>Proveedor</th><th>CUIT</th><th>Comprobante</th>
                          <th>Detalle</th><th>Emisión</th><th>Vencimiento</th><th>Monto</th>
                          <th>Tipo</th><th>Rubro</th><th>Coef.</th><th>Estado</th>
                          <th>Archivo</th><th>Pago</th><th>Acciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredInvoices.map((inv) => (
                          <tr key={inv.id} className={inv.isDuplicate ? styles.rowDuplicate : ""}>
                            <td className={styles.tdMono}>{inv.boletaNumber ?? "—"}</td>
                            <td>{inv.provider ?? "—"}{inv.lspServiceId && <span className={styles.badgeLsp}>LSP</span>}</td>
                            <td className={styles.tdMono}>{inv.providerTaxId ?? "—"}</td>
                            <td className={styles.tdMono}>{inv.tipoComprobante ?? "—"}</td>
                            <td className={styles.tdDetail}>{inv.detail ?? inv.observation ?? "—"}</td>
                            <td>{formatDate(inv.issueDate)}</td>
                            <td>{formatDate(inv.dueDate)}</td>
                            <td className={styles.tdAmount}>{formatAmount(inv.amount)}</td>
                            <td>
                              <span className={
                                inv.tipoGasto === "EXTRAORDINARIO" ? styles.badgeDuplicate
                                : inv.tipoGasto === "PARTICULAR" ? styles.badgeManual
                                : styles.badgeOk
                              }>
                                {inv.tipoGasto === "ORDINARIO" ? "Ord." : inv.tipoGasto === "EXTRAORDINARIO" ? "Ext." : "Part."}
                              </span>
                            </td>
                            <td>{(inv as any).rubroRef?.name ?? "—"}</td>
                            <td className={styles.tdMono}>{(inv as any).coeficienteRef?.name ?? "—"}</td>
                            <td>
                              {inv.isManual ? <span className={styles.badgeManual}>Manual</span>
                                : inv.isDuplicate ? <span className={styles.badgeDuplicate}>Duplicado</span>
                                : <span className={styles.badgeOk}>OK</span>}
                            </td>
                            <td>
                              {inv.sourceFileUrl
                                ? <a href={inv.sourceFileUrl} target="_blank" rel="noopener noreferrer" className={styles.fileLink}>Ver PDF</a>
                                : "—"}
                            </td>
                            {/* ── Columna pago (solo estado visual; las acciones viven en la pestaña Pagos) ── */}
                            <td>
                              {inv.isPaid ? (
                                <span className={styles.badgeOk}>Pagada</span>
                              ) : inv.remainingBalance !== null && Number(inv.remainingBalance) < Number(inv.amount ?? 0) ? (
                                <span className={styles.badgeWarning}>
                                  Resta ${Number(inv.remainingBalance).toLocaleString("es-AR", { minimumFractionDigits: 2 })}
                                </span>
                              ) : (
                                <span style={{ color: "var(--text-muted, #888)" }}>—</span>
                              )}
                            </td>
                            {/* ── Acciones: eliminar boleta (confirm inline) ── */}
                            <td>
                              {confirmDeleteInvoiceId === inv.id ? (
                                <span className={styles.lspConfirmDelete}>
                                  ¿Borrar?{" "}
                                  <button type="button" className={styles.lspConfirmYes} onClick={() => handleDeleteInvoice(inv.id)} disabled={deletingInvoiceId === inv.id}>
                                    {deletingInvoiceId === inv.id ? "..." : "Sí"}
                                  </button>
                                  <button type="button" className={styles.lspConfirmNo} onClick={() => setConfirmDeleteInvoiceId(null)}>No</button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className={styles.lspDeleteBtn}
                                  onClick={() => setConfirmDeleteInvoiceId(inv.id)}
                                  title="Eliminar boleta (mueve PDF a 'pending' y borra fila de Sheets)"
                                  aria-label="Eliminar boleta"
                                >
                                  🗑
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
              </>
              )}

              {activeTab === "pagos" && (
                <PagosView
                  invoices={invoices}
                  onPagoGuardado={() => {
                    if (selectedId && selectedPeriod) void fetchInvoices(selectedId, selectedPeriod.id);
                  }}
                  onPagar={handleOpenPayModal}
                  onVerPagos={handleOpenViewPayments}
                  onEliminarUltimoPago={async (invoiceId) => {
                    // Busca el último pago de la invoice y lo elimina. El endpoint
                    // valida que sea el más reciente (restricción del repository).
                    try {
                      const res = await guardedFetch(`/api/client/invoices/${invoiceId}/payments`, { cache: "no-store" });
                      const data = await res.json();
                      if (!data.ok || !Array.isArray(data.payments) || data.payments.length === 0) {
                        throw new Error("La boleta no tiene pagos para eliminar");
                      }
                      // Más reciente primero (paymentDate desc o createdAt desc; tomamos el primero)
                      const sorted = [...data.payments].sort((a: { createdAt?: string }, b: { createdAt?: string }) =>
                        (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
                      );
                      const last = sorted[0];
                      const delRes = await guardedFetch(`/api/client/invoices/${invoiceId}/payments/${last.id}`, { method: "DELETE" });
                      const delData = await delRes.json();
                      if (!delRes.ok || !delData.ok) throw new Error(delData.error ?? `HTTP ${delRes.status}`);
                      setToolbarInfo("Pago eliminado.");
                      if (selectedId && selectedPeriod) void fetchInvoices(selectedId, selectedPeriod.id);
                    } catch (err) {
                      setToolbarError(err instanceof Error ? err.message : "Error al eliminar pago");
                    }
                  }}
                />
              )}
            </>
          )}
        </main>
      </div>{/* close contentCol */}

      {/* ── Config modal ── */}
      {showConfigModal && selectedConsortium && (
        <div className={styles.modalOverlay} onClick={() => !savingMatchNames && setShowConfigModal(false)}>
          <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Configuración — {selectedConsortium.rawName}</h3>
            <p className={styles.modalSubtitle}>Ajustes de matching y datos internos del consorcio</p>

            <div className={styles.configSection}>
              <h4 className={styles.configSectionTitle}>Nombres alternativos (matching interno)</h4>
              <p className={styles.configSectionDesc}>
                Separar con | (pipe). Estos nombres se usan internamente para identificar el consorcio en facturas.
              </p>
              {!editingMatchNames ? (
                <>
                  <p className={styles.matchNamesValue}>
                    {matchNamesValue || <span style={{ opacity: 0.4 }}>Sin nombres alternativos</span>}
                  </p>
                  <div className={styles.matchNamesActions} style={{ marginTop: 8 }}>
                    <button type="button" className={styles.matchNamesEditBtn} onClick={() => setEditingMatchNames(true)}>Editar</button>
                  </div>
                </>
              ) : (
                <div className={styles.matchNamesEdit}>
                  <input
                    className={styles.formInput}
                    value={matchNamesValue}
                    onChange={(e) => setMatchNamesValue(e.target.value)}
                    placeholder="NOMBRE ALT 1|NOMBRE ALT 2|NOMBRE ALT 3"
                  />
                  <div className={styles.matchNamesActions}>
                    <button type="button" className={styles.ghostBtn} onClick={() => setEditingMatchNames(false)} disabled={savingMatchNames}>Cancelar</button>
                    <button type="button" className={styles.addInvoiceBtn} onClick={handleSaveMatchNames} disabled={savingMatchNames}>
                      {savingMatchNames ? "Guardando..." : "Guardar"}
                    </button>
                  </div>
                </div>
              )}
              {matchNamesMsg && <p className={styles.infoMsg} style={{ marginTop: 6 }}>{matchNamesMsg}</p>}
            </div>

            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => setShowConfigModal(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Consortium mismatch modal — z-index 200 ── */}
      {showMismatchModal && (
        <div className={styles.modalOverlayTop}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>⚠️ Boleta de otro consorcio</h3>
            <p className={styles.modalBody}>
              Este gasto <strong>NO corresponde</strong> al consorcio seleccionado.<br /><br />
              Según la información extraída del PDF, la boleta pertenece a:<br />
              <strong style={{ fontSize: "16px", color: "#ffb347" }}>{mismatchFoundConsortium}</strong><br /><br />
              Verificá que estés cargando la boleta en el consorcio correcto antes de continuar.
            </p>
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn}
                onClick={() => {
                  setShowMismatchModal(false);
                  setMismatchFoundConsortium(null);
                  setScanFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}>
                Entendido — cancelar carga
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Close period modal ── */}
      {showCloseModal && (
        <div className={styles.modalOverlay} onClick={() => !closingPeriod && setShowCloseModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Cerrar período</h3>
            <p className={styles.modalBody}>
              Estás por cerrar el período <strong>{formatPeriod(selectedPeriod)}</strong> del consorcio{" "}
              <strong>{selectedConsortium?.rawName}</strong>.<br /><br />
              Se creará automáticamente el siguiente período activo. Esta acción no se puede deshacer.
            </p>
            {closeError && <p className={styles.errorMsg}>{closeError}</p>}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => setShowCloseModal(false)} disabled={closingPeriod}>Cancelar</button>
              <button type="button" className={styles.closePeriodConfirmBtn} onClick={handleClosePeriod} disabled={closingPeriod}>
                {closingPeriod ? "Cerrando..." : "Confirmar cierre"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Invoice modal ── */}
      {showInvoiceModal && (
        <div className={styles.modalOverlay} onClick={() => !savingInvoice && !scanning && setShowInvoiceModal(false)}>
          <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Cargar boleta</h3>
            <p className={styles.modalSubtitle}>{selectedConsortium?.rawName} · {formatPeriod(selectedPeriod)}</p>

            <div className={styles.scanSection}>
              <label className={styles.scanLabel}>
                {scanning ? "Escaneando PDF..." : scanFile ? `📄 ${scanFile.name}` : "Subir PDF para escanear (opcional)"}
                <input ref={fileInputRef} type="file" accept=".pdf" onChange={handleFileChange} style={{ display: "none" }} disabled={scanning} />
              </label>
              {scanning && <div className={styles.scanSpinner} />}
            </div>
            {matchedProvider && (
              <p className={styles.infoMsg}>
                ✓ Proveedor identificado: <strong>{matchedProvider.canonicalName}</strong>
                {matchedProvider.cuit ? ` — ${matchedProvider.cuit}` : ""}
              </p>
            )}
            {scanWarning && <p className={styles.warnMsg}>{scanWarning}</p>}

            <div className={styles.invoiceFormGrid}>
              <div className={styles.formField}>
                <label>Proveedor *</label>
                <select value={invoiceForm.providerId} onChange={(e) => setInvoiceForm((f) => ({ ...f, providerId: e.target.value }))} className={styles.formSelect}>
                  <option value="">Seleccioná un proveedor</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.canonicalName}{p.paymentAlias ? ` (${p.paymentAlias})` : ""}{p.providerType === "EMPLEADO" ? " [EMPLEADO]" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.formField}>
                <label>N° Comprobante</label>
                <input className={styles.formInput} value={invoiceForm.boletaNumber} onChange={(e) => setInvoiceForm((f) => ({ ...f, boletaNumber: e.target.value }))} placeholder="0001-00000123" />
              </div>

              <div className={styles.formField}>
                <label>
                  {matchedProvider?.providerType === "EMPLEADO" ? "CUIL" : "CUIT"} emisor
                  {matchedProvider && <span className={styles.canonLabel}> ✓ verificado</span>}
                </label>
                <input
                  className={styles.formInput}
                  value={invoiceForm.providerTaxId}
                  onChange={(e) => setInvoiceForm((f) => ({ ...f, providerTaxId: e.target.value }))}
                  placeholder="20-12345678-9"
                  readOnly={!!matchedProvider}
                  style={matchedProvider ? { opacity: 0.7, cursor: "not-allowed" } : undefined}
                />
              </div>
              <div className={styles.formField}>
                <label>Tipo de comprobante</label>
                <select value={invoiceForm.tipoComprobante} onChange={(e) => setInvoiceForm((f) => ({ ...f, tipoComprobante: e.target.value }))} className={styles.formSelect}>
                  <option value="">Sin especificar</option>
                  {TIPOS_COMPROBANTE.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              <div className={styles.formField}>
                <label>Monto</label>
                <input type="number" className={styles.formInput} value={invoiceForm.amount} onChange={(e) => setInvoiceForm((f) => ({ ...f, amount: e.target.value }))} placeholder="0.00" min="0" step="0.01" />
              </div>
              <div className={styles.formField}>
                <label>Tipo de gasto</label>
                <select value={invoiceForm.tipoGasto} onChange={(e) => setInvoiceForm((f) => ({ ...f, tipoGasto: e.target.value }))} className={styles.formSelect}>
                  {TIPOS_GASTO.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>

              <div className={styles.formField}>
                <label>Fecha de emisión</label>
                <input type="date" className={styles.formInput} value={invoiceForm.issueDate} onChange={(e) => setInvoiceForm((f) => ({ ...f, issueDate: e.target.value }))} />
              </div>
              <div className={styles.formField}>
                <label>Fecha de vencimiento</label>
                <input type="date" className={styles.formInput} value={invoiceForm.dueDate} onChange={(e) => setInvoiceForm((f) => ({ ...f, dueDate: e.target.value }))} />
              </div>

              <div className={`${styles.formField} ${styles.formFieldFull}`}>
                <label>Detalle</label>
                <textarea
                  className={styles.formTextarea}
                  rows={3}
                  value={invoiceForm.detail}
                  onChange={(e) => setInvoiceForm((f) => ({ ...f, detail: e.target.value }))}
                  placeholder="Descripción del servicio"
                />
              </div>

              <div className={styles.formField}>
                <label>Rubro</label>
                <select value={invoiceForm.rubroId} onChange={(e) => setInvoiceForm((f) => ({ ...f, rubroId: e.target.value, newRubroName: "" }))} className={styles.formSelect}>
                  <option value="">Sin rubro</option>
                  {rubros.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  <option value="__new__">+ Nuevo rubro</option>
                </select>
              </div>
              {invoiceForm.rubroId === "__new__" ? (
                <div className={styles.formField}>
                  <label>Nombre del rubro</label>
                  <input className={styles.formInput} value={invoiceForm.newRubroName} onChange={(e) => setInvoiceForm((f) => ({ ...f, newRubroName: e.target.value }))} placeholder="Ej: Limpieza, Electricidad..." />
                </div>
              ) : <div />}

              <div className={styles.formField}>
                <label>Coeficiente</label>
                <select value={invoiceForm.coeficienteId} onChange={(e) => setInvoiceForm((f) => ({ ...f, coeficienteId: e.target.value, newCoefName: "", newCoefValue: "" }))} className={styles.formSelect}>
                  <option value="">Sin coeficiente</option>
                  {coeficientes.map((c) => <option key={c.id} value={c.id}>{c.name} ({Number(c.value).toFixed(4)})</option>)}
                  <option value="__new__">+ Nuevo coeficiente</option>
                </select>
              </div>
              {invoiceForm.coeficienteId === "__new__" ? (
                <div className={styles.formField}>
                  <label>Nombre del coeficiente</label>
                  <input className={styles.formInput} value={invoiceForm.newCoefName} onChange={(e) => setInvoiceForm((f) => ({ ...f, newCoefName: e.target.value }))} placeholder="Ej: A, B, Cochera" />
                </div>
              ) : <div />}
              {invoiceForm.coeficienteId === "__new__" && (
                <div className={`${styles.formField} ${styles.formFieldFull}`}>
                  <label>Valor del coeficiente</label>
                  <input type="number" className={styles.formInput} value={invoiceForm.newCoefValue} onChange={(e) => setInvoiceForm((f) => ({ ...f, newCoefValue: e.target.value }))} placeholder="0.0000" step="0.0001" min="0" />
                </div>
              )}
            </div>

            {invoiceError && <p className={styles.errorMsg}>{invoiceError}</p>}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => { setShowInvoiceModal(false); resetInvoiceForm(); }} disabled={savingInvoice || scanning}>Cancelar</button>
              <button type="button" className={styles.addInvoiceBtn} onClick={handleSaveInvoice} disabled={savingInvoice || scanning}>
                {savingInvoice ? "Guardando..." : "Guardar boleta"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Provider modal ── */}
      {showProviderModal && (
        <div className={styles.modalOverlay} onClick={() => !savingProvider && setShowProviderModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Nuevo proveedor</h3>
            <p className={styles.modalBody}>El proveedor se crea a nivel cliente y puede asignarse a cualquier consorcio.</p>
            <div className={styles.providerFormGrid}>
              <div className={styles.formField}>
                <label>Razón social *</label>
                <input className={styles.formInput} value={providerForm.canonicalName} onChange={(e) => setProviderForm((f) => ({ ...f, canonicalName: e.target.value }))} placeholder="Nombre completo del proveedor" />
              </div>
              <div className={styles.formField}>
                <label>CUIT *</label>
                <input className={styles.formInput} value={providerForm.cuit} onChange={(e) => setProviderForm((f) => ({ ...f, cuit: e.target.value }))} placeholder="20-12345678-9" />
              </div>
              <div className={`${styles.formField} ${styles.formFieldFull}`}>
                <label>Alias (opcional)</label>
                <input className={styles.formInput} value={providerForm.paymentAlias} onChange={(e) => setProviderForm((f) => ({ ...f, paymentAlias: e.target.value }))} placeholder="Nombre corto o abreviación" />
              </div>
            </div>
            {providerError && <p className={styles.errorMsg}>{providerError}</p>}
            {providerSuccess && <p className={styles.infoMsg}>{providerSuccess}</p>}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => setShowProviderModal(false)} disabled={savingProvider}>Cerrar</button>
              <button type="button" className={styles.providerBtn} onClick={handleSaveProvider} disabled={savingProvider}>
                {savingProvider ? "Guardando..." : "Crear proveedor"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Consortium modal ── */}
      {showConsortiumModal && (
        <div className={styles.modalOverlay} onClick={() => !savingConsortium && setShowConsortiumModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Nuevo consorcio</h3>
            <p className={styles.modalBody}>Se creará con un período activo para el mes en curso.</p>
            <div className={styles.providerFormGrid}>
              <div className={`${styles.formField} ${styles.formFieldFull}`}>
                <label>Nombre del consorcio *</label>
                <input className={styles.formInput} value={consortiumForm.canonicalName} onChange={(e) => setConsortiumForm((f) => ({ ...f, canonicalName: e.target.value }))} placeholder="Ej: Consorcio Av. Corrientes 1234" />
              </div>
              <div className={`${styles.formField} ${styles.formFieldFull}`}>
                <label>CUIT (opcional)</label>
                <input className={styles.formInput} value={consortiumForm.cuit} onChange={(e) => setConsortiumForm((f) => ({ ...f, cuit: e.target.value }))} placeholder="30-12345678-9" />
              </div>
            </div>
            {consortiumError && <p className={styles.errorMsg}>{consortiumError}</p>}
            {consortiumSuccess && <p className={styles.infoMsg}>{consortiumSuccess}</p>}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => setShowConsortiumModal(false)} disabled={savingConsortium}>Cerrar</button>
              <button type="button" className={styles.consortiumBtn} onClick={handleSaveConsortium} disabled={savingConsortium}>
                {savingConsortium ? "Creando..." : "Crear consorcio"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Close All Periods modal ── */}
      {showCloseAllModal && (
        <div className={styles.modalOverlay} onClick={() => !closeAllLoading && setShowCloseAllModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            {closeAllStep === "preview" && (
              <>
                <h3 className={styles.modalTitle}>Cerrar Periodo General</h3>
                {closeAllError && <p className={styles.errorMsg}>{closeAllError}</p>}
                {closeAllPreview && !closeAllPreview.majorityMonth && (
                  <p className={styles.modalBody}>No hay períodos activos para cerrar.</p>
                )}
                {closeAllPreview && closeAllPreview.majorityMonth && (
                  <>
                    <p className={styles.modalBody}>
                      Se cerrarán <strong>{closeAllPreview.toClose.length}</strong> consorcio(s).
                      <br />Período: <strong>{closeAllPreview.majorityMonth}</strong> → <strong>{closeAllPreview.nextMonth}</strong>
                    </p>
                    {closeAllPreview.toSkip.length > 0 && (
                      <>
                        <p style={{ fontSize: "13px", color: "#ffb872", marginBottom: "6px" }}>
                          Se saltearán {closeAllPreview.toSkip.length} consorcio(s):
                        </p>
                        <ul className={styles.closeAllList}>
                          {closeAllPreview.toSkip.map((c) => (
                            <li key={c.id}>
                              <strong>{c.canonicalName}</strong> — {c.currentPeriod}
                              <span className={styles.closeAllSkipReason}>Ya está en período más avanzado</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                )}
                <div className={styles.modalActions}>
                  <button type="button" className={styles.ghostBtn} onClick={() => setShowCloseAllModal(false)} disabled={closeAllLoading}>Cancelar</button>
                  {closeAllPreview?.majorityMonth && (
                    <button type="button" className={styles.closePeriodConfirmBtn} onClick={handleCloseAllExecute} disabled={closeAllLoading}>
                      {closeAllLoading ? "Cerrando..." : "Confirmar"}
                    </button>
                  )}
                </div>
              </>
            )}
            {closeAllStep === "result" && closeAllResult && (
              <>
                <h3 className={styles.modalTitle}>Resultado</h3>
                <p className={styles.modalBody}>
                  Cerrados: <strong>{closeAllResult.closed}</strong> | Salteados: <strong>{closeAllResult.skipped}</strong>
                </p>
                {closeAllResult.warnings.length > 0 && (
                  <ul className={styles.closeAllList}>
                    {closeAllResult.warnings.map((w, i) => (
                      <li key={i} style={{ color: "#ffb872" }}>{w}</li>
                    ))}
                  </ul>
                )}
                <div className={styles.modalActions}>
                  <button type="button" className={styles.ghostBtn} onClick={() => setShowCloseAllModal(false)}>Cerrar</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Unassigned requeue modal ── */}
      {showUnassignedModal && (
        <div className={styles.modalOverlay} onClick={() => !loadingUnassigned && setShowUnassignedModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            {unassignedStep === "preview" && (
              <>
                <h3 className={styles.modalTitle}>Archivos Sin Asignar</h3>
                {loadingUnassigned && <p className={styles.modalBody}>Consultando Drive...</p>}
                {!loadingUnassigned && !unassignedFolderConfigured && (
                  <>
                    <p className={styles.modalBody}>La carpeta Sin Asignar no está configurada para este cliente.</p>
                    <div className={styles.modalActions}>
                      <button type="button" className={styles.ghostBtn} onClick={() => setShowUnassignedModal(false)}>Cerrar</button>
                    </div>
                  </>
                )}
                {!loadingUnassigned && unassignedFolderConfigured && unassignedFiles.length === 0 && (
                  <>
                    <p className={styles.modalBody}>No hay archivos sin asignar.</p>
                    <div className={styles.modalActions}>
                      <button type="button" className={styles.ghostBtn} onClick={() => setShowUnassignedModal(false)}>Cerrar</button>
                    </div>
                  </>
                )}
                {!loadingUnassigned && unassignedFolderConfigured && unassignedFiles.length > 0 && (
                  <>
                    <p className={styles.modalBody}>
                      Se encontraron <strong>{unassignedFiles.length}</strong> archivo(s) en la carpeta Sin Asignar:
                    </p>
                    <ul className={styles.closeAllList}>
                      {unassignedFiles.map((f) => (
                        <li key={f.id}>{f.name}</li>
                      ))}
                    </ul>
                    <div className={styles.modalActions}>
                      <button type="button" className={styles.ghostBtn} onClick={() => setShowUnassignedModal(false)}>Cancelar</button>
                      <button type="button" className={styles.closePeriodConfirmBtn} onClick={handleRequeue} disabled={loadingUnassigned}>
                        Mover a Pendientes ({unassignedFiles.length} archivos)
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            {unassignedStep === "result" && unassignedResult && (
              <>
                <h3 className={styles.modalTitle}>Archivos movidos a Pendientes</h3>
                <p className={styles.modalBody}>
                  {unassignedResult.moved > 0 && <>{unassignedResult.moved} archivo(s) movidos a Pendientes correctamente.<br /></>}
                  {unassignedResult.failed > 0 && <span style={{ color: "#ffb872" }}>{unassignedResult.failed} archivo(s) no pudieron moverse.<br /></span>}
                  <br />
                  El scheduler los procesará en el próximo ciclo automáticamente.
                  También podés usar <strong>Ejecutar ahora</strong> en la toolbar.
                </p>
                <div className={styles.modalActions}>
                  <button type="button" className={styles.ghostBtn} onClick={() => setShowUnassignedModal(false)}>Cerrar</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Payment modal ── */}
      {payModalInvoice && (
        <div className={styles.modalOverlay} onClick={handleClosePayModal}>
          <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Registrar pago</h3>
            <p className={styles.modalSubtitle}>
              {payModalInvoice.provider ?? "—"} — {payModalInvoice.boletaNumber ?? "—"}
              {payModalInvoice.amount !== null && (
                <> · Importe: {formatAmount(payModalInvoice.amount)}</>
              )}
              {payModalInvoice.remainingBalance !== null && !payModalInvoice.isPaid && (
                <> · Saldo: {formatAmount(payModalInvoice.remainingBalance)}</>
              )}
            </p>

            {loadingExistingPayments && (
              <p style={{ fontSize: 12, opacity: 0.6 }}>Cargando historial de pagos...</p>
            )}

            {/* Banner del modo activo si NO es primer pago */}
            {!loadingExistingPayments && !isFirstPayment && (
              <div style={{
                padding: "10px 14px", borderRadius: 8,
                background: activeMode === "cuotas" ? "rgba(99, 162, 255, 0.12)" : "rgba(255, 184, 114, 0.12)",
                border: `1px solid ${activeMode === "cuotas" ? "rgba(99, 162, 255, 0.35)" : "rgba(255, 184, 114, 0.35)"}`,
                fontSize: 13, marginTop: 8,
              }}>
                {activeMode === "cuotas" ? (
                  <>
                    <strong>Modo cuotas pactadas</strong> · Cuota {currentInstallmentNumber} de {installmentsLocked}
                    {isLastInstallment && (
                      <span style={{ display: "block", marginTop: 4, fontSize: 12, opacity: 0.85 }}>
                        Última cuota — absorbe diferencias de redondeo.
                      </span>
                    )}
                  </>
                ) : (
                  <><strong>Modo pago libre</strong> · Ya hay {existingPayments.length} pago(s) registrado(s)</>
                )}
              </div>
            )}

            {/* Toggle de modo si es PRIMER pago */}
            {!loadingExistingPayments && isFirstPayment && (
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button type="button"
                  className={effectiveMode === "libre" ? styles.addInvoiceBtn : styles.ghostBtn}
                  style={{ flex: 1 }}
                  onClick={() => setChosenMode("libre")}
                  disabled={savingPayment}
                >
                  Pago libre
                </button>
                <button type="button"
                  className={effectiveMode === "cuotas" ? styles.addInvoiceBtn : styles.ghostBtn}
                  style={{ flex: 1 }}
                  onClick={() => setChosenMode("cuotas")}
                  disabled={savingPayment}
                >
                  Cuotas fijas
                </button>
              </div>
            )}

            {payError && <p className={styles.errorMsg} style={{ marginTop: 8 }}>{payError}</p>}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
              {/* Campo cant cuotas — solo visible para PRIMER pago en modo cuotas */}
              {isFirstPayment && effectiveMode === "cuotas" && (
                <label>
                  <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>
                    Cantidad de cuotas
                  </span>
                  <input
                    type="number"
                    min="2"
                    step="1"
                    className={styles.formInput}
                    placeholder="ej. 3"
                    value={payForm.totalInstallments}
                    onChange={(e) => setPayForm((f) => ({ ...f, totalInstallments: e.target.value }))}
                    disabled={savingPayment}
                  />
                </label>
              )}

              {/* Monto — editable en modo libre, readonly en cuotas (autocalculado) */}
              <label>
                <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>
                  Monto pagado
                  {effectiveMode === "cuotas" && (
                    <span style={{ fontWeight: 400, opacity: 0.6 }}> (calculado automáticamente)</span>
                  )}
                </span>
                {effectiveMode === "cuotas" ? (
                  <input
                    type="text"
                    className={styles.formInput}
                    value={computedAmount > 0 ? formatAmount(computedAmount) : "—"}
                    readOnly
                    disabled
                  />
                ) : (
                  <input
                    type="number"
                    step="0.01"
                    className={styles.formInput}
                    value={payForm.amount}
                    onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))}
                    disabled={savingPayment}
                  />
                )}
              </label>

              <label>
                <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>Fecha de pago</span>
                <input
                  type="date"
                  className={styles.formInput}
                  value={payForm.paymentDate}
                  onChange={(e) => setPayForm((f) => ({ ...f, paymentDate: e.target.value }))}
                  disabled={savingPayment}
                />
              </label>

              <label>
                <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>Medio de pago</span>
                <select
                  className={styles.formSelect}
                  value={payForm.paymentMethod}
                  onChange={(e) => setPayForm((f) => ({ ...f, paymentMethod: e.target.value }))}
                  disabled={savingPayment}
                >
                  <option value="" disabled hidden>Elija una opción</option>
                  <option value="Débito automático">Débito automático</option>
                  <option value="Transferencia">Transferencia</option>
                  <option value="Efectivo">Efectivo</option>
                </select>
              </label>
              <label style={{ gridColumn: "1 / -1" }}>
                <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>Observación (opcional)</span>
                <input
                  type="text"
                  className={styles.formInput}
                  value={payForm.observation}
                  onChange={(e) => setPayForm((f) => ({ ...f, observation: e.target.value }))}
                  disabled={savingPayment}
                />
              </label>
              <label style={{ gridColumn: "1 / -1" }}>
                <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, opacity: 0.8 }}>Comprobante PDF</span>
                <input
                  ref={payFileInputRef}
                  type="file"
                  accept="application/pdf"
                  className={styles.formInput}
                  onChange={(e) => setPayFile(e.target.files?.[0] ?? null)}
                  disabled={savingPayment}
                />
                {payFile && (
                  <span style={{ fontSize: 12, opacity: 0.7 }}>
                    {payFile.name} ({(payFile.size / 1024).toFixed(1)} KB)
                  </span>
                )}
              </label>
            </div>

            <div className={styles.modalActions} style={{ marginTop: 16 }}>
              <button type="button" className={styles.ghostBtn} onClick={handleClosePayModal} disabled={savingPayment}>
                Cancelar
              </button>
              <button type="button" className={styles.addInvoiceBtn} onClick={handleSubmitPayment} disabled={savingPayment || loadingExistingPayments}>
                {savingPayment ? "Guardando..." : "Registrar pago"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Ver pagos modal (read-only) ── */}
      {viewPaymentsInvoice && (
        <div className={styles.modalOverlay} onClick={() => setViewPaymentsInvoice(null)}>
          <div className={styles.modalLarge} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Historial de pagos</h3>
            <p className={styles.modalSubtitle}>
              {viewPaymentsInvoice.provider ?? "—"} — {viewPaymentsInvoice.boletaNumber ?? "—"}
              {viewPaymentsInvoice.amount !== null && (
                <> · Importe total: {formatAmount(viewPaymentsInvoice.amount)}</>
              )}
            </p>

            {loadingViewPayments ? (
              <p style={{ fontSize: 12, opacity: 0.6 }}>Cargando...</p>
            ) : viewPaymentsList.length === 0 ? (
              <p style={{ fontSize: 13, opacity: 0.7 }}>Esta boleta no tiene pagos registrados.</p>
            ) : (
              <div className={styles.tableWrap} style={{ marginTop: 12 }}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th>Fecha</th>
                      <th>Monto</th>
                      <th>Medio</th>
                      <th>Comprobante</th>
                      <th>Observación</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewPaymentsList.map((p) => (
                      <tr key={p.id}>
                        <td>
                          {p.totalInstallments
                            ? <span className={styles.badgeOk}>Cuota {p.installmentNumber}/{p.totalInstallments}</span>
                            : <span className={styles.badgeManual}>Libre</span>}
                        </td>
                        <td>{formatDate(p.paymentDate)}</td>
                        <td className={styles.tdAmount}>{formatAmount(Number(p.amount))}</td>
                        <td>{p.paymentMethod ?? "—"}</td>
                        <td>
                          {p.driveFileUrl
                            ? <a href={p.driveFileUrl} target="_blank" rel="noopener noreferrer" className={styles.fileLink}>Ver PDF</a>
                            : "—"}
                        </td>
                        <td className={styles.tdDetail}>{p.observation ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className={styles.modalActions} style={{ marginTop: 16 }}>
              <button type="button" className={styles.ghostBtn} onClick={() => setViewPaymentsInvoice(null)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// PagosView — solapa de pagos con tabla inline editable
// ────────────────────────────────────────────────────────────────────────────

interface PendingPaymentInput {
  paymentDate: string;
  amount: string;
  paymentMethod: string;
  file: File | null;
}

interface PagosViewProps {
  invoices: Invoice[];
  onPagoGuardado: () => void;
  onPagar: (inv: Invoice) => void;
  onVerPagos: (inv: Invoice) => void;
  onEliminarUltimoPago: (invoiceId: string) => Promise<void>;
}

function PagosView({ invoices, onPagoGuardado, onPagar, onVerPagos, onEliminarUltimoPago }: PagosViewProps) {
  // Confirm inline para eliminar último pago de una boleta paga (estado local).
  const [confirmDeletePaymentInvoiceId, setConfirmDeletePaymentInvoiceId] = useState<string | null>(null);
  const [deletingPaymentInvoiceId, setDeletingPaymentInvoiceId] = useState<string | null>(null);
  const [pendingPayments, setPendingPayments] = useState<Record<string, PendingPaymentInput>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Buscador local de PagosView. State separado del de Boletas — cada pestaña
  // tiene su contexto de búsqueda independiente.
  const [search, setSearch] = useState("");

  const allVisible = invoices.filter((inv) => !inv.isDuplicate);

  // Filtro por proveedor, N° boleta o CUIT (mismo criterio que la pestaña Boletas).
  const visibleInvoices = (() => {
    if (!search.trim()) return allVisible;
    const q = search.toLowerCase();
    return allVisible.filter((inv) => {
      const provider = (inv.provider ?? "").toLowerCase();
      const boleta = (inv.boletaNumber ?? "").toLowerCase();
      const cuit = inv.providerTaxId ?? "";
      return provider.includes(q) || boleta.includes(q) || cuit.includes(q);
    });
  })();

  // Prisma serializa Decimal como string → `string + 0` concatena en vez de sumar
  // y termina dando NaN cuando formateamos. Forzar Number() en cada reduce.
  const toNum = (v: number | string | null | undefined): number => {
    if (v === null || v === undefined) return 0;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // Métricas del header sobre el período completo (no sobre el filtrado) —
  // el buscador afecta la tabla, no las métricas globales.
  const totalBoletas = allVisible.length;
  const boletasPagadas = allVisible.filter((inv) => inv.isPaid).length;

  const totalImpago = allVisible
    .filter((inv) => !inv.isPaid)
    .reduce((sum, inv) => {
      const amount = toNum(inv.amount);
      const remaining = inv.remainingBalance === null ? amount : toNum(inv.remainingBalance);
      return sum + remaining;
    }, 0);

  const updatePending = (invoiceId: string, field: keyof PendingPaymentInput, value: string) => {
    setPendingPayments((prev) => {
      const existing = prev[invoiceId] ?? { paymentDate: todayInputDate(), amount: "", paymentMethod: "", file: null };
      return { ...prev, [invoiceId]: { ...existing, [field]: value } };
    });
  };

  // Handler separado para el File del comprobante (no es string).
  const updatePendingFile = (invoiceId: string, file: File | null) => {
    setPendingPayments((prev) => {
      const existing = prev[invoiceId] ?? { paymentDate: todayInputDate(), amount: "", paymentMethod: "", file: null };
      return { ...prev, [invoiceId]: { ...existing, file } };
    });
  };

  const handleGuardarPagos = async () => {
    setError(null);

    // Solo procesamos filas con "intención de pago" (alguno de los campos
    // tocados). Las que no tienen nada se ignoran silenciosamente.
    const dirtyEntries = Object.entries(pendingPayments).filter(([, p]) =>
      Boolean(p.paymentDate || p.amount || p.paymentMethod || p.file)
    );

    if (dirtyEntries.length === 0) return;

    // Validación: cada fila iniciada debe tener fecha + importe (salvo
    // empleado, que se autocalcula) + medio de pago + comprobante.
    const errors: string[] = [];
    for (const [invoiceId, pago] of dirtyEntries) {
      const inv = visibleInvoices.find((i) => i.id === invoiceId);
      if (!inv) continue;
      const provider = inv.provider ?? "Proveedor s/d";
      const boleta = inv.boletaNumber ?? "s/N°";
      const label = `${provider} – ${boleta}`;
      const missing: string[] = [];

      if (!pago.paymentDate) missing.push("fecha de pago");

      if (inv.providerType !== "EMPLEADO") {
        const parsed = parseAmountInput(pago.amount);
        if (!Number.isFinite(parsed) || parsed <= 0) missing.push("importe");
      }

      if (!pago.paymentMethod) missing.push("medio de pago");
      if (!pago.file) missing.push("comprobante PDF");

      if (missing.length > 0) errors.push(`${label}: falta ${missing.join(", ")}.`);
    }

    if (errors.length > 0) {
      setError(errors.join(" "));
      return;
    }

    setSaving(true);
    try {
      for (const [invoiceId, pago] of dirtyEntries) {
        const inv = visibleInvoices.find((i) => i.id === invoiceId);
        if (!inv) continue;

        const totalAmount = inv.amount ?? 0;
        const remainingAmount = inv.remainingBalance ?? totalAmount;
        const parsedInput = parseAmountInput(pago.amount);

        const amount = inv.providerType === "EMPLEADO"
          ? totalAmount
          : Number.isFinite(parsedInput) && parsedInput > 0
            ? parsedInput
            : remainingAmount;

        if (!amount || amount <= 0) continue;

        // Si hay archivo, usamos FormData (el endpoint acepta multipart;
        // el modal de Cuotas ya usa este camino). Si no, mantenemos JSON
        // para no romper la lógica existente del flujo inline simple.
        let res: Response;
        if (pago.file) {
          const fd = new FormData();
          fd.append("amount", String(amount));
          fd.append("paymentDate", pago.paymentDate);
          if (pago.paymentMethod) fd.append("paymentMethod", pago.paymentMethod);
          fd.append("receipt", pago.file);
          res = await fetch(`/api/client/invoices/${invoiceId}/payments`, {
            method: "POST",
            body: fd,
          });
        } else {
          res = await fetch(`/api/client/invoices/${invoiceId}/payments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              amount,
              paymentDate: pago.paymentDate,
              paymentMethod: pago.paymentMethod || null,
            }),
          });
        }
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setPendingPayments({});
      onPagoGuardado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar los pagos");
    } finally {
      setSaving(false);
    }
  };

  const pendingCount = Object.keys(pendingPayments).length;
  const totalPendiente = Object.entries(pendingPayments).reduce((sum, [invoiceId, p]) => {
    const inv = visibleInvoices.find((i) => i.id === invoiceId);
    if (!inv) return sum;
    if (inv.providerType === "EMPLEADO") return sum + toNum(inv.amount);
    const parsed = parseAmountInput(p.amount);
    if (Number.isFinite(parsed) && parsed > 0) return sum + parsed;
    const remaining = inv.remainingBalance === null ? toNum(inv.amount) : toNum(inv.remainingBalance);
    return sum + remaining;
  }, 0);

  return (
    <>
      <div className={styles.statsStrip}>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Pagos registrados</span>
          <span className={styles.statValue}>{boletasPagadas} de {totalBoletas}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Saldo impago</span>
          <span className={`${styles.statValue} ${totalImpago > 0 ? styles.statWarn : ""}`}>{formatAmount(totalImpago)}</span>
        </div>
      </div>

      {/* Buscador (espejo del de la pestaña Boletas) */}
      <div className={styles.searchRow}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Buscar por proveedor, N° boleta o CUIT..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button type="button" className={styles.clearSearch} onClick={() => setSearch("")}>✕</button>
        )}
      </div>
      {error && <p className={styles.errorMsg}>{error}</p>}

      <div className={styles.tableWrap}>
        {visibleInvoices.length === 0 ? (
          <div className={styles.tableEmpty}>
            {search
              ? "No hay boletas que coincidan con la búsqueda."
              : "No hay boletas para este período."}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>PERÍODO GASTO</th>
                <th>PROVEEDOR</th>
                <th>COMPROBANTE</th>
                <th>IMPORTE</th>
                <th>SALDO</th>
                <th>FECHA PAGO</th>
                <th>IMPORTE PAGO</th>
                <th>MEDIO DE PAGO</th>
                <th>COMPROBANTE</th>
                <th>ACCIONES</th>
              </tr>
            </thead>
            <tbody>
              {visibleInvoices.map((inv) => {
                const pending = pendingPayments[inv.id];
                const totalAmount = inv.amount ?? 0;
                const saldo = inv.remainingBalance ?? totalAmount;
                const isEmpleado = inv.providerType === "EMPLEADO";
                return (
                  <tr key={inv.id}>
                    <td>{formatDate(inv.issueDate)}</td>
                    <td>{inv.provider ?? "—"}</td>
                    <td className={styles.tdMono}>{inv.boletaNumber ?? "—"}</td>
                    <td className={styles.tdAmount}>{formatAmount(totalAmount)}</td>
                    <td className={styles.tdAmount}>{formatAmount(saldo)}</td>

                    <td>
                      {inv.isPaid ? (
                        <span className={styles.badgeOk}>Pagada</span>
                      ) : (
                        <input
                          type="date"
                          className={styles.formInput}
                          value={pending?.paymentDate ?? todayInputDate()}
                          onChange={(e) => updatePending(inv.id, "paymentDate", e.target.value)}
                        />
                      )}
                    </td>

                    <td>
                      {inv.isPaid ? (
                        <span>{formatAmount(totalAmount)}</span>
                      ) : isEmpleado ? (
                        <span>{formatAmount(totalAmount)}</span>
                      ) : (
                        <input
                          type="text"
                          inputMode="decimal"
                          className={styles.formInput}
                          placeholder={formatAmountPlain(saldo)}
                          value={pending?.amount ?? ""}
                          onChange={(e) => updatePending(inv.id, "amount", e.target.value)}
                        />
                      )}
                    </td>

                    <td>
                      {inv.isPaid ? (
                        <span>—</span>
                      ) : (
                        <select
                          className={styles.formSelect}
                          value={pending?.paymentMethod ?? ""}
                          onChange={(e) => updatePending(inv.id, "paymentMethod", e.target.value)}
                        >
                          <option value="" disabled hidden>Elija una opción</option>
                          <option value="Débito automático">Débito automático</option>
                          <option value="Transferencia">Transferencia</option>
                          <option value="Efectivo">Efectivo</option>
                        </select>
                      )}
                    </td>

                    {/* ── Comprobante (PDF opcional inline) ── */}
                    <td>
                      {inv.isPaid ? (
                        <span>—</span>
                      ) : (
                        <label
                          className={styles.ghostBtn}
                          style={{
                            padding: "4px 10px",
                            fontSize: 12,
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            maxWidth: 140,
                          }}
                          title={pending?.file?.name ?? "Adjuntar comprobante PDF"}
                        >
                          <span>📎</span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {pending?.file ? pending.file.name : "Adjuntar"}
                          </span>
                          <input
                            type="file"
                            accept="application/pdf"
                            style={{ display: "none" }}
                            onChange={(e) => updatePendingFile(inv.id, e.target.files?.[0] ?? null)}
                          />
                        </label>
                      )}
                    </td>

                    {/* ── Acciones: Pagar/Ver pagos + Eliminar último pago ── */}
                    <td>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {inv.isPaid ? (
                          <button
                            type="button"
                            className={styles.ghostBtn}
                            style={{ padding: "4px 10px", fontSize: 12 }}
                            onClick={() => onVerPagos(inv)}
                            title="Ver historial de pagos"
                          >
                            Ver pagos
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={styles.addInvoiceBtn}
                            style={{ padding: "4px 10px", fontSize: 12 }}
                            onClick={() => onPagar(inv)}
                            title="Registrar pago en cuotas (fijas o variables). Para un solo pago, usá los inputs inline de esta fila."
                          >
                            Cuotas
                          </button>
                        )}

                        {/* Eliminar último pago: solo si la boleta tiene al menos un pago */}
                        {(inv.isPaid || (inv.remainingBalance !== null && Number(inv.remainingBalance) < Number(inv.amount ?? 0))) && (
                          confirmDeletePaymentInvoiceId === inv.id ? (
                            <span className={styles.lspConfirmDelete}>
                              ¿Borrar último pago?{" "}
                              <button
                                type="button"
                                className={styles.lspConfirmYes}
                                disabled={deletingPaymentInvoiceId === inv.id}
                                onClick={async () => {
                                  setDeletingPaymentInvoiceId(inv.id);
                                  try { await onEliminarUltimoPago(inv.id); }
                                  finally { setDeletingPaymentInvoiceId(null); setConfirmDeletePaymentInvoiceId(null); }
                                }}
                              >
                                {deletingPaymentInvoiceId === inv.id ? "..." : "Sí"}
                              </button>
                              <button type="button" className={styles.lspConfirmNo} onClick={() => setConfirmDeletePaymentInvoiceId(null)}>No</button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className={styles.lspDeleteBtn}
                              onClick={() => setConfirmDeletePaymentInvoiceId(inv.id)}
                              title="Eliminar el último pago registrado (revierte estado y borra comprobante de Drive si tenía)"
                              aria-label="Eliminar último pago"
                            >
                              🗑
                            </button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {pendingCount > 0 && (
        <div className={styles.pagosFooter}>
          <span>
            {pendingCount} pago(s) cargado(s) sin guardar: {formatAmount(totalPendiente)}
          </span>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => setPendingPayments({})}
            disabled={saving}
          >
            CANCELAR
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={handleGuardarPagos}
            disabled={saving}
          >
            {saving ? "Guardando..." : "GUARDAR"}
          </button>
        </div>
      )}
    </>
  );
}
