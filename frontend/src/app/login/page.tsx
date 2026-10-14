import { redirectIfSignedIn } from "@/lib/dal";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  // A signed-in visitor never sees the login form.
  await redirectIfSignedIn();
  return <LoginForm />;
}