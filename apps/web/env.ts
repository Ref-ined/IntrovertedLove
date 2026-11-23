/**
 * Startup config check. Runs only from instrumentation register() (never at import, never during
 * next build). Errors name the variable and the fix, never its value.
 */
export function checkEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const prod = env.NODE_ENV === "production";
  const errors: string[] = [];
  if (prod && (env.PREVIEW_TOKEN_SECRET ?? "").length < 32) errors.push("Set PREVIEW_TOKEN_SECRET to at least 32 random bytes.");
  if (prod && !env.ANTHROPIC_API_KEY) errors.push("Set ANTHROPIC_API_KEY: the fake coach never runs in production.");
  if (prod && env.COACH === "fake") errors.push("Unset COACH=fake: the fake coach never runs in production.");
  if (prod && env.DEV_AUTH === "1") errors.push("Unset DEV_AUTH: dev login is for local development only.");
  if (prod && (!env.CLERK_SECRET_KEY || !env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)) errors.push("Set CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.");
  if (prod && !env.DATABASE_URL) errors.push("Set DATABASE_URL to your Postgres pooler URL.");
  const undo = env.UNDO_WINDOW_SECONDS;
  if (undo !== undefined && undo !== "" && !(Number.isInteger(Number(undo)) && (Number(undo) === 0 || Number(undo) >= 2))) {
    errors.push("Set UNDO_WINDOW_SECONDS to 0 (no undo, the default) or a whole number of at least 2.");
  }
  if (env.COACH && !["fake", "anthropic"].includes(env.COACH)) errors.push("Set COACH to fake or anthropic, or leave it empty.");
  return errors;
}
