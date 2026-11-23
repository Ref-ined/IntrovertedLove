import { NextResponse } from "next/server";
import { devRoute } from "@/lib/dev";

export const GET = devRoute(async (_db, req) => {
  const url = new URL(req.url);
  const as = url.searchParams.get("as") ?? "";
  if (!/^[a-z0-9_-]{1,32}$/i.test(as)) return new NextResponse("Use /dev/login?as=alice", { status: 400 });
  const next = url.searchParams.get("next") ?? "/chat";
  // Relative Location: req.url's host is the bind address (0.0.0.0) on a LAN dev server, which phones can't open.
  const res = new NextResponse(null, { status: 307, headers: { Location: /^\/(?![\/\\])/.test(next) ? next : "/chat" } }); // same-site paths only
  res.cookies.set("dev_user", as, { httpOnly: true, sameSite: "lax", path: "/" });
  return res;
});
