/** The only paid check. M2 changes this to cover couple-level access. */
export function hasPaidAccess(user: { plan: string }, _couple?: unknown): boolean {
  return user.plan === "paid";
}
