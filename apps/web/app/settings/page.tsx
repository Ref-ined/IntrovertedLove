"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api, ApiFail, inviteLink } from "@/lib/client";

type Me = { display_name: string | null; plan: string; share_traits: boolean; free_translations_left: number | null; free_shares_left: number | null; couple: { partner: { name: string } | null } | null };
type Couple = { id: string; partner_name: string; active: boolean; ended_at: string | null };

export default function Settings() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState("");
  const [past, setPast] = useState<Couple[]>([]);
  const load = () => api<Me>("/me").then((m) => { setMe(m); setName(m.display_name ?? ""); })
    .catch((e: ApiFail) => e.p.status === 401 && router.replace("/"));
  useEffect(() => {
    load();
    api<{ couples: Couple[] }>("/couples").then((r) => setPast(r.couples.filter((c) => !c.active))).catch(() => {});
  }, []);
  if (!me) return null;

  const save = (body: object) => api("/me", { method: "PATCH", body }).then(load).then(() => toast.success("Saved")).catch((e) => toast.error(e.message));
  const copyInvite = async () => {
    const { code } = await api<{ code: string }>("/pair/code");
    await navigator.clipboard.writeText(inviteLink(code));
    api("/events", { body: { name: "invite_copied", props: {} } }).catch(() => {});
    toast.success("Invite link copied");
  };
  const unpair = async () => {
    if (!confirm("Disconnect? You'll both keep read-only access to your past messages.")) return;
    try { await api("/pair", { method: "DELETE" }); router.replace("/onboarding"); } catch (e) { toast.error((e as Error).message); }
  };
  const deleteAccount = async () => {
    if (!confirm("Delete your account and all your messages? This can't be undone.")) return;
    try { await api("/me", { method: "DELETE" }); location.href = "/"; } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Settings</h1>
        <Link href="/chat" className="text-sm text-muted hover:text-ink">Back to chat</Link>
      </div>
      <section className="card space-y-3">
        <label className="block space-y-2"><span className="text-sm font-semibold">Your name</span>
          <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn-ghost" onClick={() => save({ display_name: name })}>Save name</button>
      </section>
      <section className="card space-y-2">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1" checked={me.share_traits} onChange={(e) => save({ share_traits: e.target.checked })} />
          <span className="text-sm"><b>Use my questionnaire answers</b> to soften messages sent to me.</span>
        </label>
      </section>
      <section className="card space-y-2 text-sm">
        <p><b>Plan:</b> {me.plan === "paid" ? "Paid" : "Free"}</p>
        {me.plan !== "paid" && <p className="text-muted">{me.free_translations_left} free translated messages and {me.free_shares_left} free shares left.</p>}
      </section>
      <section className="card flex flex-wrap gap-3">
        {me.couple ? <button className="btn-ghost" onClick={unpair}>Disconnect from {me.couple.partner?.name ?? "partner"}</button>
          : <button className="btn-ghost" onClick={copyInvite}>Copy invite link</button>}
        <button className="btn-ghost text-rose-600" onClick={deleteAccount}>Delete account</button>
      </section>
      {past.length > 0 && (
        <section className="card space-y-2 text-sm">
          <h2 className="text-xl">Past conversations</h2>
          {past.map((c) => <p key={c.id}>{c.partner_name} · ended {new Date(c.ended_at!).toLocaleDateString()}</p>)}
        </section>
      )}
    </main>
  );
}
