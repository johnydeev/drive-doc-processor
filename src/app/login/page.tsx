"use client";

import { FormEvent, Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "./page.module.css";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redirectTo = useMemo(() => {
    const next = searchParams.get("next");
    if (!next || !next.startsWith("/")) {
      return "/admin";
    }

    return next;
  }, [searchParams]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
        }),
      });

      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar sesion");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <h1>Iniciar sesion</h1>
        <p className={styles.subtitle}>Ingresa con el usuario creado en Prisma.</p>

        <form className={styles.form} onSubmit={handleSubmit}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <label htmlFor="password">Contrasena</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />

          {error && <p className={styles.error}>{error}</p>}

          <button type="submit" disabled={busy}>
            {busy ? "Ingresando..." : "Entrar"}
          </button>
        </form>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className={styles.page}>Cargando...</main>}>
      <LoginForm />
    </Suspense>
  );
}

