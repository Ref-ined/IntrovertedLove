import { cookies } from "next/headers";
import { clerkEnabled, devAuthEnabled } from "./flags";

export type Who = { id: string; email: string | null };

/** The only way handlers learn who is calling. Tests mock this module. */
export async function getUserId(): Promise<Who | null> {
  if (devAuthEnabled()) {
    const dev = (await cookies()).get("dev_user")?.value;
    if (dev) return { id: dev, email: `${dev}@dev.local` };
  }
  if (!clerkEnabled()) return null;
  const { auth } = await import("@clerk/nextjs/server");
  const { userId, sessionClaims } = await auth();
  if (!userId) return null;
  const email = (sessionClaims as { email?: string } | null)?.email ?? null; // custom session-token claim
  return { id: userId, email };
}
