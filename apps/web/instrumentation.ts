export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { checkEnv } = await import("./env");
  const errors = checkEnv();
  if (errors.length) throw new Error(`Configuration problems:\n- ${errors.join("\n- ")}`);
}
