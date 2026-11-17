// Thin client for the dev-only routes, so only the dev server ever opens ./.data.
// npm run report:events | npm run dev:plan -- <email-or-id> free|paid
const [cmd, who, plan] = process.argv.slice(2);
const base = process.env.APP_URL ?? "http://localhost:3000";

const req = cmd === "plan"
  ? fetch(`${base}/api/dev/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ who, plan }) })
  : fetch(`${base}/api/dev/report`);

try {
  const res = await req;
  const body = await res.text();
  if (res.status === 404 && !body.startsWith("{")) throw new Error("Dev routes are off: set DEV_AUTH=1 in .env.local.");
  console.log(body);
  if (!res.ok) process.exitCode = 1;
} catch (e) {
  console.error(e.cause?.code === "ECONNREFUSED" ? "Start `npm run dev` first." : e.message);
  process.exitCode = 1;
}
