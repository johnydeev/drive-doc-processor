import { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/authSession";

interface AdminLayoutProps {
  children: ReactNode;
}

export default async function AdminLayout({ children }: AdminLayoutProps) {
  const secret = process.env.SESSION_SECRET?.trim();
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;

  if (!secret || !token) {
    redirect("/login?next=/admin");
  }

  const session = verifySessionToken(token, secret);
  if (!session) {
    redirect("/login?next=/admin");
  }

  return <>{children}</>;
}
