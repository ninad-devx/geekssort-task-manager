import { getSession } from "@/lib/dal";
import { redirect } from "next/navigation";
import { ChangePasswordForm } from "./form";

export default async function ChangePasswordPage() {
  // Resolved on the server so the form always knows who it belongs to. Without this
  // the page rendered as if signed out: no "Sign out" button, and "Cancel" bounced
  // back to a route that redirected straight here again.
  const session = await getSession();
  if (!session) redirect("/login");

  return <ChangePasswordForm user={session.user} appTimezone={session.app_timezone} />;
}