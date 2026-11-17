# Introverted Love

Say what you mean, and let it land gently. Couples connect, and each message can be softened for the
partner using what they shared about how they like to be spoken to. A softened message can also be shared
outside the app.

- **Free:** 10 translated messages, 5 shares outside the app, sending as written always free.
- **Paid:** unlimited translations and shares, "How will this land?" coaching, reading originals your partner shares.

## Quickstart (about 3 minutes, no accounts)

Needs Node 22+ (`.nvmrc` pins 26).

```bash
npm install
cp .env.example .env.local
npm run seed && npm run dev
```

Open <http://localhost:3000/dev/login?as=alice> in one browser and <http://localhost:3000/dev/login?as=bob> in
another (or a private window). Alice is on the free plan, Bob on paid; they're already connected. The AI is a
deterministic fake until you add a key.

## Real keys

In `.env.local`:
- `ANTHROPIC_API_KEY`: switches the coach to Claude (`ANTHROPIC_MODEL`, default `claude-opus-5-5`). `COACH=fake` forces the fake.
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`: turns on real sign-up and sign-in. Add an `email`
  claim to the Clerk session token (`{"email": "{{user.primary_email_address}}"}`) so the app knows each user's email.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Migrates `./.data` (embedded PGlite), then starts Next.js |
| `npm test` | Vitest. Race tests run only with `TEST_DATABASE_URL` (real Postgres; CI sets it) |
| `npm run typecheck` | TypeScript for core and web |
| `npm run seed` | Creates alice (free) and bob (paid), paired |
| `npm run db:reset` | Deletes `./.data` and reseeds (stop the dev server first) |
| `npm run report:events` | Event counts and weekly active couples, via the running dev server |
| `npm run dev:plan -- <email-or-id> free\|paid` | Sets a local user's plan, via the running dev server |
| `npm run db:generate` | New migration from `packages/core/src/db/schema.ts` |
| `npm run db:migrate` | Applies migrations to `DATABASE_URL` (deploy step) |
| `npm run admin:report` / `admin:plan -- <email> free\|paid` | Same as above against production `DATABASE_URL` |

Only one process may open `./.data`. If a script says it's in use, stop that process; a lock left by a
crashed process is cleared automatically.

## Deploy (Vercel + Neon by default)

1. Set `DATABASE_URL` (Neon **pooled** URL), `PREVIEW_TOKEN_SECRET` (32+ random bytes), `ANTHROPIC_API_KEY`,
   the Clerk keys. Leave `DEV_AUTH` unset. The server refuses to start if any of these are wrong.
2. Production build command: `npm run db:migrate && npm run build`. Preview builds run only `npm run build`.
3. A failed migration rolls back its own file; fix it and run `npm run db:migrate` again.

## Layout

- `packages/core`: schema, migrations, all domain rules (limits, pairing, messages, tokens, AI coach). Tested directly.
- `apps/web`: Next.js. `/api/v1/*` routes are thin wrappers over core, used by the web app and later the Expo app.
- Docs: [API](docs/API.md), [error codes](docs/ERRORS.md), [plan](docs/PLAN.md).
