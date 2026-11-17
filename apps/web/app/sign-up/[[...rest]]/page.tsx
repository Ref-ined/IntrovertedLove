import { SignUp } from "@clerk/nextjs";
import { clerkEnabled } from "@/lib/flags";

export default async function Page({ searchParams }: { searchParams: Promise<{ redirect_url?: string }> }) {
  const { redirect_url } = await searchParams;
  const next = redirect_url?.startsWith("/") && !redirect_url.startsWith("//") ? redirect_url : "/onboarding";
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      {clerkEnabled()
        ? <SignUp forceRedirectUrl={next} />
        : <p className="card max-w-md text-muted">Clerk keys aren't set, so real sign-in is off. Use <a className="text-primary underline" href="/dev/login?as=alice">dev login</a>.</p>}
    </main>
  );
}
