export type Draft = { id: string; text: string; at: number };
type Store = Pick<Storage, "getItem" | "setItem">;

const key = (userId: string) => `il:drafts:${userId}`;

/** "Save for later" drafts: this browser only, per user, never sent to the server. */
export function drafts(store: Store, userId: string) {
  const read = (): Draft[] => {
    try { return JSON.parse(store.getItem(key(userId)) ?? "[]"); } catch { return []; }
  };
  const write = (d: Draft[]) => store.setItem(key(userId), JSON.stringify(d));
  return {
    list: read,
    save(text: string): Draft {
      const d = { id: Math.random().toString(36).slice(2), text, at: Date.now() };
      write([d, ...read()]);
      return d;
    },
    remove(id: string) { write(read().filter((d) => d.id !== id)); },
  };
}
