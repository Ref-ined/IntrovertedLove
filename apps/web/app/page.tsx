import Link from "next/link";
import { clerkEnabled, devAuthEnabled } from "@/lib/flags";

export default function Landing() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-widest text-primary">Introverted Love</p>
      <h1 className="text-5xl leading-[1.1] text-stone-800 md:text-7xl">Say what you mean.<br />Let it land gently.</h1>
      <p className="max-w-xl text-lg text-muted">
        When a message comes out sharper than you meant, we help you send it the way your partner hears best,
        using what they told us about how they like to be spoken to.
      </p>
      <div className="flex flex-wrap gap-3">
        {clerkEnabled() && <Link href="/sign-up" className="btn-primary">Create an account</Link>}
        {clerkEnabled() && <Link href="/sign-in" className="btn-ghost">Sign in</Link>}
        {devAuthEnabled() && (
          <>
            <a href="/dev/login?as=alice" className="btn-primary">Dev: log in as Alice</a>
            <a href="/dev/login?as=bob" className="btn-ghost">Dev: log in as Bob</a>
          </>
        )}
      </div>
    </main>
  );
}
