"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api, ApiFail, inviteLink } from "@/lib/client";

type Me = { birthdate_set: boolean; age_blocked: boolean; questionnaire_done: boolean; couple: unknown; display_name: string | null };
type Q = { id: string; text: string; multiple?: boolean; options: { value: string; label: string }[] };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function Page() {
  return <Suspense><Onboarding /></Suspense>;
}

function Onboarding() {
  const router = useRouter();
  const code = useSearchParams().get("code") ?? "";
  const [me, setMe] = useState<Me | null>(null);
  const load = () => api<Me>("/me").then(setMe).catch((e: ApiFail) => e.p.status === 401 && router.replace("/"));
  useEffect(() => { load(); }, []);

  if (!me) return <Shell><p className="text-muted">Loading…</p></Shell>;
  if (me.age_blocked) return <Shell><h1 className="text-3xl">This space is for adults</h1><p className="text-muted">Introverted Love is for people 18 and over.</p></Shell>;
  if (me.couple) { router.replace("/chat"); return null; }
  if (!me.birthdate_set) return <Shell><Birthdate onDone={load} /></Shell>;
  if (!me.questionnaire_done) return <Shell><Questionnaire onDone={load} /></Shell>;
  return <Shell><Partner initialCode={code} onPaired={() => router.replace("/chat")} /></Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-2xl space-y-6 px-6 py-12">{children}</main>;
}

function Birthdate({ onDone }: { onDone: () => void }) {
  const [d, setD] = useState({ day: "", month: "", year: "", name: "" });
  const thisYear = new Date().getFullYear();
  const submit = async () => {
    try {
      if (d.name) await api("/me", { method: "PATCH", body: { display_name: d.name } });
      const mm = String(Number(d.month) + 1).padStart(2, "0");
      await api("/me/birthdate", { body: { birthdate: `${d.year}-${mm}-${d.day.padStart(2, "0")}` } });
      onDone();
    } catch (e) {
      toast.error((e as ApiFail).p.code === "age_blocked" ? "Introverted Love is for people 18 and over." : (e as Error).message);
      onDone();
    }
  };
  const sel = "input appearance-none";
  return (
    <div className="card space-y-5">
      <h1 className="text-3xl">Welcome</h1>
      <label className="block space-y-2"><span className="text-sm font-semibold">What should your partner call you?</span>
        <input className="input" value={d.name} maxLength={60} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Your first name" />
      </label>
      <div className="space-y-2">
        <span className="text-sm font-semibold">Your birthdate</span>
        <p className="text-sm text-muted">You need to be 18 or older.</p>
        <div className="grid grid-cols-3 gap-3">
          <select aria-label="Day" className={sel} value={d.day} onChange={(e) => setD({ ...d, day: e.target.value })}>
            <option value="">Day</option>{Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
          </select>
          <select aria-label="Month" className={sel} value={d.month} onChange={(e) => setD({ ...d, month: e.target.value })}>
            <option value="">Month</option>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
          </select>
          <select aria-label="Year" className={sel} value={d.year} onChange={(e) => setD({ ...d, year: e.target.value })}>
            <option value="">Year</option>{Array.from({ length: 100 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      <button className="btn-primary" disabled={!d.day || !d.month || !d.year} onClick={submit}>Continue</button>
    </div>
  );
}

function Questionnaire({ onDone }: { onDone: () => void }) {
  const [qs, setQs] = useState<Q[]>([]);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [share, setShare] = useState(true);
  useEffect(() => { api<{ questions: Q[] }>("/questionnaire").then((r) => setQs(r.questions)); }, []);
  const pick = (q: Q, v: string) => setAnswers((a) => {
    if (!q.multiple) return { ...a, [q.id]: v };
    const cur = (a[q.id] as string[] | undefined) ?? [];
    return { ...a, [q.id]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] };
  });
  const done = qs.length > 0 && qs.every((q) => (q.multiple ? ((answers[q.id] as string[]) ?? []).length > 0 : !!answers[q.id]));
  const submit = async () => {
    try { await api("/questionnaire", { method: "PUT", body: { answers, share_traits: share } }); onDone(); }
    catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="space-y-6">
      <div className="card space-y-2">
        <h1 className="text-3xl">How do you like to be spoken to?</h1>
        <p className="text-muted">Your answers do two things: messages your partner sends you are softened the way you like, and your own messages keep sounding like you, just humbler. Your partner never sees your answers.</p>
      </div>
      {qs.map((q, i) => (
        <fieldset key={q.id} className="card space-y-3">
          <legend className="sr-only">{q.text}</legend>
          <p className="font-semibold">{i + 1}. {q.text}{q.multiple && <span className="text-sm font-normal text-muted"> (pick any)</span>}</p>
          <div className="grid gap-2">
            {q.options.map((o) => {
              const on = q.multiple ? ((answers[q.id] as string[]) ?? []).includes(o.value) : answers[q.id] === o.value;
              return (
                <button key={o.value} type="button" aria-pressed={on} onClick={() => pick(q, o.value)}
                  className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${on ? "border-primary bg-primary-50" : "border-line bg-white hover:bg-stone-50"}`}>
                  {o.label}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      <label className="card flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={share} onChange={(e) => setShare(e.target.checked)} />
        <span className="text-sm"><b>Use my answers to soften messages sent to me.</b> If you turn this off, messages to you are softened with general advice instead.</span>
      </label>
      <button className="btn-primary" disabled={!done} onClick={submit}>Save and continue</button>
    </div>
  );
}

function Partner({ initialCode, onPaired }: { initialCode: string; onPaired: () => void }) {
  const [mine, setMine] = useState("");
  const [code, setCode] = useState(initialCode);
  useEffect(() => { api<{ code: string }>("/pair/code").then((r) => setMine(r.code)); }, []);
  const copy = async () => {
    await navigator.clipboard.writeText(inviteLink(mine));
    toast.success("Invite link copied");
    api("/events", { body: { name: "invite_copied", props: {} } }).catch(() => {});
  };
  const connect = async () => {
    try { await api("/pair", { body: { code } }); toast.success("You're connected"); onPaired(); }
    catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="space-y-6">
      <div className="card space-y-3">
        <h1 className="text-3xl">Invite your partner</h1>
        <p className="text-muted">Send them this link. It works once and lasts 7 days.</p>
        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded-xl bg-primary-50 px-3 py-2 text-lg tracking-widest">{mine || "…"}</code>
          <button className="btn-ghost" disabled={!mine} onClick={copy}>Copy invite link</button>
        </div>
      </div>
      <div className="card space-y-3">
        <h2 className="text-2xl">Have their code?</h2>
        <input className="input uppercase tracking-widest" value={code} maxLength={10} onChange={(e) => setCode(e.target.value)} placeholder="ABCDE23456" />
        <button className="btn-primary" disabled={code.trim().length < 10} onClick={connect}>Connect</button>
      </div>
    </div>
  );
}
