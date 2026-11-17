import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.ts";

export type PreviewClaims = {
  user_id: string;
  text_hash: string;
  delivered_text: string | null;
  change_summary: string | null;
  heated: boolean;
  safety: boolean;
  nonce: string;
  exp: number; // unix seconds
};

const TTL_SECONDS = 15 * 60;
const DEV_SECRET = "dev-only-preview-secret-change-me-0123456789";

function secret(): string {
  return process.env.PREVIEW_TOKEN_SECRET || DEV_SECRET;
}

export const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

const sign = (body: string) => createHmac("sha256", secret()).update(body).digest("base64url");

export function mintToken(c: Omit<PreviewClaims, "nonce" | "exp">, now = Date.now()): string {
  const claims: PreviewClaims = { ...c, nonce: randomBytes(16).toString("hex"), exp: Math.floor(now / 1000) + TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Verifies signature, expiry, owner and text; the server trusts only these claims. */
export function verifyToken(token: string, userId: string, text: string, now = Date.now()): PreviewClaims {
  const [body, sig] = token.split(".");
  const bad = () => new ApiError(400, "invalid_token", "The preview has expired or doesn't match this text. Preview the message again.");
  if (!body || !sig) throw bad();
  const expected = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw bad();
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as PreviewClaims;
  if (claims.user_id !== userId || claims.text_hash !== hashText(text) || claims.exp * 1000 < now) throw bad();
  return claims;
}
