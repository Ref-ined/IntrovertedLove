"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiFail } from "@/lib/client";

type Me = { birthdate_set: boolean; questionnaire_done: boolean; couple: { partner: { name: string } | null } | null };

const MESSAGES: Record<string, string> = {
  own_code: "This is your own invite. Send it to your partner.",
  code_expired: "This invite has expired. Ask your partner to send a new link.",
  already_paired: "You're already connected with someone.",
  partner_unavailable: "The person who sent this invite is already connected.",
  rate_limited: "Too many tries this hour. Please wait a bit.",
  questionnaire_required: "You both need to finish the questionnaire first.",
};

export default function Page() {
  return <Suspense><Pair /></Suspense>;
}

function Pair() {
  const router = useRouter();
  const code = (useSearchParams().get("code") ?? "").toUpperCase();
  const back = `/pair?code=${encodeURIComponent(code)}`;
  const [state, setState] = useState<"loading" | "signed_out" | "ready" | "paired">("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/events", { body: { name: "invite_opened", props: {} } }).catch(() => {});
    api<Me>("/me").then((m) => {
      setMe(m);
      if (m.couple) setState("paired");
      else if (!m.birthdate_set || !m.questionnaire_done) router.replace(`/onboarding?code=${encodeURIComponent(code)}`);
      else setState("ready");
    }).catch((e: ApiFail) => setState(e.p.status === 401 ? "signed_out" : "ready"));
  }, []);

  const connect = async () => {
    try { await api("/pair", { body: { code } }); router.replace("/chat"); }
    catch (e) { setError(MESSAGES[(e as ApiFail).p.code] ?? (e as Error).message); }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">
      <div className="card space-y-4 text-center">
        <h1 className="text-3xl">You've been invited</h1>
        {state === "loading" && <p className="text-muted">One moment…</p>}
        {state === "signed_out" && (
          <>
            <p className="text-muted">Create an account or sign in, and we'll bring you back here to connect.</p>
            <div className="flex justify-center gap-3">
              <a className="btn-primary" href={`/sign-up?redirect_url=${encodeURIComponent(back)}`}>Create account</a>
              <a className="btn-ghost" href={`/sign-in?redirect_url=${encodeURIComponent(back)}`}>Sign in</a>
            </div>
          </>
        )}
        {state === "paired" && <p className="text-muted">You're already connected with {me?.couple?.partner?.name ?? "your partner"}.</p>}
        {state === "ready" && (
          <>
            <p className="text-muted">Connect with the person who sent you this invite.</p>
            <button className="btn-primary" onClick={connect}>Connect with your partner</button>
          </>
        )}
        {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
      </div>
    </main>
  );
}
