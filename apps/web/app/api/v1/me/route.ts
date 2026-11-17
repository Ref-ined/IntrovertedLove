import { deleteAccountData, getMe, patchMe, patchMeSchema, ApiError } from "@il/core";
import { body, route } from "@/lib/api";
import { clerkEnabled } from "@/lib/flags";

export const GET = route(({ db, who }) => getMe(db, who.id, who.email));
export const PATCH = route(async ({ db, who, req }) => patchMe(db, who.id, await body(req, patchMeSchema)));

// Database first (idempotent), then Clerk. If Clerk fails the user can sign in and retry.
export const DELETE = route(async ({ db, who }) => {
  await deleteAccountData(db, who.id);
  if (clerkEnabled() && !who.email?.endsWith("@dev.local")) {
    try {
      const { clerkClient } = await import("@clerk/nextjs/server");
      await (await clerkClient()).users.deleteUser(who.id);
    } catch (e) {
      if ((e as { status?: number }).status !== 404) {
        throw new ApiError(502, "account_delete_incomplete", "Your data is deleted, but closing the sign-in failed. Try again to finish.", { retryable: true });
      }
    }
  }
  return { ok: true };
});
