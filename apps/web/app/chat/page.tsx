"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api, ApiFail } from "@/lib/client";
import { drafts as draftStore, type Draft } from "@/lib/drafts";

type Msg = {
  id: string; mine: boolean; text: string; mode: string; change_summary: string | null; heated: boolean;
  original_shared: boolean; original_text: string | null; visible_at: string;
};
type Me = { id: string; paid: boolean; free_translations_left: number | null; free_shares_left: number | null; couple: { partner: { name: string } | null } | null; birthdate_set: boolean; questionnaire_done: boolean };
type Preview = {
  delivered_text: string | null; change_summary: string | null; heated: boolean; safety: boolean; preview_token: string;
  advice?: string | null; alternatives?: { text: string; preview_token: string }[];
};
type Coaching = { landing: string; swaps: { from: string; to: string }[]; encouragement: string; safety: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Chat() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pending, setPending] = useState<Msg[]>([]);
  const [skew, setSkew] = useState(0); // server_now - client now, for the undo countdown
  const [, tick] = useState(0);
  const cursor = useRef<string | null>(null);

  const [text, setText] = useState("");
  const [prev, setPrev] = useState<(Preview & { for: string }) | null>(null);
  const [breathDone, setBreathDone] = useState(false);
  const [pick, setPick] = useState(0); // 0 = main version, 1+ = alternatives
  const [coachOut, setCoachOut] = useState<Coaching | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftList, setDraftList] = useState<Draft[]>([]);
  const store = useMemo(() => (me ? draftStore(localStorage, me.id) : null), [me?.id]);

  const loadMe = useCallback(() => api<Me>("/me").then((m) => {
    if (!m.birthdate_set || !m.questionnaire_done || !m.couple) router.replace("/onboarding");
    setMe(m);
  }).catch((e: ApiFail) => e.p.status === 401 && router.replace("/")), [router]);

  const poll = useCallback(async () => {
    try {
      const r = await api<{ messages: Msg[]; pending: Msg[]; server_now: string; next_cursor: string | null }>(
        `/messages${cursor.current ? `?cursor=${encodeURIComponent(cursor.current)}` : ""}`);
      cursor.current = r.next_cursor;
      setSkew(Date.parse(r.server_now) - Date.now());
      setPending(r.pending);
      if (r.messages.length) setMsgs((old) => {
        const seen = new Set(old.map((m) => m.id));
        return [...old, ...r.messages.filter((m) => !seen.has(m.id))];
      });
    } catch { /* next poll retries */ }
  }, []);

  useEffect(() => { loadMe(); }, [loadMe]);
  useEffect(() => { if (store) setDraftList(store.list()); }, [store]);
  useEffect(() => {
    if (!me?.couple) return;
    let stop = false;
    (async () => {
      while (!stop) {
        await poll();
        await sleep(document.visibilityState === "visible" ? 5000 : 30000);
      }
    })();
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => { stop = true; clearInterval(t); };
  }, [me?.couple, poll]);

  const partner = me?.couple?.partner?.name ?? "your partner";
  const fail = (e: unknown) => {
    const p = (e as ApiFail).p;
    if (p?.status === 402) setNotice(p.detail);
    else toast.error((e as Error).message);
  };
  const upgrade = (feature: string) => {
    api("/events", { body: { name: "upgrade_clicked", props: { feature } } }).catch(() => {});
    toast("Paid plans are coming soon. Thanks for your interest!");
  };

  const doPreview = async () => {
    setBusy(true); setNotice(null); setBreathDone(false);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const p = await api<Preview>("/messages/preview", { body: { text } });
        setPrev({ ...p, for: text }); setPick(0);
        break;
      } catch (e) {
        const p = (e as ApiFail).p;
        if (p?.code === "translate_failed" && attempt < 2) { await sleep(800 * (attempt + 1)); continue; }
        fail(e);
        break;
      }
    }
    setBusy(false);
    loadMe();
  };

  const doCoach = async () => {
    if (!me?.paid) return upgrade("coach");
    setBusy(true);
    try { setCoachOut(await api<Coaching>("/coach", { body: { text } })); } catch (e) { fail(e); }
    setBusy(false);
  };

  const clear = () => { setText(""); setPrev(null); setCoachOut(null); setBreathDone(false); setPick(0); };
  const versions = prev ? [{ text: prev.delivered_text ?? "", preview_token: prev.preview_token }, ...(prev.alternatives ?? [])] : [];
  const chosen = versions[pick] ?? versions[0];

  const doSend = async (mode: "translated" | "as_written") => {
    setBusy(true);
    try {
      await api("/messages", { body: { text, mode, preview_token: mode === "translated" ? chosen?.preview_token : undefined } });
      if (prev?.heated) api("/events", { body: { name: "breath_step", props: { choice: "send" } } }).catch(() => {});
      sessionStorage.setItem(`il:lastToken`, chosen?.preview_token ?? "");
      clear(); await poll(); loadMe();
    } catch (e) { fail(e); }
    setBusy(false);
  };

  const doShareOut = async () => {
    if (!prev) return;
    setBusy(true);
    try {
      const { share_text } = await api<{ share_text: string }>("/messages/share-out", { body: { text: prev.for, preview_token: chosen.preview_token } });
      if (navigator.share) await navigator.share({ text: share_text }).catch(() => {});
      else { await navigator.clipboard.writeText(share_text); toast.success("Copied. Paste it wherever you like."); }
      loadMe();
    } catch (e) {
      const p = (e as ApiFail).p;
      if (p?.code === "free_shares_used_up") { setNotice(p.detail); upgrade("share"); } else fail(e);
    }
    setBusy(false);
  };

  const saveForLater = () => {
    if (!store) return;
    store.save(text); setDraftList(store.list());
    api("/events", { body: { name: "breath_step", props: { choice: "later" } } }).catch(() => {});
    clear(); toast("Saved on this device for later.");
  };

  const doUndo = async (m: Msg) => {
    try {
      const r = await api<{ text: string }>(`/messages/${m.id}`, { method: "DELETE" });
      setText(r.text); setPending((p) => p.filter((x) => x.id !== m.id));
      const token = sessionStorage.getItem("il:lastToken");
      if (m.mode === "translated" && token) setPrev({ delivered_text: m.text, change_summary: m.change_summary, heated: m.heated, safety: false, preview_token: token, for: r.text });
      loadMe();
    } catch (e) { fail(e); poll(); }
  };

  const toggleOriginal = async (m: Msg) => {
    try {
      await api(`/messages/${m.id}/share`, { body: { shared: !m.original_shared } });
      setMsgs((all) => all.map((x) => (x.id === m.id ? { ...x, original_shared: !x.original_shared } : x)));
    } catch (e) { fail(e); }
  };

  const stale = prev && prev.for !== text;
  const now = Date.now() + skew;

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col px-4">
      <header className="flex items-center justify-between py-4">
        <h1 className="text-2xl">You &amp; {partner}</h1>
        <Link href="/settings" className="text-sm text-muted hover:text-ink">Settings</Link>
      </header>

      <section className="flex-1 space-y-3 overflow-y-auto pb-4" aria-live="polite">
        {msgs.length === 0 && pending.length === 0 && <p className="mt-10 text-center text-muted">Your conversation starts here.</p>}
        {msgs.map((m) => (
          <div key={m.id} className={`flex ${m.mine ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-3xl px-4 py-3 ${m.mine ? "bg-primary text-white" : "border border-line bg-white"}`}>
              <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
              {m.mine && m.mode === "translated" && (
                <button className="mt-1 text-xs underline opacity-80" onClick={() => toggleOriginal(m)}>
                  {m.original_shared ? "Stop sharing my original" : "Share my original"}
                </button>
              )}
              {!m.mine && m.original_text && <p className="mt-2 border-t border-line pt-2 text-xs text-muted">Original: {m.original_text}</p>}
              {!m.mine && m.original_shared && !m.original_text && (
                <button className="mt-2 text-xs text-primary underline" onClick={() => upgrade("original")}>They shared the original — upgrade to read it</button>
              )}
              {m.mine && <p className="mt-1 text-right text-[11px] opacity-70">Delivered</p>}
            </div>
          </div>
        ))}
        {pending.map((m) => {
          const left = Math.max(0, Math.ceil((Date.parse(m.visible_at) - now) / 1000) - 1);
          return (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[80%] rounded-3xl bg-primary-100 px-4 py-3">
                <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
                <p className="mt-1 text-right text-[11px] text-muted">
                  Sending · {left > 0 ? <button className="font-semibold text-primary underline" onClick={() => doUndo(m)}>Undo ({left}s)</button> : "…"}
                </p>
              </div>
            </div>
          );
        })}
      </section>

      <section className="space-y-3 border-t border-line py-4">
        {notice && (
          <div className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-900">
            {notice} <button className="font-semibold underline" onClick={() => upgrade("translation")}>Upgrade</button>
          </div>
        )}
        {coachOut && (
          <div className="card space-y-2 text-sm">
            {coachOut.safety ? <SafetyNote /> : (
              <>
                <p><b>How it may land:</b> {coachOut.landing}</p>
                {coachOut.swaps.length > 0 && <p><b>Try:</b> {coachOut.swaps.map((s) => `"${s.from}" → "${s.to}"`).join(", ")}</p>}
                <p className="text-muted">{coachOut.encouragement}</p>
              </>
            )}
          </div>
        )}
        {prev && !stale && (
          <div className="card space-y-3">
            {prev.safety ? <SafetyNote /> : prev.heated && !breathDone ? (
              <div className="space-y-3">
                <p className="font-semibold">Take a breath.</p>
                <p className="text-sm text-muted">This sounds like it came from a hard moment. Do you want to send it now?</p>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-primary" onClick={() => setBreathDone(true)}>Yes, continue</button>
                  <button className="btn-ghost" onClick={() => { api("/events", { body: { name: "breath_step", props: { choice: "edit" } } }).catch(() => {}); setPrev(null); }}>Edit</button>
                  <button className="btn-ghost" onClick={saveForLater}>Save for later</button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-xs font-semibold uppercase tracking-wide text-primary">This will be delivered as</p>
                {versions.length > 1 ? (
                  <div className="space-y-2" role="radiogroup" aria-label="Pick a version">
                    {versions.map((v, i) => (
                      <button key={i} type="button" role="radio" aria-checked={pick === i} onClick={() => setPick(i)}
                        className={`block w-full whitespace-pre-wrap rounded-2xl border px-4 py-3 text-left leading-relaxed transition ${pick === i ? "border-primary bg-primary-50" : "border-line bg-white hover:bg-stone-50"}`}>
                        {v.text}
                      </button>
                    ))}
                  </div>
                ) : <p className="whitespace-pre-wrap leading-relaxed">{prev.delivered_text}</p>}
                {prev.change_summary && <p className="text-xs text-muted">{prev.change_summary}</p>}
                {prev.advice && <p className="rounded-2xl bg-stone-50 px-3 py-2 text-sm text-muted"><b>Just for you:</b> {prev.advice}</p>}
              </>
            )}
            <div className="flex flex-wrap gap-2">
              {!prev.safety && (prev.heated ? breathDone : true) && (
                <>
                  <button className="btn-primary" disabled={busy} onClick={() => doSend("translated")}>Send</button>
                  <button className="btn-ghost" disabled={busy} onClick={doShareOut}>
                    Share outside the app{me && !me.paid ? ` (${me.free_shares_left} free left)` : ""}
                  </button>
                </>
              )}
              <button className="btn-ghost" disabled={busy} onClick={() => doSend("as_written")}>Send as written</button>
            </div>
          </div>
        )}
        <textarea className="input min-h-24 resize-none" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)}
          placeholder={`Write to ${partner}…`} aria-label="Message" />
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-primary" disabled={busy || !text.trim()} onClick={doPreview}>Preview</button>
          <button className="btn-ghost" disabled={busy || !text.trim()} onClick={doCoach}>How will this land?{me?.paid ? "" : " ✦"}</button>
          <button className="btn-ghost" disabled={busy || !text.trim()} onClick={() => doSend("as_written")}>Send as written</button>
          {me && !me.paid && <span className="ml-auto text-xs text-muted">{me.free_translations_left} free translations left</span>}
        </div>
        {draftList.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted">Drafts ({draftList.length})</summary>
            <ul className="mt-2 space-y-2">
              {draftList.map((d) => (
                <li key={d.id} className="flex items-center gap-2 rounded-2xl border border-line bg-white px-3 py-2">
                  <span className="flex-1 truncate">{d.text}</span>
                  <button className="text-primary underline" onClick={() => { setText(d.text); store?.remove(d.id); setDraftList(store?.list() ?? []); }}>Restore</button>
                  <button className="text-muted underline" onClick={() => { store?.remove(d.id); setDraftList(store?.list() ?? []); }}>Delete</button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </main>
  );
}

function SafetyNote() {
  return (
    <div className="space-y-1 text-sm">
      <p className="font-semibold">We won't soften this one.</p>
      <p className="text-muted">
        It sounds like something serious may be going on. If you or someone else is in danger, contact local emergency services,
        or find a helpline at <a className="underline" href="https://findahelpline.com" target="_blank" rel="noreferrer">findahelpline.com</a>.
        You can edit the message or send it as written.
      </p>
    </div>
  );
}
