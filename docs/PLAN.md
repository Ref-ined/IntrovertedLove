<!-- /autoplan restore point: "C:\\Users\\Refined\\Desktop\\INtroverted love\\v2\\.gstack\\tmp\\autoplan\\main-autoplan-restore-20261117-145558.md" -->
# Introverted Love v2: build plan

Source design (approved): `docs/designs/introverted-love-v2.md`
Reference implementation: `../app/` (v1: React CRA + FastAPI + MongoDB, with 3 audit rounds of fixes and offline tests in `../app/backend/tests/test_audit_fixes.py`).

## Implementation plan

### Goal
Rebuild Introverted Love as one TypeScript codebase that is API-first, so a later Expo mobile app reuses the same API and domain logic. M1 is the Assignment build: a couple can sign up, connect and exchange messages that are translated (free, first 10) or coached (paid). A softened message can also be shared outside the app through the phone's share sheet (free, first 5). M2 adds Stripe billing, realtime and push, streaks, the diary and the weekly report.

### Stack (decisions)
- **Repo:** npm workspaces (built into Node 26; pnpm isn't installed). `apps/web` (Next.js App Router, TypeScript strict) and `packages/core` (domain logic, schema, zod validation, AI prompts, shared types). `apps/mobile` (Expo) comes later.
- **Database:** Postgres through Drizzle ORM. Local development and tests use **PGlite** (embedded Postgres, no install). Production uses `postgres-js` against hosted Postgres via `DATABASE_URL`, which must point at a transaction-mode pooler (`prepare: false`, `max: 1` per function), because serverless polling would otherwise exhaust connections. Default host: Vercel with Neon's pooled URL (the founder can swap it; only the URL changes). Migrations come from drizzle-kit and are committed.
  - **Migrations:** `npm run dev` runs them against `./.data` before starting (a `predev` script), and the test setup runs them once per test file on an in-memory PGlite (see Tests).
  - **One shared database client:** the client is a single instance for the whole process, cached on `globalThis` in development, so hot reloads never open `./.data` twice.
  - **One process only:** PGlite file storage allows one process. So the admin "set plan" action and the events report run as development-only API routes (`/api/dev/plan`, `/api/dev/report`, which return 404 when `NODE_ENV=production`), never as separate processes against `./.data`. `next.config` lists PGlite in `serverExternalPackages`.
    - The client opens lazily on the first query (so `next build` workers never open it) and writes `./.data/.lock` with its pid. If the lock names a dead pid (`process.kill(pid, 0)` fails), the stale lock is removed. If the pid is alive, the opener exits non-zero with: "./.data is in use by pid N (another dev server or script). Stop that process and try again."
    - `npm run report:events` and `npm run dev:plan -- <email> free|paid` are thin scripts that call those routes on `http://localhost:3000`. If the dev server is down, they exit 1 with "Start `npm run dev` first."
    - **Against production** (hosted Postgres, so a separate process is safe): `npm run admin:report` runs the same read-only report query, and `npm run admin:plan -- <email> free|paid` sets a tester's plan. Both connect with `DATABASE_URL` from the founder's machine, refuse a PGlite (empty) URL, and print the target host before acting. This is how the M1 metric is read from the deployed app.
  - **Production migrations:** a separate `npm run db:migrate` (drizzle-kit migrate against `DATABASE_URL`). `npm run build` is only `next build`, so a preview build can never migrate production. The production deploy runs `npm run db:migrate && npm run build`. A failed migration rolls back its own file (drizzle runs each file in a transaction). Fix the migration and run it again.
  - **`npm run seed`** runs migrations first (`preseed`), so it works on a clean checkout.
  - **`npm run db:reset`** deletes `./.data` (Node `fs.rm`, so it works on Windows) and re-runs migrations and the seed.
- **Auth:** `@clerk/nextjs`. The `clerkMiddleware` and `auth()` calls accept web session cookies and mobile `Authorization: Bearer` tokens on the same `/api/*` handlers. A user row is created lazily on the first authenticated request (`ensureUser`). Its email comes from a Clerk session-token custom claim (`email`), so no Backend API call is needed. It's refreshed whenever the claim differs from the stored value.
  - **Dev without keys:** when `DEV_AUTH=1` and the Clerk keys are empty, `middleware.ts` skips `clerkMiddleware` and the root layout renders without `ClerkProvider`, so Clerk never throws or enters keyless mode and makes no network calls. A smoke test boots the app with empty Clerk env.
- **AI:** `@anthropic-ai/sdk` called directly with `ANTHROPIC_API_KEY`, current Sonnet model (exact ID checked with the claude-api reference at build time). Structured output comes through a tool or JSON schema and is validated with zod. All AI calls go through a single `Coach` interface in `packages/core/ai` with a deterministic fake for tests and local development.
  - **The fake never runs in production.** `COACH=fake|anthropic` picks the coach, and the default is `anthropic` when `ANTHROPIC_API_KEY` is set and `fake` otherwise, outside production only. In production a missing key fails the startup env check. The dev server logs `coach=fake` once when the fake is active.
  - `ANTHROPIC_MODEL` overrides the model ID. The client is created with `timeout: 20_000` and `maxRetries: 0` (the SDK retries twice by default, which would stretch 20 s to about 60 s). AI routes set `maxDuration = 30`, so the platform never kills a request before the reservation is released.
- **UI:** Tailwind CSS. Design tokens are ported from v1's `design_guidelines.json` (lavender primary, warm stone neutrals, Fraunces + Manrope) and `sonner` for toasts. v1's 46-file UI kit isn't copied; components are built as needed.
- **Tests:** Vitest for `packages/core` and for API route handlers, which are called directly against PGlite. Each test file migrates one PGlite once, and each test runs inside a transaction that is rolled back, so the suite stays fast as it grows. Typecheck, lint and tests run in GitHub Actions.
  - **Race tests:** PGlite runs queries one at a time, so it can't show a race. The parallel sends, parallel previews and concurrent pairing tests run against a Postgres 16 service container in CI, through `TEST_DATABASE_URL`. Without it they are skipped with a visible reason (`it.skipIf`). The single-request logic for the same rules has its own tests, which always run on PGlite.

### Data model (packages/core/db/schema.ts)
- **`users`**
  - `id`: Clerk user ID
  - `email`, `display_name`, `birthdate`, `timezone`
  - `plan`: `free` or `paid`. In M1 an admin script sets it; in M2 it's derived from Stripe.
  - `free_translations_used` (int, 0..10, counts sent translated messages)
  - `free_previews_used` (int, 0..30, a cap on free AI previews)
  - `free_shares_used` (int, 0..5, counts messages shared outside the app)
  - `pair_code`, `pair_code_expires_at` (the code lasts 7 days and is replaced right after a successful pairing, so each code works once)
  - `share_traits` (bool, recipient consent)
  - `age_blocked` (bool)
  - `ai_window_start`, `ai_calls_in_window`: the per-user AI cap (see Limits)
  - CHECK constraints keep `free_translations_used` within 0..10, `free_previews_used` within 0..30 and `free_shares_used` within 0..5, so a bad refund fails loudly instead of going negative.
  - `pair_code` has a unique index. `email` is not unique (Clerk owns identity), so a re-signup after deletion is never blocked.
  - `created_at`
- **`couples`:** `id`, `created_at`, `ended_at`.
- **`couple_members`:** `couple_id`, `user_id`, `active` (bool).
  - A partial unique index on `user_id WHERE active` puts each user in at most one active couple, enforced by a single column.
  - Pairing locks both user rows with `SELECT ... FOR UPDATE` in id order before inserting the two member rows.
  - Unpairing sets `couples.ended_at` and `active=false` for both members.
- **`pair_attempts`:** `user_id`, `at`, used to rate-limit code entry to 10 per hour.
- **`questionnaire`:** `user_id` (primary key), `answers` (jsonb, validated against the question list), `traits` (derived labels), `updated_at`.
- **`messages`**
  - `id`, `couple_id`, `sender_id`
  - `original_text`, `delivered_text`
  - `mode`: `translated` or `as_written`. Coaching is advisory: the sender edits their draft, then sends it translated or as written.
  - `change_summary`, `heated` (bool), `original_shared` (bool)
  - `charged_free_slot` (bool): set at insert when the send consumed a free translation. Undo and unpair refund only when this is true, never by looking at the current plan.
  - `preview_nonce` (nullable, unique): the token's nonce for a translated send. The unique index enforces one send per token, and undo's hard delete frees it automatically.
  - `created_at`
  - `visible_at`: set on insert by the app's SQL as `clock_timestamp() + make_interval(secs => $UNDO_WINDOW_SECONDS)`, using the database clock at the moment of the insert (not the transaction start). The insert is the send transaction's last statement, and the transaction runs with `SET LOCAL lock_timeout = '1s'`. A send that would wait longer fails with 503 `busy` (`retryable: true`) instead of committing a `visible_at` that is already behind a poller's cursor. The default window is 10 seconds (E1), and the minimum is 2 seconds. Even with undo cut, a short window keeps a slow commit from landing behind a poller's cursor. The column has no default of its own. Index `(couple_id, visible_at, id)`.
- **`events`:** `id`, `user_id`, `couple_id` (nullable), `name` (enum), `props` (jsonb validated per event name, never message text), `created_at`. Index `(user_id, name, created_at)`.
- **Foreign keys:** every `user_id` / `sender_id` references `users(id) ON DELETE CASCADE`, and `couple_members.couple_id` references `couples`. Deleting a user removes their messages from both people's history, which is the privacy choice the App Store expects.
- **M2:** `subscriptions` (Stripe IDs, status, `current_period_end`, `user_id`), `stripe_events` (event ID primary key for idempotency), streak columns on `couples`, `diary_notes`, `reports`.

### API (apps/web/app/api/v1, JSON, every handler validates input with zod and checks auth)
- **Versioning:** every route lives under `/api/v1` (paths below are written without the prefix). The zod schemas in `packages/core` are the contract. A breaking change gets `/api/v2`, while `/api/v1` keeps working until the Expo app's minimum supported version no longer calls it.
- **Error format:** every error is RFC 9457 `application/problem+json`, built by one helper, `apiError()`, in `packages/core/errors.ts`:
  `{type: "/docs/errors#<code>", title, status, code, detail, retryable, request_id, retry_after?, fields?, limit?}`.
  - `code` is stable snake_case, and `docs/ERRORS.md` has one anchor per code, giving its meaning and the fix.
  - `detail` names the actual value and the fix, for example "Text is 4213 characters; the maximum is 4000. Shorten it and send again."
  - zod 400s are `invalid_input`, with `fields: [{path, message}]`.
  - 429s send a `Retry-After` header plus `retry_after` in seconds: for pairing, from the oldest attempt in the hour; for AI calls, from the end of the fixed window.
  - `request_id` is also in the server log line. Unexpected errors return 500 `internal` with only the `request_id`, and the stack goes to the log. Error bodies and logs never contain secret values or message text.
- **Limits:**
  - Message, preview and coach text is 1 to 4000 characters.
  - Every user is limited to 120 AI calls per hour (preview plus coach), with 429 `ai_rate_limited` above that. That's 2 a minute, enough for a heated back-and-forth, and still bounds paid spend.
    - The call is reserved **before** calling the AI with one atomic statement on the user row: a fixed one-hour window that resets `ai_window_start` and `ai_calls_in_window` when the window has passed, and otherwise increments only `WHERE ai_calls_in_window < 120`. Parallel requests can't overshoot.
    - `Retry-After` is `ai_window_start + 1 hour - now()`. A failed AI call still counts (it cost money or time).
- **CSRF:** mutating routes accept only `Content-Type: application/json` (415 `unsupported_media_type` otherwise), so a cross-site form post can't carry the session cookie past a CORS preflight.
- **Dev routes** (`/api/dev/*`, `/dev/*`) need both `NODE_ENV !== 'production'` and `DEV_AUTH=1`.
- **Account:**
  - `GET /api/me` returns the user, plan, free translations left, couple and partner summary.
  - `PATCH /api/me` updates the display name and time zone.
  - `DELETE /api/me` deletes the account's messages, questionnaire, events and memberships, unpairs, and deletes the Clerk user. The App Store requires this for the later Expo app.
    - **Order:** the database transaction runs first (it deletes the `users` row, and the foreign keys cascade to messages, questionnaire, events and memberships), then the Clerk delete. Both steps are idempotent.
    - **If Clerk fails:** the response is 502 `account_delete_incomplete` with `retryable: true`. The user can still sign in, and calling DELETE again finishes the job. Any empty row `ensureUser` recreated in between is deleted by that retry.
  - `ensureUser` uses `INSERT ... ON CONFLICT (id) DO NOTHING`, so parallel first requests are safe.
- **Age gate:** `POST /api/me/birthdate` sets the birthdate once and returns 403 `age_blocked` under 18. An under-18 attempt is stored as `age_blocked=true`, so later attempts also get 403 `age_blocked` and a different date can't be retried. That code has no self-serve fix, and the client signs the user out. All other endpoints return 403 `age_required` (fix: POST a birthdate) until a birthdate is set, except `GET /api/me`. That stays open and reports `birthdate_set`, so the client knows to show the birthdate step.
- **Pairing:**
  - `GET /api/pair/code` returns the current code. An expired code is rotated atomically (`UPDATE … WHERE pair_code_expires_at < now() RETURNING`), so two concurrent GETs agree on one code.
  - `POST /api/pair` with `{code}` inserts the attempt first, then counts the hour's attempts (so parallel guesses can't skip the limit), then creates the couple in one transaction. Unique indexes reject a second active couple. Errors, each mapped to its `/pair` page message:

    | Status | Code | Meaning |
    |---|---|---|
    | 400 | `own_code` | You entered your own code |
    | 409 | `already_paired` | You're already in a couple |
    | 409 | `partner_unavailable` | The code's owner is already paired |
    | 410 | `code_expired` | The code is expired or used |
    | 429 | `rate_limited` | Too many attempts this hour |
    | 403 | `age_required` | No birthdate set yet |
    | 403 | `questionnaire_required` | Either person hasn't finished the questionnaire |
  - `DELETE /api/pair` unpairs.
    - Both people keep read-only access to their past messages, and pending messages are deleted. Deleted pending messages refund their free slot when `charged_free_slot` is true.
    - Both pair codes rotate.
    - Re-pairing with the same person starts a new couple, and the old history stays read-only under the old couple.
- **Questionnaire:** `GET /api/questionnaire` returns the questions. `PUT /api/questionnaire` with `{answers, share_traits}` validates every answer against the option list.
- **Messages:**
  - `GET /api/couples` lists the user's couples, active and past, with partner name and dates.
  - `GET /api/messages?couple_id=&cursor=<opaque>` lists one couple's messages. `couple_id` defaults to the active couple. Past couples are read-only, and with no active couple and no `couple_id` the response is 404 `not_paired`. The cursor is per couple. It lists the messages through one serializer, ordered by `(visible_at, id)`. The cursor is base64url JSON of `(visible_at, id)`, returned as `next_cursor`. Clients pass it back unchanged and never build it themselves. A bad cursor is 400 `invalid_cursor`.
    - The sender sees all of their own messages, including ones still in the undo window, plus `original_text`.
    - The recipient sees only messages with `visible_at <= now()` (database clock). They get `original_text` only when `original_shared && hasPaidAccess(recipient, couple)`, and otherwise just `original_shared`. `hasPaidAccess` in `packages/core` is the single paid check for the serializer, coach and translation counters. In M1 it is `user.plan === 'paid'`, and M2 changes only this function to cover couple-level access.
    - Because the cursor is `(visible_at, id)`, a message that becomes visible later is never skipped.
    - **Response:** `{messages, pending, server_now, next_cursor}`.
      - `messages` holds only rows with `visible_at <= now()`, for both people, and the cursor advances only over these.
      - `pending` holds the sender's own messages that are still in the undo window. It's returned in full on every poll and never moves the cursor, so neither partner's cursor can skip a message.
      - Each message carries `visible_at`. The client counts down "Sending · Undo" from `visible_at - server_now`, never from its own clock.
  - `POST /api/messages/preview` with `{text}` returns the translation preview, `heated` and `safety` without storing any text. A free user's preview allowance is reserved here and released on failure; see the translation flow below.
  - `POST /api/messages` with `{text, mode, preview_token?}` sends.
  - `DELETE /api/messages/:id` is undo (E1). The sender can use it while `clock_timestamp() < visible_at - interval '1 second'`. The 1-second margin keeps an undo from landing after a recipient poll already returned the message.
    - In one transaction, it hard-deletes the row, which frees the nonce with it. If `charged_free_slot` is true, it also runs `free_translations_used = free_translations_used - 1`, so re-sending the same preview doesn't charge twice.
    - It returns 409 after the window and 404 to anyone else.
  - `POST /api/messages/share-out` with `{text, preview_token}` (final gate). This shares a softened message **outside** the app, for example to a partner who isn't on the app yet.
    - It verifies the token like a translated send: the text hash must match, and a safety token gets 422 `safety_requires_as_written`.
    - It reserves a share atomically for users without paid access: `SET free_shares_used = free_shares_used + 1 WHERE id = $1 AND free_shares_used < 5`. When that fails it returns 402 `free_shares_used_up` with `limit: 5`, and the UI offers the upgrade. Paid users share without limit.
    - It works paired or unpaired. It stores no message, writes a `message_shared_out` event, and returns `{share_text}`.
    - The client then opens `navigator.share({text})`, or copies to the clipboard where the share sheet isn't available.
    - shortcut: a share the user cancels in the sheet still counts, and the preview text is visible on screen anyway. The paywall is on the Share button, not on the text. Upgrade to a refund on `AbortError` if testers complain.
  - `POST /api/messages/:id/share` with `{shared}`, sender only. It's allowed during the window and takes effect once the message is visible.
- **Events:** `POST /api/events` with `{name: 'breath_step', props: {choice: 'send'|'edit'|'later'}}`. Only client-side events are accepted here. Server events are written by the handlers themselves.
- **Coaching:** `POST /api/coach` with `{text}`, paid only (403 `upgrade_required` otherwise). Returns `{landing, swaps[], encouragement, safety}` and stores nothing. `landing` names the partner and the specific trait it's based on, for example "Maya prefers gentle feedback". That partner-specific model is the moat: generic OS-level rewriters can't do it. If the partner has `share_traits=false`, `landing` says it's general advice, for example "Maya hasn't shared her preferences, so this is general advice", and names no trait.

### Translation and send flow (core/messages.ts)
1. The client calls `preview`. A free user's 10 translations count **sent** translated messages, which matches "first 10 messages". Previews have their own cap to limit AI spend.
   - **Preview allowance:** a preview is allowed while `free_previews_used < 30` and either `free_translations_used < 10` or `free_shares_used < 5`, which allows about 3 previews per free message. The preview counter is reserved atomically: `UPDATE users SET free_previews_used = free_previews_used + 1 WHERE id = $1 AND free_previews_used < 30 AND (free_translations_used < 10 OR free_shares_used < 5)`.
   - **The translation slot** is reserved atomically at **send** of a translated message: `... SET free_translations_used = free_translations_used + 1 WHERE id = $1 AND free_translations_used < 10`. A lost race returns 402.
   - **Past either limit:** preview returns 402 `free_translations_used_up` (10 sends used and 5 shares used) or `free_previews_used_up` (30 previews used), each with `limit` and `used`, and the composer switches to sending as written with the matching explanation.
   - **Unpaired users** can preview using neutral default traits, so the composer shows its value before the partner joins. Only 5 of the 30 free previews can be used while unpaired (`free_previews_used < 5` is added to the reservation when there is no active couple, 402 `free_previews_used_up` with `limit: 5`). That covers the 5 free shares, and the rest survives until the partner arrives.
   - **Then translate** through the `Coach` with both partners' answers: the recipient's traits say how it should land (neutral defaults if their `share_traits` is false), and the sender's own traits keep it sounding like them. The coach is a relay: it outputs only the sender's message, in a humbler tone, with the same meaning, and never replies, advises or adds anything the sender didn't say (founder, 2026-11-17).
   - **On AI failure or the 20-second timeout:** release the preview reservation and return 503 `translate_failed` with `retryable: true` and `detail` "Nothing was charged or stored." The client retries at most twice with backoff, then offers to send as written.
2. The preview returns `{delivered_text, change_summary, heated, safety, preview_token}`.
   - **The token** is an HMAC over `{user_id, sha256(text), delivered_text, change_summary, heated, safety, nonce, exp}` and expires after 15 minutes. At send, the server reads `heated`, `safety`, `delivered_text` and `change_summary` from the verified token, never from the client.
   - The HMAC is checked with `timingSafeEqual`. The token binds the sender, not the couple: a preview made before pairing (neutral traits) can still be sent after pairing, which is accepted.
   - **One send per token:** the message insert with `preview_nonce` fails on the unique index if the token was already used, and returns 409 `already_sent`.
   - **After an undo,** the message row and its nonce are gone, and a free translation slot is returned. The composer gets back the original text and keeps the token in memory, so the same preview can be sent again without a new AI call. Once the token's 15 minutes are up, a fresh preview is needed, and for a free user that uses one of the 15 previews.
3. **If `safety` is set,** the client shows support resources and the options to edit or send as written, and there's no softened version.
   - The preview returns `delivered_text = null`.
   - `POST /api/messages` rejects `mode=translated` with a safety token: 422 `safety_requires_as_written`.
   **If `heated` is set,** the client shows the breath step (Send, Edit or Save for later) and reports the choice through `POST /api/events`. Save for later keeps the draft in localStorage only (E3).
4. `POST /api/messages` with `mode=translated` requires a valid, unused `preview_token` whose text hash matches. `mode=as_written` stores `delivered_text = original_text` and needs no AI. A free user past 10 can only send `as_written`, and the UI explains why.
5. **Paid users** get translation on every send (no counter), can coach before preview, and can still choose to send as written.
6. **Known gap (TASTE, decided at the final gate):** `as_written` sends make no AI call, so they get no `heated` or `safety` detection and no breath step. That includes every send by a free user past 10. This keeps the free tier at zero AI cost.

### Pages (apps/web/app)
- `/`: landing for signed-out visitors.
- `/sign-in`, `/sign-up`: Clerk components with the app theme.
- `/onboarding`: birthdate (Day, Month and Year dropdowns as in v1), then the questionnaire with the consent explainer, then the partner step. The partner step shows your code with "Copy invite link" (E2) and a box for entering your partner's code.
- `/pair?code=<code>` (E2). Codes are 10 characters from a 31-symbol alphabet, about 49 bits, so guessing across many cheap accounts isn't practical.
  - **Signed out:** the visitor chooses Sign up or Sign in. Both carry `redirect_url=/pair?code=XXXX`, so the code survives email verification in a new tab (no sessionStorage), and `/pair` routes them by their state after auth.
  - **Signed in but not onboarded** (no birthdate or questionnaire yet): goes to `/onboarding` with the code saved, and the partner step pre-fills it.
  - **Signed in, onboarded and not paired:** a "Connect with your partner" confirm button calls `POST /api/pair`. Errors show the messages from the pairing error table.
  - **Your own code:** shows "This is your own invite. Send it to your partner."
  - **Already paired:** shows "You're already connected with {name}".
  - **Expired or used code:** shows "This invite has expired. Ask your partner to send a new link."
- `/chat`: a calm conversation.
  - **Polling:** polls `GET /api/messages?cursor=` every 5 seconds while visible and every 30 seconds when hidden.
  - **Message status:** no read receipts and no typing indicator. Your own message shows "Sending · Undo" until it's visible, then "Delivered".
  - **Composer:** draft, then optional "How will this land?" (paid), then "Preview", then the "This will be delivered as…" card with the heated breath step, then Send or **Share outside the app** (5 free, then upgrade). There's also a "Drafts (n)" tray.
- `/settings`: name, trait-sharing consent toggle, "Copy invite link", unpair, plan status.

### Accepted additions (CEO review, SELECTIVE EXPANSION)
This is the single description of the additions. Their API, data and page details are written into the sections above.
- **Undo window, E1:** messages stay hidden from the recipient until `visible_at` (10 seconds after sending, set by the database clock).
  - **Undo:** `DELETE /api/messages/:id` hard-deletes the message inside the window, returns 409 after it and 404 to non-senders. It also returns a free user's translation slot, so the same preview can be re-sent without another charge.
  - **Sender's view:** "Sending · Undo" until the message is visible, then "Delivered".
- **Invite link, E2:** `/pair?code=` works for signed-out visitors through sign-up and onboarding, carried in `redirect_url`. There's also a message for users who are already paired, a message for expired or used codes, and a "Copy invite link" button in onboarding and settings. Codes last 7 days and work once, and the rate limit applies.
- **Drafts tray, E3:** "Save for later" drafts are kept only in localStorage under `il:drafts:<userId>`. A "Drafts (n)" tray restores or deletes them, and nothing goes to the server. The logic lives in `apps/web/lib/drafts.ts` so it can be unit-tested.
- **Product events, E4:** `events` rows, with enum names and validated props and never message text:
  - `message_sent` with `{mode, heated, translated}`
  - `message_undone`
  - `breath_step` with `{choice}`, sent by the client through `POST /api/events`
  - `coach_used`, `original_shared`, `paired`
  - `translation_failed` with `{reason: timeout|api_error|invalid_output}`
  - `invite_copied` and `invite_opened` (the pairing funnel)
  - `message_shared_out` with `{paid}`
  - `upgrade_clicked` with `{feature: coach|original|translation|share}`: a "fake door" that tests willingness to pay before Stripe exists

  `npm run report:events` prints counts per user, plus the M1 success metric: **weekly active couples where both partners sent at least one message**.
- **Deferred to TODOS.md (created in the first build commit):** E5, letting the recipient ask for the original, and E6, the PWA manifest, which goes with M2 Web Push.

### Safety
The coach and translate prompts return a `safety` flag for threats, abuse, coercion or self-harm. When it's set, there's no softening. The UI shows support resources and still lets the user send as written. Prompt fixtures are covered in tests with the fake coach. A live-model eval script is listed but not run in CI.

### Secrets and config
- `.gitignore` covers `.env*` from the first commit. `.env.example` lists `CLERK_*`, `ANTHROPIC_API_KEY`, `DATABASE_URL` (empty means PGlite under `./.data`), `PREVIEW_TOKEN_SECRET`, `UNDO_WINDOW_SECONDS`, `DEV_AUTH`, `COACH`, `ANTHROPIC_MODEL`, and M2's `STRIPE_*` and `VAPID_*`.
- **One env check:** `apps/web/env.ts` validates every variable with zod. It runs only from `register()` in `instrumentation.ts` at server start, never at module import, and is skipped during `next build` (`NEXT_PHASE === 'phase-production-build'`), so CI and preview builds need no production secrets. A bad config fails at startup, not on the first request. Each error names the variable and the fix, for example "Set PREVIEW_TOKEN_SECRET to at least 32 random bytes". It never prints values.
  - `PREVIEW_TOKEN_SECRET` has a development-only default and is required in production.
  - `ANTHROPIC_API_KEY` is required in production.
  - `UNDO_WINDOW_SECONDS` must be an integer of at least 2 (default 10). Anything else fails the check.
  - `DEV_AUTH=1` in production fails the check.
- **Auth seam:** handlers get the user only through `getUserId(req)` in `apps/web/lib/auth.ts`, which wraps Clerk's `auth()`. Handler tests mock this function, so tests never need Clerk.
- **Dev login (no Clerk needed):** when `DEV_AUTH=1` and `NODE_ENV` isn't production, `getUserId` reads a `dev_user` cookie instead of Clerk.
  - `/dev/login?as=alice|bob` sets that cookie and goes to `/chat`. Like the other `/dev` routes, it returns 404 in production.
  - `npm run seed` creates alice and bob, onboarded, adults and paired, with bob on paid, so every feature can be tried in two tabs.
  - `.env.example` ships with `DEV_AUTH=1` and empty Clerk keys, so a clean checkout runs with no accounts. Clerk keys are needed only to test real sign-up.
- v1 keys aren't reused (rotation is the founder's step). Local development can run with Clerk's development keys provided by the founder.

### Tests (Vitest, packages/core and the API handlers)
- **Serializer:** the recipient never gets an unshared original, a free recipient never gets a shared original, the sender always gets their own.
- **Free translations:**
  - 30 parallel translated sends for a free user succeed exactly 10 times.
  - 40 parallel previews reserve exactly 30.
  - An AI failure returns the preview reservation.
  - An unpaired user can preview using neutral traits.
- **Sending:** `translated` without a valid token is rejected, a tampered delivered text fails the HMAC check, and `as_written` always works.
- **Coaching:** free users get 403. Paid users get validated output. Safety fixtures produce no swaps.
- **Pairing:** a second active couple fails, the 11th attempt in an hour gets 429, an expired code is rejected, and a used code is rotated.
- **Age gate:** under 18 gets 403, and other endpoints are blocked until the birthdate is set. After an under-18 attempt, a retry with an adult date still gets 403 (`age_blocked`).
- **Concurrent pairing:** X redeeming Y's code while Z redeems X's code leaves X in exactly one active couple (CI Postgres).
- **Limits:** text over 4000 characters gets 400, and the 121st AI call in an hour gets 429 `ai_rate_limited`.
- **Account deletion:** `DELETE /api/me` removes the user's messages, questionnaire, events and memberships, and unpairs the partner.
- **Questionnaire:** invalid answers get 400.
- **Undo, E1:**
  - The recipient doesn't see a message before `visible_at`, and does after.
  - A later visible message doesn't let the cursor skip an earlier hidden one.
  - The sender's DELETE inside the window removes the message and returns the free slot. A re-send of the same token works, and `free_translations_used` is unchanged overall.
  - DELETE after the window gets 409; a non-sender gets 404.
  - Tests control time by setting `visible_at` directly (for example to `now() - interval '1 second'`), never by sleeping.
- **Free limit edges:** a 31st preview returns 402 `free_previews_used_up`, and a preview after 10 translated sends and 5 shares returns 402 `free_translations_used_up`. `GET /api/me` works before the birthdate is set and reports `birthdate_set`.
- **Pair link states:**
  - Your own code gets 400 `own_code`, and an inviter who is already paired gets 409 `partner_unavailable`.
  - Each error code maps to its page message.
- **Sender cursor:** the sender polls while their own message is pending. A partner message that becomes visible afterwards, with an earlier `visible_at`, is still delivered to the sender.
- **Safety send:** `mode=translated` with a safety token returns 422 `safety_requires_as_written`.
- **Undo window setting:** `visible_at` respects `UNDO_WINDOW_SECONDS`.
- **Preview token:** a replayed token is rejected, and a token reused after undo is accepted once. `heated` and `safety` come from the token, not the client.
- **Invite, E2:** a code from the link pairs through `POST /api/pair`; a used or expired code gives the expired message; an already-paired user is refused.
- **Drafts, E3:** `drafts.ts` keys drafts per user (one user's tray doesn't show another's) and saves, restores and deletes them, tested with an in-memory storage stub.
- **Events, E4:** `message_sent`, `message_undone` and `paired` rows are written. `POST /api/events` rejects unknown names and props, and no event row contains message text (checked against the schema).
- **Eng review additions:**
  - 150 parallel AI calls for one user reserve exactly 120, and the 121st gets 429 with `Retry-After` (CI Postgres).
  - An undo after the user switches from paid to free refunds nothing, because `charged_free_slot` is false. Unpair refunds pending charged sends. The CHECK constraints reject a negative counter.
  - The AI client is built with `maxRetries: 0`, and a fake that hangs past 20 s returns 503 `translate_failed` with the reservation released.
  - A send blocked on the user row lock for more than 1 s returns 503 `busy` (CI Postgres).
  - A mutating route with `text/plain` gets 415. `/api/dev/*` returns 404 without `DEV_AUTH=1`.
  - Two concurrent `GET /api/pair/code` calls after expiry return the same code. Parallel pair attempts can't exceed 10 per hour.
  - After an unpair, `GET /api/messages` without `couple_id` returns 404 `not_paired`, the old couple is readable through `couple_id`, and `GET /api/couples` lists it.
  - `DELETE /api/me` cascades through the foreign keys, and a later `ensureUser` with the same email works.
  - A stale `.lock` with a dead pid is removed. A live one gives the "stop pid N" error.
  - The parallel-send test mints tokens directly with the test `PREVIEW_TOKEN_SECRET`, because a free user only gets 30 previews.
- **Outside-voice additions:**
  - The app boots and serves `/dev/login` with empty Clerk keys and `DEV_AUTH=1`.
  - `next build` succeeds with no production env.
  - The 6th unpaired preview gets 402 with `limit: 5`, and pairing unlocks the rest.
  - `POST /api/pair` before the questionnaire gets 403 `questionnaire_required`.
  - `hasPaidAccess` is the only paid check (lint rule or grep test: no other `plan === 'paid'`).
  - `admin:plan` refuses an empty `DATABASE_URL`.
- **Final gate additions:**
  - 10 parallel share-outs for a free user succeed exactly 5 times, and the 6th gets 402 `free_shares_used_up` (CI Postgres). Paid users are unlimited.
  - A share-out with a safety token gets 422, and one with a mismatched text hash is rejected.
  - A share-out works unpaired, stores no message and writes a `message_shared_out` event.
  - The 11th translated send for a free user gets 402. A free user with sends left but shares used up can still preview.
- **Developer experience:**
  - Every error response matches the problem+json shape, and every `code` used in the handlers has an anchor in `docs/ERRORS.md` (one test walks the codes).
  - 429s carry `Retry-After`.
  - The env check rejects a missing production secret, `DEV_AUTH=1` in production, and `UNDO_WINDOW_SECONDS=abc` or `1`.
  - The fake coach is refused in production.
  - `/dev/*` routes return 404 in production.
  - A bad cursor gets 400 `invalid_cursor`.
  - A failed Clerk delete returns 502, and a retry completes the deletion.

### Milestone 2 (same repo, after M1 is green)
- **Stripe subscription checkout and portal:** the webhook is idempotent through `stripe_events` and sets `plan` from subscription status, and the partner gets paid access through the couple. Double checkout is refused. Cancellation and `past_due` are handled.
- **Realtime and push:** push updates through a hosted realtime service or LISTEN/NOTIFY, plus Web Push with new VAPID keys and the PWA manifest (E6), which iOS needs before web push works.
- **Streaks:** either partner's message counts, measured in the creator's time zone, with a quiet reset.
- **Diary and weekly report:** both ported from v1.

### Build order (cut line)
1. Workspace, database, env check, `apiError()`, auth seam with dev login and seed, README quickstart, age gate, questionnaire, pairing.
2. Preview and translate, send as translated or as written, messages API with `visible_at`, cursor and pending, `/chat`. The `visible_at` column and its minimum window ship here, even if undo is cut.
3. Coaching, sharing originals, share outside the app, safety UI.
4. E2 invite link, E4 events.
5. E1 undo endpoint and UI (DELETE, slot return), E3 drafts tray.

**Cut line:** if time runs short, steps 1-3 alone are a usable M1. Steps 4-5 come next.

### Alternatives considered
- **Composer plus share sheet** (deliver through WhatsApp or iMessage): not the main delivery path. At the final gate the founder kept the in-app chat and added sharing outside the app beside it as a premium feature: 5 free shares, then upgrade.
- **Mobile first with Expo:** web first was chosen, so M1 can reach testers with a link. `packages/core` and the API keep Expo cheap later.
- **One Postgres everywhere instead of PGlite** (outside voice, eng): removes the lock file, the one-process rule, the dev-route scripts and the race-test skip, but needs Docker or a hosted database account. Queued as TASTE d7.
- **Fixing v1 in place:** rejected because CRA, MongoDB and the Emergent proxy caused the audit findings (see the Step 0 code reuse table).

### Docs (first build commit)
- `README.md` quickstart, under 5 minutes on a clean checkout with no accounts:
  1. `npm install`
  2. `cp .env.example .env.local`
  3. `npm run seed && npm run dev`
  4. Open `localhost:3000/dev/login?as=alice` in one browser and `?as=bob` in another (or a private window).
  - It also lists the Node version (pinned in `engines` and `.nvmrc`), every npm script, how to switch to real Clerk and Anthropic keys, and the deploy steps (`db:migrate`, then `build`).
- `docs/ERRORS.md`: one anchor per error code, giving its meaning and the fix.
- `docs/API.md`: the `/api/v1` routes with one copy-paste `curl` each, written for the Expo client.

### Done means (M1)
- `npm install`, `npm run seed`, `npm run dev` and `npm test` all work on a clean checkout with **no accounts**: dev login and the fake coach. The README quickstart reaches alice and bob chatting in under 5 minutes.
- All tests above pass, plus typecheck and lint.
- A manual run in two browsers: sign up through Clerk, onboarding, pairing, a translated send, the free limit, an as-written send, sharing an original, and coaching for a user set to paid with `npm run dev:plan`.


<!-- autoplan-accepted:ceo -->
- E1 Undo window: messages carry DB-set `visible_at = now() + 10s`; recipient serializer and `(visible_at, id)` cursor hide them until visible; sender `DELETE /api/messages/:id` within the window hard-deletes and frees the preview nonce, 409 after, 404 for non-senders; sender sees "Sending · Undo" then "Delivered"; tests for hidden-then-visible, no cursor skip, undo-delete and re-send, 409, 404.
- E2 Invite link: `/pair?code=` page carries the code through sign-up (sessionStorage + `redirect_url`) into the onboarding partner step; "Copy invite link" in onboarding and settings; codes last 7 days, are single-use (rotated on pair) and rate-limited; already-paired and expired/used messages; tests for link-code pairing, used/expired and already-paired refusals.
- E3 Drafts tray: `apps/web/lib/drafts.ts` stores Save-for-later drafts only in localStorage under `il:drafts:<userId>` with save, restore and delete, shown as a composer "Drafts (n)" tray; never sent to the server; unit tests with a storage stub for per-user isolation and the three operations.
- E4 Product events: `events(id, user_id, couple_id?, name enum, props jsonb, created_at)` records message_sent{mode,heated,translated}, message_undone, breath_step{choice} via `POST /api/events`, coach_used, original_shared, paired, translation_failed{reason enum timeout|api_error|invalid_output}; never message text; `npm run report:events`; tests for written rows, rejection of unknown names/props and no text fields.
- Preview token hardening (from CEO spec review): HMAC covers user, text hash, delivered_text, change_summary, heated, safety, nonce, exp; server reads heated/safety from the token; one send per nonce (`preview_nonces`), linked through `messages.preview_nonce` and freed on undo; preview returns `safety`; tests for replay rejection and token-derived flags.
- Spec review round 2 (mechanical): message modes are `translated` and `as_written` only (coaching is advisory); `GET /api/me` is exempt from the age gate and reports `birthdate_set`; free-preview counting from round 2 is superseded by the CEO-voice rule below; paid users may still send as written; `/pair` handles signed-in unpaired (confirm button), sign-in as well as sign-up redirects, and own-code; the serializer returns `visible_at` and `server_now`; `UNDO_WINDOW_SECONDS` (default 10) and tests set `visible_at` directly; `getUserId()` auth seam mocked in tests; `PREVIEW_TOKEN_SECRET` dev default refused in production; tests for each.
- Spec review round 3 (mechanical, applied at the review cap): `predev` and test setup run migrations; PGlite client is a `globalThis` singleton in dev; `visible_at` is set by insert SQL with `make_interval(secs => UNDO_WINDOW_SECONDS)`; messages response is `{messages, pending, server_now}` and the cursor advances only over visible rows; safety tokens carry `delivered_text = null` and `mode=translated` with one returns 422 `safety_requires_as_written`; `POST /api/pair` error table (own_code, already_paired, partner_unavailable, code_expired, rate_limited, age_required); invite redirects use `/pair?code=` and route by state including not-yet-onboarded; after undo the composer restores the text and keeps the token until it expires; tests for sender-cursor no-skip, safety send rejection, pair error codes and the undo-window setting.
- CEO voice (auto-accepted, in blast radius): free limit counts 5 sent translated messages (slot reserved atomically at send) plus a 15-preview cap reserved at preview and released on AI failure; unpaired users can preview with neutral traits; coaching `landing` names the partner trait it relies on; events add invite_copied, invite_opened and upgrade_clicked{feature}; `npm run report:events` reports weekly active couples where both partners sent a message; plan has a build order with a cut line after step 3 and an alternatives-considered section; tests for 5-of-20 parallel sends, 15-of-30 parallel previews, preview release on failure and unpaired preview.
- Outside voice (auto-accepted): undo of a free translated send returns its slot in the same transaction; `preview_nonces` table dropped (unique `messages.preview_nonce` is the guard, 409 `already_sent`); `couple_members` with a partial unique index on active `user_id` and `FOR UPDATE` row locks in id order; race tests also run in CI against Postgres 16 via `TEST_DATABASE_URL`; dev-only `/api/dev/plan` and `/api/dev/report` instead of separate processes, PGlite in `serverExternalPackages`; `npm run build` runs migrations; `visible_at` with a 2 s minimum ships in build step 2; text 1-4000 chars and 60 AI calls per user per hour (429 `ai_rate_limited`); defined unpair semantics, `DELETE /api/me`, `age_blocked`, `ensureUser` ON CONFLICT; coaching `landing` says general advice when traits are not shared; tests for slot return on undo, 16th-preview 402, concurrent pairing, rate limit, account deletion and age-block retry.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->
- Fake coach is dev-only: `COACH=fake|anthropic`; production without `ANTHROPIC_API_KEY` fails the startup env check; dev logs `coach=fake`; `ANTHROPIC_MODEL` override; 20 s AI timeout; test that the fake is refused in production.
- RFC 9457 problem+json errors via one `apiError()` in `packages/core/errors.ts` with `type, title, status, code, detail, retryable, request_id` and optional `retry_after, fields, limit`; `invalid_input` with `fields`; 500 `internal` returns only `request_id`; no secrets or message text in bodies or logs; `docs/ERRORS.md` anchor per code with a test that walks the codes.
- 429 `rate_limited` and `ai_rate_limited` send `Retry-After` and `retry_after`; test.
- 503 `translate_failed` is `retryable: true`, states nothing was charged or stored; client retries at most twice, then offers as-written.
- 402 split into `free_translations_used_up` and `free_previews_used_up` with `limit` and `used`; tests for each.
- `DELETE /api/me`: database transaction first, then Clerk; both idempotent; Clerk failure returns 502 `account_delete_incomplete` (`retryable: true`) and a retry completes; test.
- Age gate codes: `age_blocked` (no self-serve fix, client signs out) vs `age_required` (POST birthdate).
- One zod `env.ts` loaded from `instrumentation.ts`: names each bad variable and its fix, never values; production requires `PREVIEW_TOKEN_SECRET` and `ANTHROPIC_API_KEY`; `UNDO_WINDOW_SECONDS` integer >= 2; `DEV_AUTH=1` refused in production; tests.
- Migrations: `npm run build` is only `next build`; separate `npm run db:migrate`; production deploy runs `db:migrate && build`; failed migration recovery documented. (Supersedes the CEO outside-voice "build runs migrations".)
- PGlite `./.data/.lock` pid lockfile with a clear second-opener error; `npm run db:reset` in Node.
- Routes under `/api/v1`; zod schemas in `packages/core` are the contract; breaking change means `/api/v2`.
- Dev login: `DEV_AUTH=1` (non-production) makes `getUserId` read a `dev_user` cookie; `/dev/login?as=alice|bob`; `npm run seed` creates paired adult onboarded alice and bob (bob paid); `.env.example` ships `DEV_AUTH=1`; `/dev/*` 404 in production; test.
- Opaque base64url cursor returned as `next_cursor`; bad cursor 400 `invalid_cursor`; test.
- Race tests `it.skipIf(!TEST_DATABASE_URL)` with a visible reason; single-request logic tests always run on PGlite.
- `npm run report:events` and `npm run dev:plan -- <email> free|paid` call the dev routes and exit 1 with "Start `npm run dev` first" when the server is down.
- Docs: `README.md` 4-step no-account quickstart under 5 minutes, Node pinned in `engines` and `.nvmrc`, scripts list, real-key switch, deploy steps; `docs/ERRORS.md`; `docs/API.md` with one curl per route. Build step 1 includes env check, `apiError()`, dev login, seed and README.
- Done means: clean checkout runs with no accounts; README quickstart reaches alice and bob chatting in under 5 minutes; the Clerk sign-up manual run uses `npm run dev:plan` for the paid user.
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- AI cap: 120 calls per user per hour (supersedes 60), reserved atomically on `users.ai_window_start`/`ai_calls_in_window` before the call; failed calls count; `Retry-After` from the window; 150-parallel CI test reserves exactly 120.
- `messages.charged_free_slot` set at insert; undo and unpair refund only when true; CHECK 0..5 and 0..15 on the counters; tests for paid-to-free undo and unpair refund.
- Anthropic client `timeout: 20_000`, `maxRetries: 0`; AI routes `maxDuration = 30`; hang test releases the reservation.
- `visible_at` uses `clock_timestamp()` on the send transaction's last statement with `SET LOCAL lock_timeout = '1s'` (503 `busy`, retryable); undo requires `clock_timestamp() < visible_at - 1s`; CI Postgres lock test.
- `preseed` runs migrations; PGlite client opens lazily; stale `.lock` with a dead pid is removed; live lock says "stop pid N" (no reset advice); tests.
- `GET /api/couples`; `GET /api/messages?couple_id=` defaults to the active couple, past couples read-only, 404 `not_paired`; per-couple cursor; tests.
- Production `DATABASE_URL` is a transaction-mode pooler with `prepare: false`, `max: 1`; default host Vercel + Neon pooled; `events(user_id, name, created_at)` index.
- Mutating routes require `application/json` (415); `/api/dev/*` and `/dev/*` need `DEV_AUTH=1` and non-production; tests.
- Foreign keys `ON DELETE CASCADE` from users; `DELETE /api/me` deletes the users row; `email` not unique; `pair_code` unique; test.
- `GET /api/pair/code` rotates atomically; `POST /api/pair` inserts the attempt before counting and returns 403 `questionnaire_required` until both questionnaires exist; tests.
- Preview token checked with `timingSafeEqual`; token binds the sender, not the couple (documented); parallel-send test mints tokens with the test secret.
- With `DEV_AUTH=1` and empty Clerk keys, middleware skips `clerkMiddleware` and the layout omits `ClerkProvider`; boot smoke test.
- `ensureUser` takes email from a Clerk session-token claim and refreshes it when it changes.
- `npm run admin:report` and `npm run admin:plan -- <email> free|paid` run against production `DATABASE_URL`, refuse an empty URL and print the target host; test.
- Unpaired users can use only 3 of the 15 free previews (402 `free_previews_used_up`, `limit: 3`); test.
- `env.ts` validates only from `register()`, skipped during `next build`; `next build` with no production env succeeds.
- `hasPaidAccess(user, couple)` in `packages/core` is the only paid check (M1: `user.plan === 'paid'`); grep test.
- Tests migrate one PGlite per file and roll back a transaction per test.
- `/pair` carries the code only in `redirect_url` (no sessionStorage), surviving email verification in a new tab.
- Supersedes in the CEO block: `preview_nonces` table (dropped), "build runs migrations" (now `db:migrate`), 60 AI calls per hour (now 120), sessionStorage for invites (now `redirect_url`).
- Alternatives considered lists "one Postgres everywhere" as TASTE d7.
<!-- /autoplan-accepted:eng -->
## Review record

### CEO review (autoplan, SELECTIVE EXPANSION), Step 0

**Pre-review audit**
- `v2/` is a new git repo with no commits. Its only files are `docs/PLAN.md` and `docs/designs/introverted-love-v2.md`.
- The reference app `../app/` has 3 audit rounds of fixes and 23 offline tests in `app/backend/tests/test_audit_fixes.py` (lines 47-396). There is no TODOS.md and no CLAUDE.md.
- **Taste references to follow:**
  - `app/backend/tests/test_audit_fixes.py` (focused race and invariant tests)
  - `app/backend/routes/messages.py` `reserve_daily_slot` (an atomic conditional update)
- **To avoid:** v1's copied 46-file UI kit (deleted in audit #13) and `emergentintegrations`, a proxy lock-in (`app/backend/services/ai_service.py:1`).

**Landscape:** carried from office hours (search done this session).
- **Layer 1:** AI couples coaches are crowded: Maia, Arya, LovOn, CoupleWork.
- **Layer 2:** Couples apps churn when only one partner engages (Couply), and recipients penalize AI-polished messages (Ohio State 2023).
- **Layer 3:** the founder chose auto-translate for free users plus coaching for paid. The differentiation is the *fight* case: in-the-moment de-escalation (breath step, undo window), not a therapist chatbot.

**0A. Premise challenge**
- **The real problem:** couples wound each other through silence or impulsive anger.
- **Target outcome:** the first real anxious-partner message delivered softly.
- **Do-nothing cost:** v1 stays on Emergent with exposed keys and unproven demand.
- **Directness:** the plan solves the pain directly (translation and coaching in the send path), not a proxy.
- **Premise held for the final gate (not a User Challenge):** no demand evidence exists ([measured: design doc §Demand Evidence]). Proceeding is the founder's explicit call, and the Assignment is the mitigation.

| premise | claim | receipt | verdict |
|---|---|---|---|
| v1 races were MongoDB check-then-write | most audit bugs were check-then-write | app/backend/routes/messages.py `reserve_daily_slot`; tests 87, 291, 308 | pass |
| v1 is locked to an Emergent proxy | the AI goes through emergentintegrations | app/backend/services/ai_service.py:1, :13 | pass |
| the questionnaire has 18 questions | 18 `"id": "q` entries | app/backend/routes/questionnaire.py (grep count 18) | pass |
| Next.js, Clerk, Drizzle, PGlite and the Anthropic SDK are current | latest versions are next 16.4.6, @clerk/nextjs 7.10.1, drizzle-orm 0.45.4, @electric-sql/pglite 0.5.16, @anthropic-ai/sdk 1.9.0 | `npm view` this session | pass [measured: npm registry] |
| npm workspaces need no install | Node 26.13.1 / npm 11.20.0 | `node -v`, `npm -v` | pass |
| demand exists | none | design doc §Demand Evidence | unverified (accepted risk) |

unverified=1

**0B. Existing code leverage (rebuild justified)**

| Sub-problem | v1 code | v2 reuse |
|---|---|---|
| Questionnaire content | app/backend/routes/questionnaire.py QUESTIONS (18) | port the data verbatim |
| Answer validation | questionnaire.py `validate_answers` | port as a zod schema |
| Translate prompt | app/backend/services/ai_service.py `build_system_prompt` and `parse_translation` | port the prompt, use structured output |
| Atomic free slots | messages.py `reserve_daily_slot` | the same conditional `UPDATE` in SQL |
| Age gate | auth.py `is_adult` and AuthPage DobSelect | port the logic and UI |
| Pair codes | auth.py `generate_code` (secrets, 10 chars) | port with an unambiguous alphabet and expiry |
| Design tokens | app/design_guidelines.json | port to Tailwind theme |
| Invariant tests | test_audit_fixes.py | re-express as Vitest cases |

Refactoring v1 instead loses: deprecated Create React App, MongoDB (no transactions or constraints), the Emergent proxy and two runtimes. Each was the root cause of audit findings, which is why it's a rebuild.

**Reality rows**
- REALITY: premise-table pass 5 verified, 1 unverified (demand) app/backend/services/ai_service.py:13
- REALITY: already-done pass v2 has no commits; nothing on the base branch implements this docs/PLAN.md:1
- REALITY: surface-check finding `npm run report:events`, `npm run dev` and `npm test` don't exist yet; they're plan deliverables, verified at build docs/PLAN.md:95
- REALITY: binding-decisions pass no prior decisions on this branch (gstack-decision-search empty); founder decisions D8, D11, D12 and D13 are bound in the design doc docs/designs/introverted-love-v2.md:1
- REALITY: numbers pass free limit 5 [measured: founder D13], undo window 10 s [estimated], polling 5 s / 30 s [estimated], code 10 characters, 31 symbols, about 49 bits [measured: 31^10 = 8.2e14] docs/PLAN.md:52
- REALITY: deferred-asks pass no linked issue docs/PLAN.md:1
- REALITY: pr-count pass no ship-policy, so one PR per wave (M1 = one wave) docs/PLAN.md:1

**0C. Dream state**
```
  CURRENT STATE                    THIS PLAN (M1 + E1-E4)               12-MONTH IDEAL
  v1 on Emergent proxy,      --->  One TS repo, API-first, Postgres, ---> Web + iOS/Android (Expo) on the
  Mongo races fixed by hand,       translate/coach composer, undo,       same API; Stripe live; proven
  exposed keys, 0 real users       events for the first 3 users          retention: couples who use it
                                                                          during real fights, weekly
```

**0E. Mode:** SELECTIVE EXPANSION (fixed by the autoplan override).

**0G. HOLD checks**
- **Complexity:** about 35 planned files [estimated], more than 8. Challenge: could fewer moving parts work? The minimum is already a monorepo with 2 packages. `packages/core` exists only because mobile is a stated constraint (D8), so it stays (P1).
- **Deferrable without blocking M1:** all of M2 is already deferred.
- **Invariants kept:** all 7 M1 tested criteria.

**Delight scan and cherry-picks**

| ID | Proposal | Effort | Risk | Decision | Principle |
|---|---|---|---|---|---|
| E1 | 10 s undo window after send | S | Low | ACCEPTED | P2, in the send-path radius and under 1 day |
| E2 | Invite link `/pair?code=` | S | Low | ACCEPTED | P2, lowers two-sided friction (accepted risk, premise 3) |
| E3 | Drafts tray for "Save for later" | S | Low | ACCEPTED | P1, completes the breath-step flow |
| E4 | Product events (no message text) | S | Low | ACCEPTED | P1, the Assignment needs evidence (Prime Directive 5) |
| E5 | Recipient "ask for the original" request | M | Med | DEFERRED (TASTE) | P3, a new social mechanic outside M1 |
| E6 | Installable PWA manifest | S | Low | DEFERRED | P3, mostly matters for M2 iOS push |
| E7 | Multi-language translation | L | Med | SKIPPED | P3, no evidence of need |

**0I. Temporal interrogation**
- **Hour 1:** workspace and Next 16 setup, Drizzle with PGlite, Clerk middleware for both cookie and bearer auth.
- **Hours 2-3:**
  - the serializer rules (original visibility, the undo window)
  - the preview token HMAC
  - the atomic free slot
- **Hours 4-5:**
  - Clerk development keys are needed for any manual run, so tests must not need Clerk; auth is stubbed at the handler boundary
  - PGlite in Vitest per test
- **Hour 6+:** safety fixtures, the polling hook, the breath-step UX.
- **Effort:** human team about 2-3 weeks; CC with gstack about 3-4 hours.
- **Feasibility blocker:** none, but a manual end-to-end run needs the founder's Clerk development keys (rotated).

<!-- autoplan-accepted:ceo -->
- E1 Undo window: messages carry DB-set `visible_at = now() + 10s`; recipient serializer and `(visible_at, id)` cursor hide them until visible; sender `DELETE /api/messages/:id` within the window hard-deletes and frees the preview nonce, 409 after, 404 for non-senders; sender sees "Sending · Undo" then "Delivered"; tests for hidden-then-visible, no cursor skip, undo-delete and re-send, 409, 404.
- E2 Invite link: `/pair?code=` page carries the code through sign-up (sessionStorage + `redirect_url`) into the onboarding partner step; "Copy invite link" in onboarding and settings; codes last 7 days, are single-use (rotated on pair) and rate-limited; already-paired and expired/used messages; tests for link-code pairing, used/expired and already-paired refusals.
- E3 Drafts tray: `apps/web/lib/drafts.ts` stores Save-for-later drafts only in localStorage under `il:drafts:<userId>` with save, restore and delete, shown as a composer "Drafts (n)" tray; never sent to the server; unit tests with a storage stub for per-user isolation and the three operations.
- E4 Product events: `events(id, user_id, couple_id?, name enum, props jsonb, created_at)` records message_sent{mode,heated,translated}, message_undone, breath_step{choice} via `POST /api/events`, coach_used, original_shared, paired, translation_failed{reason enum timeout|api_error|invalid_output}; never message text; `npm run report:events`; tests for written rows, rejection of unknown names/props and no text fields.
- Preview token hardening (from CEO spec review): HMAC covers user, text hash, delivered_text, change_summary, heated, safety, nonce, exp; server reads heated/safety from the token; one send per nonce (`preview_nonces`), linked through `messages.preview_nonce` and freed on undo; preview returns `safety`; tests for replay rejection and token-derived flags.
- Spec review round 2 (mechanical): message modes are `translated` and `as_written` only (coaching is advisory); `GET /api/me` is exempt from the age gate and reports `birthdate_set`; free-preview counting from round 2 is superseded by the CEO-voice rule below; paid users may still send as written; `/pair` handles signed-in unpaired (confirm button), sign-in as well as sign-up redirects, and own-code; the serializer returns `visible_at` and `server_now`; `UNDO_WINDOW_SECONDS` (default 10) and tests set `visible_at` directly; `getUserId()` auth seam mocked in tests; `PREVIEW_TOKEN_SECRET` dev default refused in production; tests for each.
- Spec review round 3 (mechanical, applied at the review cap): `predev` and test setup run migrations; PGlite client is a `globalThis` singleton in dev; `visible_at` is set by insert SQL with `make_interval(secs => UNDO_WINDOW_SECONDS)`; messages response is `{messages, pending, server_now}` and the cursor advances only over visible rows; safety tokens carry `delivered_text = null` and `mode=translated` with one returns 422 `safety_requires_as_written`; `POST /api/pair` error table (own_code, already_paired, partner_unavailable, code_expired, rate_limited, age_required); invite redirects use `/pair?code=` and route by state including not-yet-onboarded; after undo the composer restores the text and keeps the token until it expires; tests for sender-cursor no-skip, safety send rejection, pair error codes and the undo-window setting.
- CEO voice (auto-accepted, in blast radius): free limit counts 5 sent translated messages (slot reserved atomically at send) plus a 15-preview cap reserved at preview and released on AI failure; unpaired users can preview with neutral traits; coaching `landing` names the partner trait it relies on; events add invite_copied, invite_opened and upgrade_clicked{feature}; `npm run report:events` reports weekly active couples where both partners sent a message; plan has a build order with a cut line after step 3 and an alternatives-considered section; tests for 5-of-20 parallel sends, 15-of-30 parallel previews, preview release on failure and unpaired preview.
- Outside voice (auto-accepted): undo of a free translated send returns its slot in the same transaction; `preview_nonces` table dropped (unique `messages.preview_nonce` is the guard, 409 `already_sent`); `couple_members` with a partial unique index on active `user_id` and `FOR UPDATE` row locks in id order; race tests also run in CI against Postgres 16 via `TEST_DATABASE_URL`; dev-only `/api/dev/plan` and `/api/dev/report` instead of separate processes, PGlite in `serverExternalPackages`; `npm run build` runs migrations; `visible_at` with a 2 s minimum ships in build step 2; text 1-4000 chars and 60 AI calls per user per hour (429 `ai_rate_limited`); defined unpair semantics, `DELETE /api/me`, `age_blocked`, `ensureUser` ON CONFLICT; coaching `landing` says general advice when traits are not shared; tests for slot return on undo, 16th-preview 402, concurrent pairing, rate limit, account deletion and age-block retry.
<!-- /autoplan-accepted:ceo -->






### CEO review: dual voices
Claude CEO voice: completed in-host, INPUT `ceo fbf7eafa…` matches the snapshot. Codex: not installed (CODEX_MODE: not_installed), so outside coverage is unavailable. [single-model]

```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Premises valid?                   no*     N/A    N/A
  2. Right problem to solve?           partly  N/A    N/A
  3. Scope calibration correct?        no      N/A    N/A
  4. Alternatives sufficiently explored? no    N/A    N/A
  5. Competitive/market risks covered? no      N/A    N/A
  6. 6-month trajectory sound?         risky   N/A    N/A
  * The Claude voice challenges the in-app chat container (finding 1) and two-sided cold start (finding 2).
```

**How the CEO voice's findings were handled:**

| # | Finding (severity) | Disposition |
|---|---|---|
| 1 | Composer plus share sheet instead of an in-app chat (CRITICAL) | **Single-voice critical.** It conflicts with the founder's settled premise 3, so it's queued for the final gate as TASTE `d2`. The plan keeps the in-app chat. |
| 2 | Two-sided cold start with no single-player value (CRITICAL) | Partly accepted (P1): unpaired users can preview, invite funnel events, the success metric. The deeper reframe goes with `d2`. |
| 3 | Recipients paywalled from real words; label translations (HIGH) | TASTE `d3`. Free shared originals conflict with the founder's decisions D12 and D13, and the label is a product call. |
| 4 | Free tier spends its preview slots on edits and drops safety (HIGH) | Slot-per-send accepted (it matches the founder's "first 5 messages"). The safety/heated check on as-written sends is TASTE `d1`. |
| 5 | M1 can't test willingness to pay (HIGH) | `upgrade_clicked` fake door accepted. Stripe in M1 is TASTE `d4`. |
| 6 | No notifications in M1 (HIGH) | TASTE `d5` (web push or email in M1). |
| 7 | Scope creep, no timeline (MED) | Build order and cut line accepted (P5). |
| 8 | OS-level rewriters commoditize rewriting (MED) | Accepted: coaching names the partner's trait (the moat). |
| 9 | Alternatives not weighed (MED) | Accepted: an alternatives section was added. |

### CEO review: Sections 1-10 (implementation-ready depth)

**Current scope:**
- **Mode:** SELECTIVE EXPANSION (the autoplan override).
- **Accepted:** E1-E4, spec-review hardening rounds 1-3 and the CEO-voice items above.
- **Deferred:** E5, E6.
- **Skipped:** E7.
- **Pending for the final gate:** TASTE `d1`-`d5`.

**Section 1: Architecture Review**
```
 Browser (Next.js pages)  --fetch JSON-->  apps/web /api/* route handlers
   /onboarding /pair /chat /settings          |  getUserId(req) -- Clerk auth() (cookie | bearer)
   drafts.ts (localStorage)                   v
                                     packages/core
                                       +- db/ (Drizzle schema, migrations, client singleton)
                                       |     PGlite (dev/test)  |  postgres-js (prod)
                                       +- messages.ts (preview, send, undo, serializer, cursor)
                                       +- pairing.ts, questionnaire.ts, events.ts, tokens.ts (HMAC)
                                       +- ai/ Coach interface -- AnthropicCoach | FakeCoach
 Future: apps/mobile (Expo) --bearer--> same /api/*
```
- **Coupling:** all domain rules live in `packages/core`. Handlers only parse, authorize and serialize. That coupling is justified by the mobile constraint.
- **Data flows:** the four paths for preview and send are in Section 4.
- **State machine:** a message goes from *pending* (before `visible_at`) to either *visible* or *deleted* (undo inside the window). Deleting after `visible_at` is impossible: 409, enforced by `WHERE now() < visible_at`.
- **Scaling at 10x:** polling every 5 s per open chat is 0.2 requests per second per user. At 1,000 concurrent chats that's 200 requests per second against an indexed `(couple_id, visible_at, id)` query, which is fine. At 100x, polling is the first thing to break, which is why M2 adds push-based updates.
- **Single points of failure:** Postgres; the Anthropic API (degrades to send-as-written); Clerk (sign-in only).
- **Security boundaries:** see Section 3.
- **Rollback:** Vercel instant rollback to the previous deploy. Migrations are additive only in M1.

Findings:
- **OK:** the architecture fits the API-first and mobile constraints.
- **WARNING:** PGlite isn't a production database. Production needs `DATABASE_URL`, and a missing value in production must fail at startup. Auto-accepted as part of the existing secrets rule.

**Section 2: Error & Rescue Map**
```
  METHOD/CODEPATH          | WHAT CAN GO WRONG            | CLASS
  -------------------------|------------------------------|---------------------------
  Coach.translate/coach    | API timeout                  | AiTimeout
                           | 429 / 5xx                    | AiApiError
                           | malformed / schema-invalid   | AiInvalidOutput
                           | refusal                      | AiInvalidOutput(refusal)
  tokens.verify            | bad HMAC / expired           | TokenInvalid / TokenExpired
  sendMessage              | nonce already used           | UniqueViolation(preview_nonces)
                           | free slot race lost          | FreeLimitReached
  POST /api/pair           | code expired/own/paired/rate | PairError(code)
  db client                | PGlite lock / DB down        | DbUnavailable
  getUserId                | no/invalid session           | Unauthenticated

  CLASS              | RESCUED? | RESCUE ACTION                          | USER SEES
  -------------------|----------|----------------------------------------|---------------------------
  AiTimeout          | Y        | release preview reservation, 503       | "Couldn't soften this right now" + Retry / Send as written
  AiApiError         | Y        | same, event translation_failed{api_error} | same
  AiInvalidOutput    | Y        | same, reason invalid_output            | same
  TokenInvalid/Exp   | Y        | 400 / 410, client re-previews          | "Preview expired, preview again"
  UniqueViolation    | Y        | 409 already_sent                       | message already sent (no duplicate)
  FreeLimitReached   | Y        | 402 free_translations_used_up          | upgrade prompt + send as written
  PairError          | Y        | mapped status (error table)            | page message per code
  DbUnavailable      | N <- GAP | (none)                                 | generic 500
  Unauthenticated    | Y        | 401                                    | redirect to /sign-in
```
**GAP, auto-accepted (P1):** a database failure returns 503 `service_unavailable` with a structured log (`route`, `userId`, `err.code`). The client shows "Something went wrong. Your draft is saved," and the draft stays in the composer.

**Section 3: Security & Threat Model**

| Threat | Likelihood | Impact | Mitigated? |
|---|---|---|---|
| IDOR: reading another couple's messages | Med | High | Yes. Every query is scoped by the caller's active `couple_id` from `getUserId`, never by a client id. Tested by the serializer tests. |
| Forged or replayed preview | Med | Med | Yes. HMAC, nonce and expiry. |
| Brute-forcing pair codes | Low | High | Yes. About 49 bits, 10 attempts per hour, single use. |
| Prompt injection via message text | High | Low-Med | Partly. The text is passed as user content and the output is schema-validated. **Auto-accepted:** the system prompt treats the draft as data, and the schema rejects extra fields. |
| XSS via message text | Med | High | Yes. React escapes text, and no HTML rendering. |
| Under-18 sign-up | Med | High | Self-declared gate (known limit, from v1 audit). |
| Secret leaks | Low | High | `.env*` gitignored, dev default refused in production. |
| Event props leaking text | Low | Med | Zod schemas per event name, tested. |

No audit-log gap for M1: the `events` table covers sensitive actions (pair, share-original).

**Section 4: Data Flow & Interaction Edge Cases**
```
 text -> VALIDATE (1..4000 chars) -> PREVIEW (reserve preview, Coach) -> TOKEN -> SEND (verify, nonce, slot) -> INSERT -> SERIALIZE
   | nil/empty -> 400        | too long -> 400          | AI fail -> release, 503   | replay -> 409   | race -> 402
```
- **Async ordering, the invariant:** at most 5 translated sends per free user.
- **Two parallel sends A and B:** each runs a conditional `UPDATE ... < 5`. Postgres row locks serialize them, so the loser sees the updated count and 0 rows change, which returns 402. Proven by the 20-parallel test.
- **Preview cap:** the same mechanism.

| Interaction | Edge case | Handled? | How |
|---|---|---|---|
| Send | Double click | Yes | One nonce per token, and the button is disabled while sending |
| Send | Network timeout and retry | Yes | A retried send with the same token gets 409 `already_sent`. The client treats that as success and refetches. |
| Preview | User navigates away | Yes | The draft is in the composer; save to drafts is offered |
| Chat | 0 messages | Yes | An empty state: "Say the first thing. It'll arrive gently." |
| Chat | Thousands of messages | Partly | The cursor pages 50 at a time. **Auto-accepted:** "load earlier" pagination using a reverse cursor. |
| Undo | Click at 9.9 s | Yes | The database decides. A 409 shows "Already delivered". |

**Section 5: Code Quality Review**
- **Structure:** clean module boundaries in `packages/core`.
- **Risk:** the `messages.ts` send path branches on mode, plan, token, safety and limits, more than 5 branches. **Auto-accepted:** split it into `preview()`, `sendTranslated()` and `sendAsWritten()`, with a shared `assertCanSend()`.
- **Over-engineering:** none flagged beyond E1, whose cost the CEO voice questioned. It's kept because the founder's fight case motivates it, and it sits after the cut line.

**Section 6: Test Review**
```
 NEW THING                    | TYPE         | HAPPY | FAILURE                  | EDGE
 preview/translate            | integration  | yes   | AI fail -> release       | unpaired neutral traits
 send translated              | integration  | yes   | replay/tamper/safety 422 | 20 parallel -> 5
 send as_written              | integration  | yes   | (none)                   | free past 5
 undo (E1)                    | integration  | yes   | 409 / 404                | cursor no-skip (both sides)
 pairing + link (E2)          | integration  | yes   | each error code          | own code, partner unavailable
 questionnaire                | integration  | yes   | 400 invalid              | share_traits=false defaults
 age gate                     | integration  | yes   | 403 under 18             | /api/me exempt
 drafts (E3)                  | unit         | yes   | (none)                   | per-user isolation
 events (E4)                  | integration  | yes   | unknown name 400         | no text fields
 coach                        | integration  | yes   | free 403                 | safety -> no swaps
 DB unavailable (S2 gap)      | integration  | (n/a) | 503 + draft kept         | (none)
```
- **The 2am Friday test:** the serializer suite. A recipient never receives an unshared original or an unexpired pending message.
- **Hostile QA:** a replayed token, parallel sends and a forged `couple_id`.
- **Chaos:** the AI timing out on every call; the user can still send as written.
- **Flakiness:** none. There's no sleeping, time is set directly, and the fake coach is deterministic.
- **Prompt fixtures:** safety and heated fixtures run in CI with the fake coach. A live eval script (`npm run eval:coach`) covers about 20 real drafts against the Anthropic model and is run manually before release.

**Section 7: Performance Review**
- **No N+1 queries:** the messages list is one indexed query.
- **Slowest paths:** preview (AI, about 2-4 s, p99 about 8 s with a 10 s timeout), send (2 queries), messages poll (1 query).
- **Indexes:** `messages(couple_id, visible_at, id)`, a unique `users.pair_code`, `events(user_id, created_at)`, and partial unique indexes on couples.
- **Connection pool:** the postgres-js pool is capped at 10 in production.
- **Finding, auto-accepted:** a 10 s timeout on AI calls.

**Section 8: Observability & Debuggability**
- **Logs:** structured JSON for every handler: `route`, `userId`, `coupleId`, `status`, `ms`, and the error class. Never message text.
- **Metrics:** the `events` table plus `report:events`. That covers weekly active couples, translation failure rate and the breath-step choice split.
- **Alerts:** M1 has none. **Auto-accepted:** the translation failure rate is printed by `report:events`, with a runbook line: if it's above 10%, check the Anthropic status page and the key.
- **Debuggability:** can a bug reported 3 weeks later be reconstructed? Partly. Events and logs exist, but message text is never logged by design.

**Section 9: Deployment & Rollout**
- **Migrations:** additive only, so there are no locks at M1 scale.
- **Feature flags:** none needed. `plan` gates paid features.
- **Order:** migrate, then deploy.
- **Rollback:** Vercel promotes the previous deploy. Migrations are backward-compatible.
- **Smoke test after deploy:** `GET /api/me` returns 401 without auth, and the landing page renders.
- **Finding:** there's no staging environment in M1. Accepted, because M1 is for 3 testers.

**Section 10: Long-Term Trajectory**
- **Debt:** M1 polling and the M1 admin script for `plan` are intended stopgaps.
- **Reversibility:** 4/5. The schema is additive, and `Coach` can swap the model or provider.
- **Path dependency:** the API-first and core-package choices make Expo cheap.
- **The 1-year question:** a new engineer should find it obvious, given `packages/core` and the tests.
- **Retrospective:** the cherry-picks were right. E4 is load-bearing for the Assignment. E1 is the most questionable, so it sits after the cut line.

**Section 11: Design & UX:** SKIPPED (no UI scope, according to the scope tool). The composer wireframe was approved in office hours.

### CEO review: required outputs

**NOT in scope**
- **Deferred:**
  - E5, letting the recipient ask for the original: wait for demand evidence.
  - E6, the PWA manifest: goes with M2 push.
- **Skipped:** E7, multi-language: no evidence.
- **M2:** Stripe, realtime and push, streaks, the diary, the report. Moving any of these into M1 is a final-gate decision (`d4`, `d5`).

**What already exists:** see the Step 0B table. The questionnaire data, the validation, the translate prompt, the atomic slot pattern, the age gate, pair codes, the design tokens and the invariant tests are all ported from `../app`.

**Dream state delta:** M1 delivers the composer core and evidence capture. Not yet there: mobile apps, billing that renews, realtime, and retention evidence.

**Failure Modes Registry**
```
  CODEPATH        | FAILURE MODE        | RESCUED? | TEST? | USER SEES?                 | LOGGED?
  preview         | AI timeout/invalid  | Y        | Y     | retry / send as written    | Y (event+log)
  send translated | replay              | Y        | Y     | no duplicate               | Y
  send translated | free race           | Y        | Y     | 402 upgrade                | Y
  send translated | safety token        | Y        | Y     | 422 -> send as written     | Y
  undo            | after window        | Y        | Y     | "Already delivered"        | Y
  messages poll   | cursor skip         | Y        | Y     | (prevented)                | n/a
  pair            | any error code      | Y        | Y     | mapped message             | Y
  any handler     | DB unavailable      | Y (S2)   | Y     | "Draft saved, try again"   | Y
```
CRITICAL GAPS: 0 (the database-unavailable gap was auto-accepted with a rescue and a test).

**Implementation tasks:** these come from the eng phase. CEO findings that change the build:
- **T-CEO-1 (P1):** a 503 rescue for database-unavailable, keeping the draft (Section 2).
- **T-CEO-2 (P1):** split the send path (Section 5).
- **T-CEO-3 (P2):** "load earlier" pagination (Section 4).
- **T-CEO-4 (P1):** a 10 s AI timeout (Section 7).
- **T-CEO-5 (P1):** treat the draft as data in the prompt, and reject extra schema fields (Section 3).
- **T-CEO-6 (P2):** a translation-failure line in `report:events` (Section 8).

**Completion summary**
```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | empty v2 repo; v1 reference w/ 23 tests     |
  | Step 0               | E1-E4 accepted, E5-E6 deferred, E7 skipped  |
  | Section 1  (Arch)    | 1 issue found                               |
  | Section 2  (Errors)  | 10 error paths mapped, 1 GAP (accepted fix) |
  | Section 3  (Security)| 8 threats, 0 High unmitigated               |
  | Section 4  (Data/UX) | 6 edge cases mapped, 1 unhandled (accepted) |
  | Section 5  (Quality) | 1 issue found                               |
  | Section 6  (Tests)   | Diagram produced, 1 gap (S2, accepted)      |
  | Section 7  (Perf)    | 1 issue found                               |
  | Section 8  (Observ)  | 1 gap found                                 |
  | Section 9  (Deploy)  | 1 risk flagged (no staging, accepted)       |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 2           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (3 items + M2)                       |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 10 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 8 total, 0 CRITICAL GAPS                    |
  | TODOS.md updates     | 2 items (E5, E6)                            |
  | Scope proposals      | 7 proposed, 4 accepted                      |
  | CEO plan             | written (~/.gstack/.../ceo-plans/)          |
  | Outside voice        | codex: unavailable (not installed)          |
  | Lake Score           | N/A (no scored user questions)              |
  | Diagrams produced    | 5 (architecture, error, data flow, test, state) |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 5 TASTE (d1-d5) for the final gate          |
  | Reality rows         | 7/7 rows, 1 unverified (demand)             |
  +====================================================================+
```

<!-- AUTONOMOUS DECISION LOG -->
### Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Mode SELECTIVE EXPANSION | Mechanical | override | autoplan fixed mode | other modes |
| 2 | CEO | Accept E1 undo window | Mechanical | P2 | send-path radius, <1d | skip |
| 3 | CEO | Accept E2 invite link | Mechanical | P2 | lowers two-sided friction | skip |
| 4 | CEO | Accept E3 drafts tray | Mechanical | P1 | completes Save for later | skip |
| 5 | CEO | Accept E4 events | Mechanical | P1 | Assignment needs evidence | skip |
| 6 | CEO | Defer E5 ask-for-original | Taste | P3 | new mechanic, no evidence | include |
| 7 | CEO | Defer E6 PWA manifest | Mechanical | P3 | belongs with M2 push | include |
| 8 | CEO | Skip E7 multi-language | Mechanical | P3 | no evidence | include |
| 9 | CEO | Apply 12 spec-review round-1 fixes | Mechanical | P1 | gaps in accepted scope | leave |
| 10 | CEO | Apply 9 spec-review round-2 fixes | Mechanical | P1/P5 | same | leave |
| 11 | CEO | as_written skips AI detection (known gap) | Taste (d1) | P3 | zero free-tier AI cost | classify all sends |
| 12 | CEO | Apply 8 spec-review round-3 fixes at cap | Mechanical | P1 | same | leave |
| 13 | CEO | Approve CEO scope docs (0H) | Mechanical | admin | autoplan admin auto-decide | revise |
| 14 | CEO | Slot per sent message + 15-preview cap | Mechanical | P1 | matches founder's "first 5 messages" | per preview |
| 15 | CEO | Unpaired preview, funnel events, success metric | Mechanical | P1 | cold-start mitigation in radius | none |
| 16 | CEO | Keep in-app chat; queue share-sheet reframe | Taste (d2) | P6 | founder rejected premise 3 | reframe now |
| 17 | CEO | Queue free originals/labeling | Taste (d3) | P6 | founder decided D12/D13 | change now |
| 18 | CEO | Queue Stripe in M1 | Taste (d4) | P3 | M2 per spec review | M1 Stripe |
| 19 | CEO | Queue notifications in M1 | Taste (d5) | P3 | M2 per spec review | M1 push |
| 20 | CEO | Build order + cut line, alternatives section | Mechanical | P5 | clarity | none |
| 21 | CEO | DB-unavailable 503 rescue, AI timeout, prompt-as-data, send-path split, pagination | Mechanical | P1/P5 | section findings | leave |
| 22 | CEO | Apply 14 outside-voice fixes (slot return on undo, drop preview_nonces, couple_members, CI Postgres race tests, dev-only routes, build-time migrations, 2 s minimum window, text/AI limits, unpair + account deletion, age_blocked, ensureUser upsert, landing without consent) | Mechanical | P1/P5 | bugs and gaps in accepted scope | leave |
| 23 | CEO | Queue the "cut M1 to bare essentials" proposal | Taste (d6) | P1 vs P3 | reverses accepted E1/E4 and the hardening | cut now |

### CEO review: outside voice
Running the outside voice automatically (standard step). Disable: `gstack-config set codex_reviews disabled`.
- **Provider:** Codex not installed, so this ran as the native fallback: a Plan agent, read-only, with a 5-minute timer. It finished inside the window, and the timer was stopped. Because it's the same harness, **outside coverage = unavailable** and there's no CROSS-MODEL line.
- **15 findings:**
  - **1 Critical (applied):** undo double-charged the free slot.
  - **4 High (applied):** stale test rule, pairing race, PGlite can't show races, single-process `./.data`.
  - **8 Medium:**
    - 7 applied: drop `preview_nonces`, cursor needs `visible_at` in step 2, size and AI limits, code length, unpair and deletion, production migrations, landing without consent.
    - 1 queued as TASTE `d6`: cut M1 scope.
  - **2 Low (applied):** age-gate retry, `ensureUser` race.
- **Disagreement left open:** only `d6`. The reviewer thinks the hardening is over-engineering for 3 testers. The plan keeps it because the founder chose "the best" and the hardening protects money and the pairing invariants.


<!-- autoplan-baseline-edits:ceo {"sourceSha256":"eb7d060cc6edda612fa8b833f0920b89073bf07f6482687234a0c3ec1248f757","replacements":[{"oldText":"- **Database:** Postgres through Drizzle ORM. Local development and tests use **PGlite** (embedded Postgres, no install). Production uses `postgres-js` against hosted Postgres via `DATABASE_URL`. Migrations come from drizzle-kit and are committed.","newText":"- **Database:** Postgres through Drizzle ORM. Local development and tests use **PGlite** (embedded Postgres, no install). Production uses `postgres-js` against hosted Postgres via `DATABASE_URL`. Migrations come from drizzle-kit and are committed.\n  - **Migrations:** `npm run dev` runs them against `./.data` before starting (a `predev` script), and the test setup runs them on each fresh in-memory PGlite.\n  - **One shared database client:** the client is a single instance for the whole process, cached on `globalThis` in development, so hot reloads never open `./.data` twice.\n  - **One process only:** PGlite file storage allows one process. So the admin \"set plan\" action and the events report run as development-only API routes (`/api/dev/plan`, `/api/dev/report`, which return 404 when `NODE_ENV=production`), never as separate processes against `./.data`. `next.config` lists PGlite in `serverExternalPackages`.\n  - **Production migrations:** `npm run build` runs `drizzle-kit migrate` against `DATABASE_URL` before `next build`, so the first deploy has its schema."},{"oldText":"- **Tests:** Vitest for `packages/core` and for API route handlers, which are called directly against a fresh PGlite per test. Typecheck, lint and tests run in GitHub Actions.","newText":"- **Tests:** Vitest for `packages/core` and for API route handlers, which are called directly against a fresh PGlite per test. Typecheck, lint and tests run in GitHub Actions.\n  - **Race tests:** PGlite runs queries one at a time, so it can't show a race. The parallel sends, parallel previews and concurrent pairing tests also run in CI against a Postgres 16 service container, through `TEST_DATABASE_URL`. Locally, without one, they run on PGlite and only check the logic."},{"oldText":"  - `free_translations_used` (int, 0..5)\n  - `pair_code`, `pair_code_expires_at`\n  - `share_traits` (bool, recipient consent)","newText":"  - `free_translations_used` (int, 0..5, counts sent translated messages)\n  - `free_previews_used` (int, 0..15, a cap on free AI previews)\n  - `pair_code`, `pair_code_expires_at` (the code lasts 7 days and is replaced right after a successful pairing, so each code works once)\n  - `share_traits` (bool, recipient consent)\n  - `age_blocked` (bool)"},{"oldText":"- **`couples`:** `id`, `user_a`, `user_b`, `created_at`, `ended_at`. Two partial unique indexes on `user_a` and on `user_b` while `ended_at` is null, plus a check that `user_a <> user_b`. A trigger or transaction check stops a user appearing in two active couples.","newText":"- **`couples`:** `id`, `created_at`, `ended_at`.\n- **`couple_members`:** `couple_id`, `user_id`, `active` (bool).\n  - A partial unique index on `user_id WHERE active` puts each user in at most one active couple, enforced by a single column.\n  - Pairing locks both user rows with `SELECT ... FOR UPDATE` in id order before inserting the two member rows.\n  - Unpairing sets `couples.ended_at` and `active=false` for both members."},{"oldText":"  - `mode`: `translated`, `coached` or `as_written`\n  - `change_summary`, `heated` (bool), `original_shared` (bool)\n  - `created_at`","newText":"  - `mode`: `translated` or `as_written`. Coaching is advisory: the sender edits their draft, then sends it translated or as written.\n  - `change_summary`, `heated` (bool), `original_shared` (bool)\n  - `preview_nonce` (nullable, unique): the token's nonce for a translated send. The unique index enforces one send per token, and undo's hard delete frees it automatically.\n  - `created_at`\n  - `visible_at`: set on insert by the app's SQL as `now() + make_interval(secs => $UNDO_WINDOW_SECONDS)`, using the database clock. The default window is 10 seconds (E1), and the minimum is 2 seconds. Even with undo cut, a short window keeps a slow commit from landing behind a poller's cursor. The column has no default of its own. Index `(couple_id, visible_at, id)`.\n- **`events`:** `id`, `user_id`, `couple_id` (nullable), `name` (enum), `props` (jsonb validated per event name, never message text), `created_at`."},{"oldText":"- **Account:** `GET /api/me` returns the user, plan, free translations left, couple and partner summary. `PATCH /api/me` updates the display name and time zone.\n- **Age gate:** `POST /api/me/birthdate` sets the birthdate once and returns 403 under 18. All other endpoints return 403 `age_required` until a birthdate is set.","newText":"- **Limits:**\n  - Message, preview and coach text is 1 to 4000 characters.\n  - Every user is limited to 60 AI calls per hour (preview plus coach), counted in the `events` table, with 429 `ai_rate_limited` above that. This bounds paid spend.\n- **Account:**\n  - `GET /api/me` returns the user, plan, free translations left, couple and partner summary.\n  - `PATCH /api/me` updates the display name and time zone.\n  - `DELETE /api/me` deletes the account's messages, questionnaire, events and memberships, unpairs, and deletes the Clerk user. The App Store requires this for the later Expo app.\n  - `ensureUser` uses `INSERT ... ON CONFLICT (id) DO NOTHING`, so parallel first requests are safe.\n- **Age gate:** `POST /api/me/birthdate` sets the birthdate once and returns 403 under 18. An under-18 attempt is stored as `age_blocked=true`, so later attempts also get 403 and a different date can't be retried. All other endpoints return 403 `age_required` until a birthdate is set, except `GET /api/me`. That stays open and reports `birthdate_set`, so the client knows to show the birthdate step."},{"oldText":"  - `POST /api/pair` with `{code}` checks the rate limit, then creates the couple in one transaction. Unique indexes reject a second active couple.\n  - `DELETE /api/pair` unpairs.","newText":"  - `POST /api/pair` with `{code}` checks the rate limit, then creates the couple in one transaction. Unique indexes reject a second active couple. Errors, each mapped to its `/pair` page message:\n\n    | Status | Code | Meaning |\n    |---|---|---|\n    | 400 | `own_code` | You entered your own code |\n    | 409 | `already_paired` | You're already in a couple |\n    | 409 | `partner_unavailable` | The code's owner is already paired |\n    | 410 | `code_expired` | The code is expired or used |\n    | 429 | `rate_limited` | Too many attempts this hour |\n    | 403 | `age_required` | No birthdate set yet |\n  - `DELETE /api/pair` unpairs.\n    - Both people keep read-only access to their past messages, and pending messages are deleted.\n    - Both pair codes rotate.\n    - Re-pairing with the same person starts a new couple, and the old history stays read-only under the old couple."},{"oldText":"  - `GET /api/messages?after=<id>` lists the couple's messages through one serializer: the sender sees `original_text`; the recipient gets `original_text` only when `original_shared && recipient.plan === 'paid'`, and otherwise just `original_shared`.\n  - `POST /api/messages/preview` with `{text}` returns the translation preview and `heated` without storing anything. The free slot is reserved here and released on failure; see the translation flow below.","newText":"  - `GET /api/messages?cursor=<visible_at>,<id>` lists the couple's messages through one serializer, ordered by `(visible_at, id)`.\n    - The sender sees all of their own messages, including ones still in the undo window, plus `original_text`.\n    - The recipient sees only messages with `visible_at <= now()` (database clock). They get `original_text` only when `original_shared && recipient.plan === 'paid'`, and otherwise just `original_shared`.\n    - Because the cursor is `(visible_at, id)`, a message that becomes visible later is never skipped.\n    - **Response:** `{messages, pending, server_now}`.\n      - `messages` holds only rows with `visible_at <= now()`, for both people, and the cursor advances only over these.\n      - `pending` holds the sender's own messages that are still in the undo window. It's returned in full on every poll and never moves the cursor, so neither partner's cursor can skip a message.\n      - Each message carries `visible_at`. The client counts down \"Sending · Undo\" from `visible_at - server_now`, never from its own clock.\n  - `POST /api/messages/preview` with `{text}` returns the translation preview, `heated` and `safety` without storing any text. A free user's preview allowance is reserved here and released on failure; see the translation flow below."},{"oldText":"  - `POST /api/messages/:id/share` with `{shared}`, sender only.\n- **Coaching:** `POST /api/coach` with `{text}`, paid only (403 `upgrade_required` otherwise). Returns `{landing, swaps[], encouragement, safety}` and stores nothing.","newText":"  - `DELETE /api/messages/:id` is undo (E1). The sender can use it while `now() < visible_at`.\n    - In one transaction, it hard-deletes the row, which frees the nonce with it. If the row was a free user's translated send, it also runs `free_translations_used = free_translations_used - 1`, so re-sending the same preview doesn't charge twice.\n    - It returns 409 after the window and 404 to anyone else.\n  - `POST /api/messages/:id/share` with `{shared}`, sender only. It's allowed during the window and takes effect once the message is visible.\n- **Events:** `POST /api/events` with `{name: 'breath_step', props: {choice: 'send'|'edit'|'later'}}`. Only client-side events are accepted here. Server events are written by the handlers themselves.\n- **Coaching:** `POST /api/coach` with `{text}`, paid only (403 `upgrade_required` otherwise). Returns `{landing, swaps[], encouragement, safety}` and stores nothing. `landing` names the partner and the specific trait it's based on, for example \"Maya prefers gentle feedback\". That partner-specific model is the moat: generic OS-level rewriters can't do it. If the partner has `share_traits=false`, `landing` says it's general advice, for example \"Maya hasn't shared her preferences, so this is general advice\", and names no trait."},{"oldText":"1. The client calls `preview`.\n   - **Free user with fewer than 5 used:** reserve one translation atomically with `UPDATE users SET free_translations_used = free_translations_used + 1 WHERE id = $1 AND free_translations_used < 5`.","newText":"1. The client calls `preview`. A free user's 5 translations count **sent** translated messages, which matches \"first 5 messages\". Previews have their own cap to limit AI spend.\n   - **Preview allowance:** a preview is allowed while `free_translations_used < 5` and `free_previews_used < 15`, which allows about 3 previews per free message. The preview counter is reserved atomically: `UPDATE users SET free_previews_used = free_previews_used + 1 WHERE id = $1 AND free_previews_used < 15 AND free_translations_used < 5`.\n   - **The translation slot** is reserved atomically at **send** of a translated message: `... SET free_translations_used = free_translations_used + 1 WHERE id = $1 AND free_translations_used < 5`. A lost race returns 402.\n   - **Past either limit:** preview returns 402 `free_translations_used_up`, and the composer switches to sending as written.\n   - **Unpaired users** can preview using neutral default traits, so the composer shows its value before the partner joins."},{"oldText":"   - **On AI failure:** release the slot and return 503 `translate_failed`.\n2. The preview returns `{delivered_text, change_summary, heated, preview_token}`. The token is an HMAC of the user, the text hash and the delivered text, with a 15-minute expiry, so the server can trust the translation at send without a second AI call or double-charging.\n3. **If `heated`,** the client shows the breath step (Send, Edit or Save for later). Save for later keeps the draft in localStorage only.\n4. `POST /api/messages` with `mode=translated` requires a valid `preview_token` matching the text. `mode=as_written` stores `delivered_text = original_text` and needs no AI. A free user past 5 can only send `as_written`, and the UI explains why.\n5. **Paid users** get translation on every send (no counter) and can also coach before preview.","newText":"   - **On AI failure:** release the preview reservation and return 503 `translate_failed`.\n2. The preview returns `{delivered_text, change_summary, heated, safety, preview_token}`.\n   - **The token** is an HMAC over `{user_id, sha256(text), delivered_text, change_summary, heated, safety, nonce, exp}` and expires after 15 minutes. At send, the server reads `heated`, `safety`, `delivered_text` and `change_summary` from the verified token, never from the client.\n   - **One send per token:** the message insert with `preview_nonce` fails on the unique index if the token was already used, and returns 409 `already_sent`.\n   - **After an undo,** the message row and its nonce are gone, and a free translation slot is returned. The composer gets back the original text and keeps the token in memory, so the same preview can be sent again without a new AI call. Once the token's 15 minutes are up, a fresh preview is needed, and for a free user that uses one of the 15 previews.\n3. **If `safety` is set,** the client shows support resources and the options to edit or send as written, and there's no softened version.\n   - The preview returns `delivered_text = null`.\n   - `POST /api/messages` rejects `mode=translated` with a safety token: 422 `safety_requires_as_written`.\n   **If `heated` is set,** the client shows the breath step (Send, Edit or Save for later) and reports the choice through `POST /api/events`. Save for later keeps the draft in localStorage only (E3).\n4. `POST /api/messages` with `mode=translated` requires a valid, unused `preview_token` whose text hash matches. `mode=as_written` stores `delivered_text = original_text` and needs no AI. A free user past 5 can only send `as_written`, and the UI explains why.\n5. **Paid users** get translation on every send (no counter), can coach before preview, and can still choose to send as written.\n6. **Known gap (TASTE, decided at the final gate):** `as_written` sends make no AI call, so they get no `heated` or `safety` detection and no breath step. That includes every send by a free user past 5. This keeps the free tier at zero AI cost."},{"oldText":"- `/onboarding`: birthdate (Day, Month and Year dropdowns as in v1), then the questionnaire with the consent explainer, then the partner code.\n- `/chat`: a calm conversation. Polls `GET /api/messages?after=` every 5 seconds while visible and every 30 seconds when hidden. Shows \"Delivered\" only, with no read receipts and no typing indicator. The composer runs: draft, optional \"How will this land?\" (paid), \"Preview\", the \"This will be delivered as…\" card with a heated breath step, then Send.\n- `/settings`: name, trait-sharing consent toggle, unpair, plan status.","newText":"- `/onboarding`: birthdate (Day, Month and Year dropdowns as in v1), then the questionnaire with the consent explainer, then the partner step. The partner step shows your code with \"Copy invite link\" (E2) and a box for entering your partner's code.\n- `/pair?code=<code>` (E2). Codes are 10 characters from a 31-symbol alphabet, about 49 bits, so guessing across many cheap accounts isn't practical.\n  - **Signed out:** the code is saved to sessionStorage, and the visitor chooses Sign up or Sign in. Both carry `redirect_url=/pair?code=XXXX`, so `/pair` routes them by their state after auth.\n  - **Signed in but not onboarded** (no birthdate or questionnaire yet): goes to `/onboarding` with the code saved, and the partner step pre-fills it.\n  - **Signed in, onboarded and not paired:** a \"Connect with your partner\" confirm button calls `POST /api/pair`. Errors show the messages from the pairing error table.\n  - **Your own code:** shows \"This is your own invite. Send it to your partner.\"\n  - **Already paired:** shows \"You're already connected with {name}\".\n  - **Expired or used code:** shows \"This invite has expired. Ask your partner to send a new link.\"\n- `/chat`: a calm conversation.\n  - **Polling:** polls `GET /api/messages?cursor=` every 5 seconds while visible and every 30 seconds when hidden.\n  - **Message status:** no read receipts and no typing indicator. Your own message shows \"Sending · Undo\" until it's visible, then \"Delivered\".\n  - **Composer:** draft, then optional \"How will this land?\" (paid), then \"Preview\", then the \"This will be delivered as…\" card with the heated breath step, then Send. There's also a \"Drafts (n)\" tray.\n- `/settings`: name, trait-sharing consent toggle, \"Copy invite link\", unpair, plan status."},{"oldText":"- **Undo window, E1:** every sent message has a 10-second undo window.\n  - The serializer hides a message from the recipient until `created_at + 10s`.\n  - `DELETE /api/messages/:id` lets the sender take it back inside the window and returns 409 after it.\n  - The composer shows \"Sent · Undo (10s)\".\n  - The free translation slot is not refunded on undo; the AI already ran.\n  - Tested: hidden from the recipient during the window, deleted on undo, 409 after.\n- **Invite link, E2:** `/pair?code=XXXX` pre-fills the partner code. After sign-up and onboarding, the partner lands on the pairing step with the code filled in. The code rules (expiry, single use, rate limit) still apply.\n- **Drafts tray, E3:** \"Save for later\" drafts live in localStorage under the user's ID. The composer shows a small \"Drafts (n)\" tray to restore or delete them, and nothing goes to the server.\n- **Product events, E4:** an `events` table records one row each for:","newText":"This is the single description of the additions. Their API, data and page details are written into the sections above.\n- **Undo window, E1:** messages stay hidden from the recipient until `visible_at` (10 seconds after sending, set by the database clock).\n  - **Undo:** `DELETE /api/messages/:id` hard-deletes the message inside the window, returns 409 after it and 404 to non-senders. It also returns a free user's translation slot, so the same preview can be re-sent without another charge.\n  - **Sender's view:** \"Sending · Undo\" until the message is visible, then \"Delivered\".\n- **Invite link, E2:** `/pair?code=` works for signed-out visitors through sign-up and onboarding, using sessionStorage and `redirect_url`. There's also a message for users who are already paired, a message for expired or used codes, and a \"Copy invite link\" button in onboarding and settings. Codes last 7 days and work once, and the rate limit applies.\n- **Drafts tray, E3:** \"Save for later\" drafts are kept only in localStorage under `il:drafts:<userId>`. A \"Drafts (n)\" tray restores or deletes them, and nothing goes to the server. The logic lives in `apps/web/lib/drafts.ts` so it can be unit-tested.\n- **Product events, E4:** `events` rows, with enum names and validated props and never message text:"},{"oldText":"  - `breath_step` with `{choice: send|edit|later}`","newText":"  - `message_undone`\n  - `breath_step` with `{choice}`, sent by the client through `POST /api/events`"},{"oldText":"  - `translation_failed` with `{reason}`","newText":"  - `translation_failed` with `{reason: timeout|api_error|invalid_output}`\n  - `invite_copied` and `invite_opened` (the pairing funnel)\n  - `upgrade_clicked` with `{feature: coach|original|translation}`: a \"fake door\" that tests willingness to pay before Stripe exists"},{"oldText":"  It never stores message text. `npm run report:events` prints counts per user for the Assignment write-up.","newText":"  `npm run report:events` prints counts per user, plus the M1 success metric: **weekly active couples where both partners sent at least one message**.\n- **Deferred to TODOS.md (created in the first build commit):** E5, letting the recipient ask for the original, and E6, the PWA manifest, which goes with M2 Web Push."},{"oldText":"- `.gitignore` covers `.env*` from the first commit. `.env.example` lists `CLERK_*`, `ANTHROPIC_API_KEY`, `DATABASE_URL` (empty means PGlite under `./.data`), `PREVIEW_TOKEN_SECRET`, and M2's `STRIPE_*` and `VAPID_*`.","newText":"- `.gitignore` covers `.env*` from the first commit. `.env.example` lists `CLERK_*`, `ANTHROPIC_API_KEY`, `DATABASE_URL` (empty means PGlite under `./.data`), `PREVIEW_TOKEN_SECRET`, `UNDO_WINDOW_SECONDS`, and M2's `STRIPE_*` and `VAPID_*`.\n- `PREVIEW_TOKEN_SECRET` has a development-only default. The app refuses to start without a real value when `NODE_ENV=production`.\n- **Auth seam:** handlers get the user only through `getUserId(req)` in `apps/web/lib/auth.ts`, which wraps Clerk's `auth()`. Handler tests mock this function, so tests never need Clerk."},{"oldText":"- **Free translations:** 20 parallel previews for a free user reserve exactly 5, and an AI failure returns the slot.","newText":"- **Free translations:**\n  - 20 parallel translated sends for a free user succeed exactly 5 times.\n  - 30 parallel previews reserve exactly 15.\n  - An AI failure returns the preview reservation.\n  - An unpaired user can preview using neutral traits."},{"oldText":"- **Age gate:** under 18 gets 403, and other endpoints are blocked until the birthdate is set.\n- **Questionnaire:** invalid answers get 400.","newText":"- **Age gate:** under 18 gets 403, and other endpoints are blocked until the birthdate is set. After an under-18 attempt, a retry with an adult date still gets 403 (`age_blocked`).\n- **Concurrent pairing:** X redeeming Y's code while Z redeems X's code leaves X in exactly one active couple (CI Postgres).\n- **Limits:** text over 4000 characters gets 400, and the 61st AI call in an hour gets 429 `ai_rate_limited`.\n- **Account deletion:** `DELETE /api/me` removes the user's messages, questionnaire, events and memberships, and unpairs the partner.\n- **Questionnaire:** invalid answers get 400.\n- **Undo, E1:**\n  - The recipient doesn't see a message before `visible_at`, and does after.\n  - A later visible message doesn't let the cursor skip an earlier hidden one.\n  - The sender's DELETE inside the window removes the message and returns the free slot. A re-send of the same token works, and `free_translations_used` is unchanged overall.\n  - DELETE after the window gets 409; a non-sender gets 404.\n  - Tests control time by setting `visible_at` directly (for example to `now() - interval '1 second'`), never by sleeping.\n- **Free limit edges:** a 16th preview, or any preview after 5 translated sends, returns 402 `free_translations_used_up`. `GET /api/me` works before the birthdate is set and reports `birthdate_set`.\n- **Pair link states:**\n  - Your own code gets 400 `own_code`, and an inviter who is already paired gets 409 `partner_unavailable`.\n  - Each error code maps to its page message.\n- **Sender cursor:** the sender polls while their own message is pending. A partner message that becomes visible afterwards, with an earlier `visible_at`, is still delivered to the sender.\n- **Safety send:** `mode=translated` with a safety token returns 422 `safety_requires_as_written`.\n- **Undo window setting:** `visible_at` respects `UNDO_WINDOW_SECONDS`.\n- **Preview token:** a replayed token is rejected, and a token reused after undo is accepted once. `heated` and `safety` come from the token, not the client.\n- **Invite, E2:** a code from the link pairs through `POST /api/pair`; a used or expired code gives the expired message; an already-paired user is refused.\n- **Drafts, E3:** `drafts.ts` keys drafts per user (one user's tray doesn't show another's) and saves, restores and deletes them, tested with an in-memory storage stub.\n- **Events, E4:** `message_sent`, `message_undone` and `paired` rows are written. `POST /api/events` rejects unknown names and props, and no event row contains message text (checked against the schema)."},{"oldText":"- **Realtime and push:** push updates through a hosted realtime service or LISTEN/NOTIFY, plus Web Push with new VAPID keys.","newText":"- **Realtime and push:** push updates through a hosted realtime service or LISTEN/NOTIFY, plus Web Push with new VAPID keys and the PWA manifest (E6), which iOS needs before web push works."},{"oldText":"- **Diary and weekly report:** both ported from v1.\n","newText":"- **Diary and weekly report:** both ported from v1.\n\n### Build order (cut line)\n1. Workspace, database, auth seam, age gate, questionnaire, pairing.\n2. Preview and translate, send as translated or as written, messages API with `visible_at`, cursor and pending, `/chat`. The `visible_at` column and its minimum window ship here, even if undo is cut.\n3. Coaching, sharing originals, safety UI.\n4. E2 invite link, E4 events.\n5. E1 undo endpoint and UI (DELETE, slot return), E3 drafts tray.\n\n**Cut line:** if time runs short, steps 1-3 alone are a usable M1. Steps 4-5 come next.\n\n### Alternatives considered\n- **Composer plus share sheet** (deliver through WhatsApp or iMessage): the founder rejected this in office hours (premise 3). Raised again by the CEO voice, so it's queued for the final gate.\n- **Mobile first with Expo:** web first was chosen, so M1 can reach testers with a link. `packages/core` and the API keep Expo cheap later.\n- **Fixing v1 in place:** rejected because CRA, MongoDB and the Emergent proxy caused the audit findings (see the Step 0 code reuse table).\n"}]} -->

### DX review (autoplan, DX POLISH), Step 0
- **Product type:** API/Service plus a developer-run web app (npm workspaces). There are two developer surfaces: the repo itself (scripts, env, database, tests) and `/api/v1` for the later Expo client.
- **Persona card (0A, auto-decided by P6):** a solo founder-developer on Windows, working with an AI coding agent, plus later an Expo client author. They want to clone, run and click through in one sitting, with no paid accounts. They give up when sign-up walls or unclear errors cost more than 10 minutes. The agent reads errors literally.
- **Empathy narrative (0B):** "I cloned the repo and ran `npm install`. The plan said I needed Clerk keys, so I opened a new tab, made a Clerk app, and copied two keys into the wrong file first. `npm run dev` worked, but to test messaging I had to sign up twice in two browsers, do the questionnaire twice, pair, and then find a hidden dev route to make one user paid. By then 20 minutes had gone and I hadn't seen the translation, which is the whole point. When a preview failed, I got a 503 code and no hint whether retrying would charge my free slot."
- **Competitive benchmark (0C):** reference tiers from the methodology. Web research was skipped: Aside wasn't ready and this is a private app, not a public dev tool, so competitor scraping adds little. Comparable Next.js starters (create-t3-app, the Vercel templates) reach first page in 2-5 minutes without accounts. **Target: Competitive tier, under 5 minutes.**
- **Magical moment (0D):** alice sends "you never listen to me" and bob, in a second tab, receives the softened translation. **Vehicle, the lowest-effort one (P5):** `npm run seed` plus `/dev/login?as=alice` and `?as=bob`, with the fake coach producing a deterministic translation.
- **Mode (0E):** DX POLISH (override rule).
- **TTHW:** today it's about 7 steps and 15-25 minutes (Red Flag). After the fixes it's 4 steps and about 3 minutes (Competitive).

**Developer journey map (0F)**

| Stage | Before | Friction | Resolution |
|---|---|---|---|
| Discover | No README | Doesn't know what to run | README quickstart (item 16) |
| Install | `npm install` | Node version unstated | `engines` and `.nvmrc` |
| Configure | Clerk account and keys required | Leave the terminal, about 8 minutes | `DEV_AUTH=1` default in `.env.example` (item 11) |
| Hello world | Two sign-ups, onboarding twice, pair, set paid | About 10 minutes, set-plan undocumented | `npm run seed` and `/dev/login?as=` (items 11, 14) |
| Debug | Bare codes, no body shape, no retry rules | Agent can't tell whether a retry is safe | problem+json, `retryable`, `Retry-After`, ERRORS.md (items 2-5) |
| Deploy | Build migrates whatever `DATABASE_URL` points at | Preview build can migrate production | `db:migrate` deploy step (item 8) |

**First-time confusion report (0G):** each was addressed by the item in brackets.
- Which keys do I need? (11)
- Why does the second `npm run dev` hang? (9)
- Which free limit did I hit? (5)
- Is the AI real or fake? (1)
- Why does the cursor break with `+00:00`? (12)
- Did the race tests actually run? (13)

### DX review: dual voices
- **Claude subagent (DX, independent review):** completed. INPUT matched `dx 2a2447fa...`. It raised 17 findings: 1 Critical, 10 High and 6 Medium.
- **Codex says:** unavailable, because Codex isn't installed. Outside coverage is missing; that's not the same as clean.

```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Getting started < 5 min?          No      N/A    N/A (single voice)
  2. API/CLI naming guessable?         Mostly  N/A    N/A
  3. Error messages actionable?        No      N/A    N/A
  4. Docs findable & complete?         No      N/A    N/A
  5. Upgrade path safe?                No      N/A    N/A
  6. Dev environment friction-free?    No      N/A    N/A
```
**Single-voice Critical, flagged:** CAP4 fake coach in production. It was fixed, so it doesn't go to the gate.

### DX review: passes 1-8 (before → after)
1. **Getting started: 3 → 8.**
   - Before: a Clerk account was required and there were 7 steps.
   - Fixed by dev login, the seed and the README's 4 steps.
   - Not a 10, because real sign-up still needs Clerk keys.
2. **API design: 6 → 8.**
   - `/api/v1`, the opaque `next_cursor`, the split 402 codes, and the two age codes.
   - Names are consistent snake_case.
3. **Errors: 4 → 8.**
   - Error path matrix below. After the fixes, no cap remains.
4. **Docs: 3 → 7.**
   - README, ERRORS.md, and API.md with curl examples.
   - No hosted docs or search; not needed for one developer.
5. **Upgrade path: 2 → 6.**
   - `/api/v1` with a v2 rule, `db:migrate` with recovery.
   - No changelog policy yet. Deferred to M2, before the first Expo build.
6. **Dev environment: 5 → 8.**
   - PGlite with no install, Windows-safe `db:reset`, the lockfile, a visible race-test skip, and CI Postgres.
7. **Community: N/A → 3.**
   - A private app. No open-source or community goal (premise from office hours).
   - Scored low but not treated as debt.
8. **DX measurement: 2 → 6.**
   - TTHW is measured by timing the README quickstart on a clean checkout in the founder's M1 manual run.
   - No telemetry is added (not approved; P6).
   - Product events (E4) already cover the user funnel.

```
ERROR PATH MATRIX (agent-ready-v1), after fixes
Path                      | Class      | what | fix | recovery | code | context | trace | redaction | channel | Cap
POST /messages/preview 503| dependency | pass | pass| pass     | pass | pass    | pass  | pass      | pass    | -
POST /messages 402 x2     | usage      | pass | pass| N/A      | pass | N/A     | N/A   | pass      | pass    | -
DELETE /me 502            | partial    | pass | pass| pass     | pass | pass    | pass  | pass      | pass    | -
startup env (unexpected)  | config     | pass | pass| pass     | pass | pass    | pass  | pass      | pass    | -
```
- **Before the fixes:**
  - **The fake coach answered with 200 in production.** This was CAP4: a failure that looked like success.
  - **The preview's 503 was missing two items.** It gave no recovery (whether a retry is safe) and no context (CAP6).
  - **The 402 code was ambiguous.** It didn't say which free limit was hit, so the "what" failed.
  - **`DELETE /me` had no rule for a partial failure.** It didn't say what happens when one of the two steps fails (CAP6).
  - **The env check could fail on the first request** instead of at startup (CAP6).
- **Example of a corrected error:** `503 {code:"translate_failed", detail:"The translation service timed out after 20s. Nothing was charged or stored.", retryable:true, request_id:"r_8f2"}`.
- **Safety model:**
  - `DEV_AUTH` and `/dev/*` are refused in production by the env check and by 404s.
  - There's no verbose mode beyond `request_id` plus the server log, which is enough for a remote API.

### DX review: required outputs
```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      |  8/10  |  3/10  | +5 ↑   |
| API/CLI/SDK          |  8/10  |  6/10  | +2 ↑   |
| Error Messages       |  8/10  |  4/10  | +4 ↑   |
| Documentation        |  7/10  |  3/10  | +4 ↑   |
| Upgrade Path         |  6/10  |  2/10  | +4 ↑   |
| Dev Environment      |  8/10  |  5/10  | +3 ↑   |
| Community            |  3/10  |  N/A   | private app |
| DX Measurement       |  6/10  |  2/10  | +4 ↑   |
+--------------------------------------------------------------------+
| TTHW                 |  3 min | 20 min | ↓ 17   |
| Competitive Rank     | Competitive                                 |
| Magical Moment       | designed via seed + /dev/login two tabs     |
| Product Type         | API/Service + developer-run web app         |
| Mode                 | POLISH                                      |
| Overall DX           |  7/10  |  4/10  | +3 ↑   |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered                                        |
| Learn by Doing     | covered (seeded users)                         |
| Fight Uncertainty  | covered (problem+json, retryable)              |
| Opinionated + Escape Hatches | covered (COACH, ANTHROPIC_MODEL, DEV_AUTH) |
| Code in Context    | covered (API.md curl)                          |
| Magical Moments    | covered                                        |
| Agents Are Users   | covered (stable codes, request_id)             |
+====================================================================+
```
- **Community 3/10:** deliberate. This is a private consumer app, not a developer product.
- **Upgrade path 6/10:** the remaining debt is the changelog policy, deferred to M2 before the first Expo build.

```
DX IMPLEMENTATION CHECKLIST
[ ] TTHW < 5 min via README quickstart (no accounts)
[ ] Installation is one command (npm install)
[ ] First run shows alice and bob chatting
[ ] Magical moment via seed + /dev/login
[ ] Every error is problem+json with stable code, retryable, request_id
[ ] Names are consistent snake_case under /api/v1
[ ] Every env var has a default or a startup error naming it
[ ] API.md curl examples work as-is
[ ] Upgrade rule: /api/v2 for breaking changes; db:migrate deploy step
[ ] TypeScript types: zod schemas in packages/core are exported
[ ] Works in CI without accounts (DEV_AUTH, fake coach, TEST_DATABASE_URL)
[-] Free tier, community channel, docs search: N/A for a private app
```
- **NOT in scope:**
  - Making the limits configurable through env: they're constants in one file; YAGNI.
  - A `deleting` flag on the user row: DELETE runs the database step first and retries are idempotent, so it isn't needed.
  - Hosted docs, a docs search, a community channel.
  - A changelog policy: deferred to M2 so it lands before the Expo app's first build.
  - TTHW telemetry: not approved.
- **What already exists:**
  - v1's offline test patterns (`../app/backend/tests/test_audit_fixes.py`).
  - The pairing error table.
  - `.env.example`.
  - The `getUserId` seam, which the dev login extends.
- **TODOS.md:** add a changelog and API deprecation policy before the first Expo build (M2). Auto-decided to add it, under P1.

**Implementation tasks (devex-review):**
- [ ] **T1 (P1, human ~1h / CC ~10min):** `packages/core/ai`. Make the fake coach dev-only and add `COACH` and `ANTHROPIC_MODEL` plus the 20 s timeout. Verify: env test.
- [ ] **T2 (P1, human ~3h / CC ~20min):** `packages/core/errors.ts`. Add `apiError()` with problem+json, Retry-After and request_id, plus `docs/ERRORS.md`. Verify: the codes-walk test.
- [ ] **T3 (P1, human ~2h / CC ~15min):** `apps/web/env.ts` and `instrumentation.ts`. Add the startup env check. Verify: env tests.
- [ ] **T4 (P1, human ~3h / CC ~20min):** `apps/web/lib/auth.ts`. Add dev login, `/dev/login` and `npm run seed`. Verify: 404 in production, the two-tab quickstart.
- [ ] **T5 (P2, human ~2h / CC ~15min):** API. Move routes to `/api/v1`, add the opaque cursor and `next_cursor`, split the 402s and add `age_blocked`. Verify: handler tests.
- [ ] **T6 (P2, human ~1h / CC ~10min):** account. Make DELETE /me run the database step before Clerk, with 502 retry. Verify: test.
- [ ] **T7 (P2, human ~1h / CC ~10min):** scripts. Add `db:migrate`, `db:reset`, the PGlite lockfile, `dev:plan`, and make `report:events` call the dev routes. Verify: manual.
- [ ] **T8 (P2, human ~2h / CC ~10min):** docs. Write the README quickstart, API.md, `.nvmrc` and `engines`. Verify: time the quickstart on a clean checkout.

### DX decision audit trail
| # | Phase | Decision | Class | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 24 | DX | Fake coach dev-only, production fails without a key | Mechanical | P1 | CAP4: a failure that looked like success | keep the silent fallback |
| 25 | DX | RFC 9457 problem+json through one `apiError()` | Mechanical | P1/P5 | Override rule: the agent-ready contract | ad hoc JSON |
| 26 | DX | Retry-After, retryable translate_failed, 20 s timeout | Mechanical | P1 | CAP6 recovery | none |
| 27 | DX | Split the 402 codes, add `age_blocked` | Mechanical | P5 | One code meant two things | the `limit` field alone |
| 28 | DX | DELETE /me: database first, then Clerk, 502 retry | Mechanical | P3 | Idempotent retry beats a `deleting` flag | the `deleting` flag |
| 29 | DX | One `env.ts` at startup | Mechanical | P5 | Fails at boot, not on the first request | per-use checks |
| 30 | DX | `db:migrate` separate from build (supersedes #22, part) | Mechanical | P1 | A preview build could migrate production; the CEO goal "first deploy has a schema" is kept by the deploy step | migrate in build |
| 31 | DX | PGlite lockfile and Node `db:reset` | Mechanical | P1 | Stops corruption or a hang; Windows-safe | rm -rf |
| 32 | DX | `/api/v1` | Mechanical | P1 | Founder wants the Expo app; old builds stay in the wild | unversioned |
| 33 | DX | DEV_AUTH dev login and seed | Mechanical | P5 | TTHW goes from 20 min to 3 min; refused in production | Clerk-only dev |
| 34 | DX | Opaque `next_cursor` | Mechanical | P5 | `+00:00` breaks the query string | raw timestamp |
| 35 | DX | Visible skip for race tests | Mechanical | P5 | A false green is worse than a visible skip | silent PGlite pass |
| 36 | DX | Dev scripts call the dev routes | Mechanical | P5 | Keeps the one-process rule | direct database scripts |
| 37 | DX | README, ERRORS.md, API.md | Mechanical | P1 | No quickstart existed | none |
| 38 | DX | Skip env overrides for limits | Mechanical | P3 | YAGNI; constants in one file | env knobs |

<!-- autoplan-accepted:dx -->
- Fake coach is dev-only: `COACH=fake|anthropic`; production without `ANTHROPIC_API_KEY` fails the startup env check; dev logs `coach=fake`; `ANTHROPIC_MODEL` override; 20 s AI timeout; test that the fake is refused in production.
- RFC 9457 problem+json errors via one `apiError()` in `packages/core/errors.ts` with `type, title, status, code, detail, retryable, request_id` and optional `retry_after, fields, limit`; `invalid_input` with `fields`; 500 `internal` returns only `request_id`; no secrets or message text in bodies or logs; `docs/ERRORS.md` anchor per code with a test that walks the codes.
- 429 `rate_limited` and `ai_rate_limited` send `Retry-After` and `retry_after`; test.
- 503 `translate_failed` is `retryable: true`, states nothing was charged or stored; client retries at most twice, then offers as-written.
- 402 split into `free_translations_used_up` and `free_previews_used_up` with `limit` and `used`; tests for each.
- `DELETE /api/me`: database transaction first, then Clerk; both idempotent; Clerk failure returns 502 `account_delete_incomplete` (`retryable: true`) and a retry completes; test.
- Age gate codes: `age_blocked` (no self-serve fix, client signs out) vs `age_required` (POST birthdate).
- One zod `env.ts` loaded from `instrumentation.ts`: names each bad variable and its fix, never values; production requires `PREVIEW_TOKEN_SECRET` and `ANTHROPIC_API_KEY`; `UNDO_WINDOW_SECONDS` integer >= 2; `DEV_AUTH=1` refused in production; tests.
- Migrations: `npm run build` is only `next build`; separate `npm run db:migrate`; production deploy runs `db:migrate && build`; failed migration recovery documented. (Supersedes the CEO outside-voice "build runs migrations".)
- PGlite `./.data/.lock` pid lockfile with a clear second-opener error; `npm run db:reset` in Node.
- Routes under `/api/v1`; zod schemas in `packages/core` are the contract; breaking change means `/api/v2`.
- Dev login: `DEV_AUTH=1` (non-production) makes `getUserId` read a `dev_user` cookie; `/dev/login?as=alice|bob`; `npm run seed` creates paired adult onboarded alice and bob (bob paid); `.env.example` ships `DEV_AUTH=1`; `/dev/*` 404 in production; test.
- Opaque base64url cursor returned as `next_cursor`; bad cursor 400 `invalid_cursor`; test.
- Race tests `it.skipIf(!TEST_DATABASE_URL)` with a visible reason; single-request logic tests always run on PGlite.
- `npm run report:events` and `npm run dev:plan -- <email> free|paid` call the dev routes and exit 1 with "Start `npm run dev` first" when the server is down.
- Docs: `README.md` 4-step no-account quickstart under 5 minutes, Node pinned in `engines` and `.nvmrc`, scripts list, real-key switch, deploy steps; `docs/ERRORS.md`; `docs/API.md` with one curl per route. Build step 1 includes env check, `apiError()`, dev login, seed and README.
- Done means: clean checkout runs with no accounts; README quickstart reaches alice and bob chatting in under 5 minutes; the Clerk sign-up manual run uses `npm run dev:plan` for the paid user.
<!-- /autoplan-accepted:dx -->

### DX review: outside voice
- **Provider:** Codex isn't installed, so outside coverage is **unavailable**. The native Claude subagent's review was the only voice. Consensus is N/A, and nothing goes to the gate as a disagreement.

<!-- autoplan-baseline-edits:dx {"sourceSha256":"e9039280c239a47f9a2d9389341de667ba7c84995ef45e0f4d2affa512430f01","replacements":[{"oldText":"  - **Production migrations:** `npm run build` runs `drizzle-kit migrate` against `DATABASE_URL` before `next build`, so the first deploy has its schema.","newText":"    - The client writes `./.data/.lock` with its pid on open. A second opener exits non-zero with: \"./.data is in use by pid N. Stop that process, or run `npm run db:reset`.\"\n    - `npm run report:events` and `npm run dev:plan -- <email> free|paid` are thin scripts that call those routes on `http://localhost:3000`. If the dev server is down, they exit 1 with \"Start `npm run dev` first.\"\n  - **Production migrations:** a separate `npm run db:migrate` (drizzle-kit migrate against `DATABASE_URL`). `npm run build` is only `next build`, so a preview build can never migrate production. The production deploy runs `npm run db:migrate && npm run build`. A failed migration rolls back its own file (drizzle runs each file in a transaction). Fix the migration and run it again.\n  - **`npm run db:reset`** deletes `./.data` (Node `fs.rm`, so it works on Windows) and re-runs migrations and the seed."},{"oldText":"- **AI:** `@anthropic-ai/sdk` called directly with `ANTHROPIC_API_KEY`, current Sonnet model (exact ID checked with the claude-api reference at build time). Structured output comes through a tool or JSON schema and is validated with zod. All AI calls go through a single `Coach` interface in `packages/core/ai` with a deterministic fake for tests and for running without a key.","newText":"- **AI:** `@anthropic-ai/sdk` called directly with `ANTHROPIC_API_KEY`, current Sonnet model (exact ID checked with the claude-api reference at build time). Structured output comes through a tool or JSON schema and is validated with zod. All AI calls go through a single `Coach` interface in `packages/core/ai` with a deterministic fake for tests and local development.\n  - **The fake never runs in production.** `COACH=fake|anthropic` picks the coach, and the default is `anthropic` when `ANTHROPIC_API_KEY` is set and `fake` otherwise, outside production only. In production a missing key fails the startup env check. The dev server logs `coach=fake` once when the fake is active.\n  - `ANTHROPIC_MODEL` overrides the model ID. Every AI call has a 20-second timeout."},{"oldText":"  - **Race tests:** PGlite runs queries one at a time, so it can't show a race. The parallel sends, parallel previews and concurrent pairing tests also run in CI against a Postgres 16 service container, through `TEST_DATABASE_URL`. Locally, without one, they run on PGlite and only check the logic.","newText":"  - **Race tests:** PGlite runs queries one at a time, so it can't show a race. The parallel sends, parallel previews and concurrent pairing tests run against a Postgres 16 service container in CI, through `TEST_DATABASE_URL`. Without it they are skipped with a visible reason (`it.skipIf`). The single-request logic for the same rules has its own tests, which always run on PGlite."},{"oldText":"### API (apps/web/app/api, JSON, every handler validates input with zod and checks auth)","newText":"### API (apps/web/app/api/v1, JSON, every handler validates input with zod and checks auth)\n- **Versioning:** every route lives under `/api/v1` (paths below are written without the prefix). The zod schemas in `packages/core` are the contract. A breaking change gets `/api/v2`, while `/api/v1` keeps working until the Expo app's minimum supported version no longer calls it.\n- **Error format:** every error is RFC 9457 `application/problem+json`, built by one helper, `apiError()`, in `packages/core/errors.ts`:\n  `{type: \"/docs/errors#<code>\", title, status, code, detail, retryable, request_id, retry_after?, fields?, limit?}`.\n  - `code` is stable snake_case, and `docs/ERRORS.md` has one anchor per code, giving its meaning and the fix.\n  - `detail` names the actual value and the fix, for example \"Text is 4213 characters; the maximum is 4000. Shorten it and send again.\"\n  - zod 400s are `invalid_input`, with `fields: [{path, message}]`.\n  - 429s send a `Retry-After` header plus `retry_after` in seconds, counted from the oldest attempt in the window.\n  - `request_id` is also in the server log line. Unexpected errors return 500 `internal` with only the `request_id`, and the stack goes to the log. Error bodies and logs never contain secret values or message text."},{"oldText":"  - `DELETE /api/me` deletes the account's messages, questionnaire, events and memberships, unpairs, and deletes the Clerk user. The App Store requires this for the later Expo app.","newText":"  - `DELETE /api/me` deletes the account's messages, questionnaire, events and memberships, unpairs, and deletes the Clerk user. The App Store requires this for the later Expo app.\n    - **Order:** the database transaction runs first, then the Clerk delete, and both steps are idempotent.\n    - **If Clerk fails:** the response is 502 `account_delete_incomplete` with `retryable: true`. The user can still sign in, and calling DELETE again finishes the job. Any empty row `ensureUser` recreated in between is deleted by that retry."},{"oldText":"- **Age gate:** `POST /api/me/birthdate` sets the birthdate once and returns 403 under 18. An under-18 attempt is stored as `age_blocked=true`, so later attempts also get 403 and a different date can't be retried. All other endpoints return 403 `age_required` until a birthdate is set, except `GET /api/me`. That stays open and reports `birthdate_set`, so the client knows to show the birthdate step.","newText":"- **Age gate:** `POST /api/me/birthdate` sets the birthdate once and returns 403 `age_blocked` under 18. An under-18 attempt is stored as `age_blocked=true`, so later attempts also get 403 `age_blocked` and a different date can't be retried. That code has no self-serve fix, and the client signs the user out. All other endpoints return 403 `age_required` (fix: POST a birthdate) until a birthdate is set, except `GET /api/me`. That stays open and reports `birthdate_set`, so the client knows to show the birthdate step."},{"oldText":"  - `GET /api/messages?cursor=<visible_at>,<id>` lists the couple's messages through one serializer, ordered by `(visible_at, id)`.","newText":"  - `GET /api/messages?cursor=<opaque>` lists the couple's messages through one serializer, ordered by `(visible_at, id)`. The cursor is base64url JSON of `(visible_at, id)`, returned as `next_cursor`. Clients pass it back unchanged and never build it themselves. A bad cursor is 400 `invalid_cursor`."},{"oldText":"    - **Response:** `{messages, pending, server_now}`.","newText":"    - **Response:** `{messages, pending, server_now, next_cursor}`."},{"oldText":"   - **Past either limit:** preview returns 402 `free_translations_used_up`, and the composer switches to sending as written.","newText":"   - **Past either limit:** preview returns 402 `free_translations_used_up` (5 sends used) or `free_previews_used_up` (15 previews used), each with `limit` and `used`, and the composer switches to sending as written with the matching explanation."},{"oldText":"   - **On AI failure:** release the preview reservation and return 503 `translate_failed`.","newText":"   - **On AI failure or the 20-second timeout:** release the preview reservation and return 503 `translate_failed` with `retryable: true` and `detail` \"Nothing was charged or stored.\" The client retries at most twice with backoff, then offers to send as written."},{"oldText":"- `.gitignore` covers `.env*` from the first commit. `.env.example` lists `CLERK_*`, `ANTHROPIC_API_KEY`, `DATABASE_URL` (empty means PGlite under `./.data`), `PREVIEW_TOKEN_SECRET`, `UNDO_WINDOW_SECONDS`, and M2's `STRIPE_*` and `VAPID_*`.\n- `PREVIEW_TOKEN_SECRET` has a development-only default. The app refuses to start without a real value when `NODE_ENV=production`.\n- **Auth seam:** handlers get the user only through `getUserId(req)` in `apps/web/lib/auth.ts`, which wraps Clerk's `auth()`. Handler tests mock this function, so tests never need Clerk.","newText":"- `.gitignore` covers `.env*` from the first commit. `.env.example` lists `CLERK_*`, `ANTHROPIC_API_KEY`, `DATABASE_URL` (empty means PGlite under `./.data`), `PREVIEW_TOKEN_SECRET`, `UNDO_WINDOW_SECONDS`, `DEV_AUTH`, `COACH`, `ANTHROPIC_MODEL`, and M2's `STRIPE_*` and `VAPID_*`.\n- **One env check:** `apps/web/env.ts` validates every variable with zod and is imported from `instrumentation.ts`, so a bad config fails at startup, not on the first request. Each error names the variable and the fix, for example \"Set PREVIEW_TOKEN_SECRET to at least 32 random bytes\". It never prints values.\n  - `PREVIEW_TOKEN_SECRET` has a development-only default and is required in production.\n  - `ANTHROPIC_API_KEY` is required in production.\n  - `UNDO_WINDOW_SECONDS` must be an integer of at least 2 (default 10). Anything else fails the check.\n  - `DEV_AUTH=1` in production fails the check.\n- **Auth seam:** handlers get the user only through `getUserId(req)` in `apps/web/lib/auth.ts`, which wraps Clerk's `auth()`. Handler tests mock this function, so tests never need Clerk.\n- **Dev login (no Clerk needed):** when `DEV_AUTH=1` and `NODE_ENV` isn't production, `getUserId` reads a `dev_user` cookie instead of Clerk.\n  - `/dev/login?as=alice|bob` sets that cookie and goes to `/chat`. Like the other `/dev` routes, it returns 404 in production.\n  - `npm run seed` creates alice and bob, onboarded, adults and paired, with bob on paid, so every feature can be tried in two tabs.\n  - `.env.example` ships with `DEV_AUTH=1` and empty Clerk keys, so a clean checkout runs with no accounts. Clerk keys are needed only to test real sign-up."},{"oldText":"- **Free limit edges:** a 16th preview, or any preview after 5 translated sends, returns 402 `free_translations_used_up`. `GET /api/me` works before the birthdate is set and reports `birthdate_set`.","newText":"- **Free limit edges:** a 16th preview returns 402 `free_previews_used_up`, and any preview after 5 translated sends returns 402 `free_translations_used_up`. `GET /api/me` works before the birthdate is set and reports `birthdate_set`."},{"oldText":"- **Events, E4:** `message_sent`, `message_undone` and `paired` rows are written. `POST /api/events` rejects unknown names and props, and no event row contains message text (checked against the schema).","newText":"- **Events, E4:** `message_sent`, `message_undone` and `paired` rows are written. `POST /api/events` rejects unknown names and props, and no event row contains message text (checked against the schema).\n- **Developer experience:**\n  - Every error response matches the problem+json shape, and every `code` used in the handlers has an anchor in `docs/ERRORS.md` (one test walks the codes).\n  - 429s carry `Retry-After`.\n  - The env check rejects a missing production secret, `DEV_AUTH=1` in production, and `UNDO_WINDOW_SECONDS=abc` or `1`.\n  - The fake coach is refused in production.\n  - `/dev/*` routes return 404 in production.\n  - A bad cursor gets 400 `invalid_cursor`.\n  - A failed Clerk delete returns 502, and a retry completes the deletion."},{"oldText":"1. Workspace, database, auth seam, age gate, questionnaire, pairing.","newText":"1. Workspace, database, env check, `apiError()`, auth seam with dev login and seed, README quickstart, age gate, questionnaire, pairing."},{"oldText":"- **Fixing v1 in place:** rejected because CRA, MongoDB and the Emergent proxy caused the audit findings (see the Step 0 code reuse table).\n","newText":"- **Fixing v1 in place:** rejected because CRA, MongoDB and the Emergent proxy caused the audit findings (see the Step 0 code reuse table).\n\n### Docs (first build commit)\n- `README.md` quickstart, under 5 minutes on a clean checkout with no accounts:\n  1. `npm install`\n  2. `cp .env.example .env.local`\n  3. `npm run seed && npm run dev`\n  4. Open `localhost:3000/dev/login?as=alice` in one browser and `?as=bob` in another (or a private window).\n  - It also lists the Node version (pinned in `engines` and `.nvmrc`), every npm script, how to switch to real Clerk and Anthropic keys, and the deploy steps (`db:migrate`, then `build`).\n- `docs/ERRORS.md`: one anchor per error code, giving its meaning and the fix.\n- `docs/API.md`: the `/api/v1` routes with one copy-paste `curl` each, written for the Expo client.\n"},{"oldText":"- `npm install`, `npm run dev` and `npm test` all work on a clean checkout with only Clerk development keys (the AI falls back to the fake coach without `ANTHROPIC_API_KEY`).","newText":"- `npm install`, `npm run seed`, `npm run dev` and `npm test` all work on a clean checkout with **no accounts**: dev login and the fake coach. The README quickstart reaches alice and bob chatting in under 5 minutes."},{"oldText":"- A manual run in two browsers: sign up, onboarding, pairing, a translated send, the free limit, an as-written send, sharing an original, and coaching for a user set to paid.","newText":"- A manual run in two browsers: sign up through Clerk, onboarding, pairing, a translated send, the free limit, an as-written send, sharing an original, and coaching for a user set to paid with `npm run dev:plan`."}]} -->

### Eng review (autoplan), Step 0: scope challenge
- **Target:** `docs/PLAN.md`, the Implementation plan (eng snapshot `0d61db68…`). It's a greenfield repo with no commits yet. The existing code is the v1 reference in `../app/`.
- **What already exists:**
  - v1 atomic slot reservations (`../app/backend/routes/messages.py:63`, `reset_if_new_day`) and the original-hiding rule (`messages.py:48`, `hide_original`). The plan ports both rules into `packages/core`; the code is rebuilt, not reused, because the stack changes.
  - v1 offline tests (`../app/backend/tests/test_audit_fixes.py`) are the behavioural spec for slots, the age gate and pairing.
- **Minimum change:** build steps 1-3 (the cut line) deliver the M1 goal. Steps 4-5 are deferrable without blocking it.
- **Complexity check:**
  - About 45 new files are estimated: core db, messages, ai, errors and auth, about 18 API routes, about 8 pages, scripts and tests.
  - There are more than 2 new services (`Coach`, `apiError`, the serializer, the env check).
  - That trips the complexity gate. Under autoplan's override ("scope challenge: never reduce, P2") the structure question auto-decides **Original arrangement** (two workspaces, core and web). No smaller arrangement keeps the shared-core-for-Expo goal.
  - **Scope accepted as-is.**
- **Search check:** skipped. Aside wasn't ready, and the patterns are Layer 1 (Drizzle, PGlite, Clerk, RFC 9457, atomic `UPDATE … WHERE`). In-distribution knowledge was used.
- **TODOS cross-reference:** no `TODOS.md` existed; it's created by this review (see below).

**Reality rows**
REALITY: premise-table pass 6 premises checked: Node 26 present, pnpm absent, the v1 hide/slot logic exists, v1 tests exist, PGlite and the SDK options are documented, and the 49-bit code math holds; unverified=1 (Clerk keyless behaviour in the pinned version) docs/PLAN.md:13
REALITY: already-done pass greenfield repo with no commits, so nothing is merged that this plan rebuilds docs/PLAN.md:13
REALITY: surface-check finding SDK `timeout`/`maxRetries` and drizzle-kit `migrate` are known surfaces; the plan's npm scripts are proposals, verified at build time docs/PLAN.md:28
REALITY: binding-decisions pass the decision search is empty; the founder's settled decisions (Expo later, no read receipts, free 5, as-written default) are kept docs/PLAN.md:267
REALITY: numbers pass 120/h is estimated at 2 per minute; 31^10 is about 8.2e14, about 49 bits, re-derived docs/PLAN.md:153
REALITY: deferred-asks pass no linked issue; office-hours asks that were left out are listed under NOT in scope docs/PLAN.md:267
REALITY: pr-count pass no ship-policy, so the default of one PR per wave applies; M1 is one wave docs/PLAN.md:267

### Eng review: dual voices
- **Claude subagent (eng, independent review):** completed. INPUT matched `eng 0d61db68…`. It raised 17 findings: 3 High, 7 Medium and 7 Low.
- **Codex says:** unavailable, because Codex isn't installed.
- **Outside voice (native fallback, Plan agent, 5-minute timer):** completed inside the window, and the timer was stopped. It raised 14 findings: 3 High, 6 Medium and 5 Low. Because it's the same harness, outside coverage is **unavailable**, and there's no CROSS-MODEL line.

```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Architecture sound?               Yes*    N/A    N/A (single voice)
  2. Test coverage sufficient?         Gaps    N/A    N/A
  3. Perf risks + budget/bench named?  Gaps    N/A    N/A
  4. Security threats covered?         Gaps    N/A    N/A
  5. Error paths handled?              Gaps    N/A    N/A
  6. Deployment risk manageable?       Gaps    N/A    N/A
* sound, with fixes to the spend cap, slot accounting and cursor timing.
```
No single-voice Critical was raised.

### Eng review: Section 1, architecture
```
           web browser / Expo (later)
                     │  cookie or Bearer, JSON only (415 otherwise)
                     ▼
  apps/web ── middleware.ts (Clerk, or skipped under DEV_AUTH without keys)
     │   app/api/v1/*  ── getUserId() ── ensureUser (email from session claim)
     │        │                 │
     │        ▼                 ▼
     │   packages/core ── errors.apiError ── messages (preview/send/undo/serializer)
     │        │              │                   │
     │        │              ▼                   ▼
     │        │        ai.Coach ──(fake | Anthropic, 20 s, no retries)
     │        ▼
     │   db (Drizzle) ── PGlite ./.data (dev, lazy, pid lock) | postgres-js → pooler (prod)
     ▼
  pages: /onboarding /pair /chat /settings /dev/login   scripts: seed, db:*, admin:*, report
```
- **Two shapes (design-twice):**
  - A) The domain lives in `packages/core`, and the route handlers are thin.
  - B) The logic lives in the route handlers, and core holds only types.
  - **Pick A:** it hides slot, token and serializer policy behind about 6 functions. B leaks those rules into about 18 handlers, which Expo can't reuse.
- **Red flags found and fixed:**
  - **Split ownership:** the paid check was spread across the serializer, coach and counters. Fixed with `hasPaidAccess`, one owner (O12).
  - **Hand-synced list:** error codes vs `docs/ERRORS.md`. Fixed by the codes-walk test (DX).
  - **Two ways to do one task:** dev scripts vs admin scripts. They're kept on purpose: one hits the dev routes, the other prod SQL.
  - No pass-through or temporal decomposition found.
- **Findings:**
  - [CRITICAL] (confidence: 8/10) docs/PLAN.md:78. The AI cap was count-then-call and never counted previews. **Fixed:** an atomic reservation on the user row (#1).
  - [INFORMATIONAL] (confidence: 7/10) docs/PLAN.md:13. Clerk middleware without keys breaks the no-accounts quickstart. **Fixed** (O1).
  - [INFORMATIONAL] (confidence: 7/10) The messages API after an unpair was undefined. **Fixed:** `GET /api/couples` and `couple_id` (#7).
  - [INFORMATIONAL] (confidence: 6/10) Medium confidence. Serverless connections under polling. **Fixed:** pooler settings and a named default host (#8, O8).
  - [INFORMATIONAL] (confidence: 7/10) No CSRF stance; dev routes gated only on `NODE_ENV`. **Fixed** (#9).
- **Dispositions:** all accepted (auto, P5/P1).

### Eng review: Section 2, code quality
- [CRITICAL] (confidence: 8/10) The undo refund checked the current plan, not what was charged. **Fixed:** `charged_free_slot` plus CHECK constraints (#2).
- [INFORMATIONAL] (confidence: 8/10) The SDK's default retries stretched the 20 s timeout. **Fixed:** `maxRetries: 0` and `maxDuration` (#3).
- [INFORMATIONAL] (confidence: 7/10) Account-deletion foreign keys were undefined. **Fixed:** CASCADE, and `email` isn't unique (#10).
- [INFORMATIONAL] (confidence: 7/10) `GET /api/pair/code` mutated data non-atomically; `pair_attempts` was check-then-insert. **Fixed** (#11, #12).
- [INFORMATIONAL] (confidence: 6/10) `ensureUser` had no email source. **Fixed:** a session claim (O4).
- [INFORMATIONAL] (confidence: 7/10) The env check ran at build time. **Fixed:** it runs only in `register()` (O7).
- [INFORMATIONAL] (confidence: 7/10) A stale PGlite lock told the developer to run reset, which deletes data. **Fixed:** a pid liveness check (#6).
- [INFORMATIONAL] (confidence: 9/10) The seed ran before migrations. **Fixed:** `preseed` (#5).
- [INFORMATIONAL] Stale changelog lines in the CEO accepted block: `preview_nonces`, "build runs migrations", 60/h, sessionStorage. That block is immutable, so the eng accepted block records the supersession.
- **Dispositions:** all accepted.

### Eng review: Section 3, test review
Framework: Vitest (planned). There are no tests yet; this is a greenfield plan.
```
CODE PATHS                                              USER FLOWS
[+] core/messages                                        [+] Free user first message
  ├── reservePreview()                                     ├── [★★★ PLANNED] preview → send → delivered
  │   ├── [★★★] paired cap 15, unpaired cap 3 (O6)           ├── [★★★ PLANNED] 6th send → as_written only
  │   └── [★★★] release on AI fail/timeout (#3)             └── [GAP→PLANNED] [→E2E] two-tab quickstart smoke
  ├── send()                                             [+] Heated message
  │   ├── [★★★] token verify, timingSafeEqual, replay 409    ├── [★★ PLANNED] breath step event
  │   ├── [★★★] charged_free_slot set (#2)                  └── [★★ PLANNED] save for later → drafts
  │   ├── [★★★] safety token → 422                         [+] Undo
  │   └── [★★★] lock_timeout → 503 busy (#4, CI PG)        ├── [★★★ PLANNED] undo inside window, re-send same token
  ├── undo()  [★★★] margin 1 s, refund only if charged     └── [★★★ PLANNED] undo at edge → 409
  ├── serializer [★★★] hasPaidAccess, pending, cursor    [+] Pairing
  └── list(couple_id) [★★★] active default, 404 not_paired   ├── [★★★ PLANNED] link → sign-up → onboarding → pair
[+] core/ai Coach  [★★ PLANNED] fake fixtures + safety        ├── [★★★ PLANNED] questionnaire_required 403 (O11)
[+] core/errors    [★★★] problem+json shape, codes walk       └── [★★★ PLANNED] concurrent pair (CI PG)
[+] limits.reserveAiCall [★★★] 150 parallel → 120 (CI PG)  [+] Account
[+] auth getUserId [★★★] DEV_AUTH cookie, prod 404, no-keys boot  └── [★★★ PLANNED] delete → cascade → 502 retry
[+] env.ts [★★★] missing prod vars, build skip
LLM integration: [→EVAL] translate/coach prompts: live eval script, not in CI (Safety section)

COVERAGE (planned): 31/32 paths with a ★★+ test   QUALITY: ★★★ 27  ★★ 4   GAPS: 1 (live-model eval, deferred)
```
- **Value cards:** they're in the test-plan artifact for each critical path and edge case.
- **Regression rule:** v1 behaviour being ported has explicit contracts in this plan, so no unapproved regression risk remains:
  - free 5
  - originals hidden from free recipients
  - age gate
  - pair single-use
- **Tests made obsolete:** none (there's no v2 code yet).
- **Test plan artifact:** `~/.gstack/projects/v2/Refined-unknown-eng-review-test-plan-20261117-*.md`.
- **Dispositions:**
  - The eval gap is deferred: a live-model eval needs a real key and spend, and the fake fixtures cover the safety logic (P3).
  - All other gaps are accepted into the plan's Tests section.

### Eng review: Section 4, performance
- **The polling hot path:** `GET /api/messages`.
  - Load is 1 indexed range query per poll. At 1,000 couples × 2 tabs / 5 s that's about 400 req/s [estimated].
  - Index `(couple_id, visible_at, id)` covers it, and `pending` is bounded by the undo window (at most a few rows).
  - **Budget:** p95 under 50 ms server time [estimated; re-measure before M2 realtime]. M2 realtime replaces polling.
- **AI calls:** up to 20 s each, bounded by `maxDuration=30` and 120 per user per hour.
- **Rate-limit counts:** `events(user_id, name, created_at)` index (#8). The AI cap moved to a user-row counter, so there's no count query on that path.
- **Tests:** one migrated PGlite per file plus rollback per test (O13).
- **Dispositions:** accepted. No benchmark step is added for M1 (the measured load is 3 testers); revisit with realtime.

<!-- autoplan-accepted:eng -->
- AI cap: 120 calls per user per hour (supersedes 60), reserved atomically on `users.ai_window_start`/`ai_calls_in_window` before the call; failed calls count; `Retry-After` from the window; 150-parallel CI test reserves exactly 120.
- `messages.charged_free_slot` set at insert; undo and unpair refund only when true; CHECK 0..5 and 0..15 on the counters; tests for paid-to-free undo and unpair refund.
- Anthropic client `timeout: 20_000`, `maxRetries: 0`; AI routes `maxDuration = 30`; hang test releases the reservation.
- `visible_at` uses `clock_timestamp()` on the send transaction's last statement with `SET LOCAL lock_timeout = '1s'` (503 `busy`, retryable); undo requires `clock_timestamp() < visible_at - 1s`; CI Postgres lock test.
- `preseed` runs migrations; PGlite client opens lazily; stale `.lock` with a dead pid is removed; live lock says "stop pid N" (no reset advice); tests.
- `GET /api/couples`; `GET /api/messages?couple_id=` defaults to the active couple, past couples read-only, 404 `not_paired`; per-couple cursor; tests.
- Production `DATABASE_URL` is a transaction-mode pooler with `prepare: false`, `max: 1`; default host Vercel + Neon pooled; `events(user_id, name, created_at)` index.
- Mutating routes require `application/json` (415); `/api/dev/*` and `/dev/*` need `DEV_AUTH=1` and non-production; tests.
- Foreign keys `ON DELETE CASCADE` from users; `DELETE /api/me` deletes the users row; `email` not unique; `pair_code` unique; test.
- `GET /api/pair/code` rotates atomically; `POST /api/pair` inserts the attempt before counting and returns 403 `questionnaire_required` until both questionnaires exist; tests.
- Preview token checked with `timingSafeEqual`; token binds the sender, not the couple (documented); parallel-send test mints tokens with the test secret.
- With `DEV_AUTH=1` and empty Clerk keys, middleware skips `clerkMiddleware` and the layout omits `ClerkProvider`; boot smoke test.
- `ensureUser` takes email from a Clerk session-token claim and refreshes it when it changes.
- `npm run admin:report` and `npm run admin:plan -- <email> free|paid` run against production `DATABASE_URL`, refuse an empty URL and print the target host; test.
- Unpaired users can use only 3 of the 15 free previews (402 `free_previews_used_up`, `limit: 3`); test.
- `env.ts` validates only from `register()`, skipped during `next build`; `next build` with no production env succeeds.
- `hasPaidAccess(user, couple)` in `packages/core` is the only paid check (M1: `user.plan === 'paid'`); grep test.
- Tests migrate one PGlite per file and roll back a transaction per test.
- `/pair` carries the code only in `redirect_url` (no sessionStorage), surviving email verification in a new tab.
- Supersedes in the CEO block: `preview_nonces` table (dropped), "build runs migrations" (now `db:migrate`), 60 AI calls per hour (now 120), sessionStorage for invites (now `redirect_url`).
- Alternatives considered lists "one Postgres everywhere" as TASTE d7.
<!-- /autoplan-accepted:eng -->

### Eng review: outside voice, cross-model tension
- **TASTE, to the gate:**
  - **O3 (notifications in M1)** strengthens the existing d5: without a ping, the M1 metric can't tell product failure from delivery failure.
  - **O9 (too much machinery)** strengthens d6 and adds **d7: one Postgres everywhere** (Docker or a free hosted branch) instead of PGlite. That would remove the lock, the one-process rule, the dev-route scripts and the race-test skip.
  - The plan keeps PGlite, because the founder's DX goal is no installs or accounts.
- **Mechanical, applied:** O1, O2, O4, O5 (cap raised to 120/h), O6, O7, O8, O11, O12, O13 and O14. O10 was already applied (#11).

### Eng review: failure modes
| Path | Realistic failure | Test | Handling | User sees | Critical gap |
|---|---|---|---|---|---|
| preview | Anthropic 20 s timeout | yes | 503 retryable, released | "Try again or send as written" | no |
| send | user-row lock wait | yes (CI PG) | 503 `busy` | retry toast | no |
| poll | pooler exhausted | no | 500 `internal` + request_id | stale chat, retries | no (handled, visible) |
| undo | lands after recipient fetched | yes | 1 s margin, 409 | "Already delivered" | no |
| delete me | Clerk API down | yes | 502 retryable | "Try again" | no |
| dev db | stale lock | yes | auto-removed | nothing | no |
| deploy | migration fails mid-way | manual | per-file transaction, rerun | deploy stops | no |

**Critical gaps: 0.**

### Eng review: required outputs
- **NOT in scope:**
  - Realtime and push (M2).
  - A live-model eval in CI (needs spend).
  - Benchmarks (3 testers).
  - Stripe (M2, d4).
  - Email notifications: d5, which decides this at the gate.
  - Replacing PGlite: d7, at the gate.
- **What already exists:**
  - The v1 rules (`../app/backend/routes/messages.py:48`, `:63`) and the v1 tests as the behaviour spec.
  - The design tokens in v1's `design_guidelines.json`.
  - The Clerk theme from v1.
- **Parallelization:** sequential implementation, no parallelization opportunity.
  - Steps 2-5 all depend on `packages/core`'s db and errors from step 1.
  - After step 2, steps 3 and 4 touch disjoint routes but share `core/messages`, so they run sequentially.
- **TODOS.md:** auto-written:
  - E5, recipient asks for the original.
  - E6, the PWA manifest.
  - A changelog and API deprecation policy before the first Expo build.
  - A live-model eval script.
  - Revisiting the poll budget with realtime.

**Implementation tasks (eng-review):**
- [ ] **T1 (P1, human ~2h / CC ~10min):** core/limits. Add the atomic 120/h AI reservation plus Retry-After. Verify: the 150-parallel CI test.
- [ ] **T2 (P1, human ~1h / CC ~10min):** core/messages. Add `charged_free_slot`, CHECKs, refund on undo and unpair. Verify: the tests in Eng review additions.
- [ ] **T3 (P1, human ~30min / CC ~5min):** core/ai. Set `maxRetries: 0`, 20 s, `maxDuration=30`. Verify: the hang test.
- [ ] **T4 (P1, human ~1h / CC ~10min):** core/messages. Use `clock_timestamp()` for `visible_at`, `lock_timeout`, 503 `busy`, and the 1 s undo margin. Verify: CI PG.
- [ ] **T5 (P1, human ~2h / CC ~15min):** apps/web auth. Skip Clerk without keys, the email claim, JSON-only 415, and the DEV_AUTH gate on dev routes. Verify: the no-keys boot smoke test.
- [ ] **T6 (P2, human ~2h / CC ~15min):** API. Add `GET /api/couples`, `couple_id`, `questionnaire_required`, `hasPaidAccess`, the atomic pair code, and insert-first pair attempts. Verify: handler tests.
- [ ] **T7 (P2, human ~1h / CC ~10min):** scripts. Add `preseed`, the stale-lock check, the lazy client, `admin:report`, `admin:plan`, and the env check in `register()`. Verify: `next build` with an empty env.
- [ ] **T8 (P2, human ~30min / CC ~5min):** schema. Add FK cascades, the `events` index, the unique `pair_code`, and the unpaired 3-preview cap. Verify: migration test.

### Eng decision audit trail
| # | Phase | Decision | Class | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 39 | Eng | Structure: original two-workspace arrangement | Mechanical | P2 | No smaller shape keeps the core shared with Expo | collapse into web |
| 40 | Eng | Atomic AI-call reservation on the user row | Mechanical | P5 | Count-then-call overshoots under parallel requests | events count |
| 41 | Eng | `charged_free_slot` and CHECK constraints | Mechanical | P1 | Refund what was charged, not what the plan says now | infer from plan |
| 42 | Eng | SDK `maxRetries: 0`, `maxDuration` 30 | Mechanical | P5 | Keeps the 20 s promise true | default retries |
| 43 | Eng | `clock_timestamp()` `visible_at` and `lock_timeout` 1 s | Mechanical | P1 | Cursor correctness under lock waits | poll grace window |
| 44 | Eng | `GET /api/couples` and `couple_id` | Mechanical | P5 | Defines history after unpair | one cross-couple feed |
| 45 | Eng | JSON-only 415 and DEV_AUTH on dev routes | Mechanical | P1 | CSRF and staging safety | origin check only |
| 46 | Eng | FK cascade on account delete | Mechanical | P1 | Privacy, App Store | soft delete |
| 47 | Eng | Skip Clerk without keys under DEV_AUTH | Mechanical | P1 | The Done criterion was unreachable | require keys |
| 48 | Eng | `admin:report` and `admin:plan` against prod | Mechanical | P1 | The M1 metric must be readable on deploy | raw SQL by hand |
| 49 | Eng | AI cap 120/h (supersedes 60) | Mechanical | P1 | A heated exchange needs about 1 per minute | 60/h |
| 50 | Eng | Unpaired preview cap 3 | Mechanical | P1 | Keeps the free allowance for real sends | uncapped |
| 51 | Eng | Env check only in `register()` | Mechanical | P5 | Builds without production secrets | import-time check |
| 52 | Eng | `hasPaidAccess` single owner | Mechanical | P4 | M2 couple access changes one function | inline checks |
| 53 | Eng | O3 notifications in M1 | Taste (d5) | P1 vs P3 | Outside voice: the metric is blind without a ping | — |
| 54 | Eng | O9 one Postgres everywhere | Taste (d7) | P5 vs founder DX | Removes 4 mechanisms, but adds Docker or an account | — |

### Eng review: completion summary
- Step 0: Scope Challenge — scope accepted as-is.
- Reality rows: 7/7 applicable rows emitted, 1 unverified premise.
- Architecture Review: 5 issues found.
- Code Quality Review: 9 issues found.
- Test Review: diagram produced, 1 gap identified (live eval, deferred).
- Performance Review: 2 issues found.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 5 items, auto-written.
- Failure modes: 0 critical gaps flagged.
- Unresolved decisions: 0 in this review. d5 and d7 are taste calls at the final gate.
- Outside voice: Codex unavailable (not installed). The native Plan-agent fallback completed. Outside coverage is unavailable.
- Parallelization: 0 lanes, sequential.
- Lake Score: N/A, because there were no completeness-scored answers (all auto-decided).

<!-- autoplan-baseline-edits:eng {"sourceSha256":"2b8ebdf4efcd5f877638c39e237e4b22eba6bc1af0c8967c1cff1e800fc95776","replacements":[{"oldText":"- **Database:** Postgres through Drizzle ORM. Local development and tests use **PGlite** (embedded Postgres, no install). Production uses `postgres-js` against hosted Postgres via `DATABASE_URL`. Migrations come from drizzle-kit and are committed.\n  - **Migrations:** `npm run dev` runs them against `./.data` before starting (a `predev` script), and the test setup runs them on each fresh in-memory PGlite.","newText":"- **Database:** Postgres through Drizzle ORM. Local development and tests use **PGlite** (embedded Postgres, no install). Production uses `postgres-js` against hosted Postgres via `DATABASE_URL`, which must point at a transaction-mode pooler (`prepare: false`, `max: 1` per function), because serverless polling would otherwise exhaust connections. Default host: Vercel with Neon's pooled URL (the founder can swap it; only the URL changes). Migrations come from drizzle-kit and are committed.\n  - **Migrations:** `npm run dev` runs them against `./.data` before starting (a `predev` script), and the test setup runs them once per test file on an in-memory PGlite (see Tests)."},{"oldText":"    - The client writes `./.data/.lock` with its pid on open. A second opener exits non-zero with: \"./.data is in use by pid N. Stop that process, or run `npm run db:reset`.\"\n    - `npm run report:events` and `npm run dev:plan -- <email> free|paid` are thin scripts that call those routes on `http://localhost:3000`. If the dev server is down, they exit 1 with \"Start `npm run dev` first.\"\n  - **Production migrations:** a separate `npm run db:migrate` (drizzle-kit migrate against `DATABASE_URL`). `npm run build` is only `next build`, so a preview build can never migrate production. The production deploy runs `npm run db:migrate && npm run build`. A failed migration rolls back its own file (drizzle runs each file in a transaction). Fix the migration and run it again.","newText":"    - The client opens lazily on the first query (so `next build` workers never open it) and writes `./.data/.lock` with its pid. If the lock names a dead pid (`process.kill(pid, 0)` fails), the stale lock is removed. If the pid is alive, the opener exits non-zero with: \"./.data is in use by pid N (another dev server or script). Stop that process and try again.\"\n    - `npm run report:events` and `npm run dev:plan -- <email> free|paid` are thin scripts that call those routes on `http://localhost:3000`. If the dev server is down, they exit 1 with \"Start `npm run dev` first.\"\n    - **Against production** (hosted Postgres, so a separate process is safe): `npm run admin:report` runs the same read-only report query, and `npm run admin:plan -- <email> free|paid` sets a tester's plan. Both connect with `DATABASE_URL` from the founder's machine, refuse a PGlite (empty) URL, and print the target host before acting. This is how the M1 metric is read from the deployed app.\n  - **Production migrations:** a separate `npm run db:migrate` (drizzle-kit migrate against `DATABASE_URL`). `npm run build` is only `next build`, so a preview build can never migrate production. The production deploy runs `npm run db:migrate && npm run build`. A failed migration rolls back its own file (drizzle runs each file in a transaction). Fix the migration and run it again.\n  - **`npm run seed`** runs migrations first (`preseed`), so it works on a clean checkout."},{"oldText":"- **Auth:** `@clerk/nextjs`. The `clerkMiddleware` and `auth()` calls accept web session cookies and mobile `Authorization: Bearer` tokens on the same `/api/*` handlers. A user row is created lazily on the first authenticated request (`ensureUser`).","newText":"- **Auth:** `@clerk/nextjs`. The `clerkMiddleware` and `auth()` calls accept web session cookies and mobile `Authorization: Bearer` tokens on the same `/api/*` handlers. A user row is created lazily on the first authenticated request (`ensureUser`). Its email comes from a Clerk session-token custom claim (`email`), so no Backend API call is needed. It's refreshed whenever the claim differs from the stored value.\n  - **Dev without keys:** when `DEV_AUTH=1` and the Clerk keys are empty, `middleware.ts` skips `clerkMiddleware` and the root layout renders without `ClerkProvider`, so Clerk never throws or enters keyless mode and makes no network calls. A smoke test boots the app with empty Clerk env."},{"oldText":"  - `ANTHROPIC_MODEL` overrides the model ID. Every AI call has a 20-second timeout.","newText":"  - `ANTHROPIC_MODEL` overrides the model ID. The client is created with `timeout: 20_000` and `maxRetries: 0` (the SDK retries twice by default, which would stretch 20 s to about 60 s). AI routes set `maxDuration = 30`, so the platform never kills a request before the reservation is released."},{"oldText":"- **Tests:** Vitest for `packages/core` and for API route handlers, which are called directly against a fresh PGlite per test. Typecheck, lint and tests run in GitHub Actions.","newText":"- **Tests:** Vitest for `packages/core` and for API route handlers, which are called directly against PGlite. Each test file migrates one PGlite once, and each test runs inside a transaction that is rolled back, so the suite stays fast as it grows. Typecheck, lint and tests run in GitHub Actions."},{"oldText":"  - `age_blocked` (bool)","newText":"  - `age_blocked` (bool)\n  - `ai_window_start`, `ai_calls_in_window`: the per-user AI cap (see Limits)\n  - CHECK constraints keep `free_translations_used` within 0..5 and `free_previews_used` within 0..15, so a bad refund fails loudly instead of going negative.\n  - `pair_code` has a unique index. `email` is not unique (Clerk owns identity), so a re-signup after deletion is never blocked."},{"oldText":"  - `change_summary`, `heated` (bool), `original_shared` (bool)","newText":"  - `change_summary`, `heated` (bool), `original_shared` (bool)\n  - `charged_free_slot` (bool): set at insert when the send consumed a free translation. Undo and unpair refund only when this is true, never by looking at the current plan."},{"oldText":"  - `visible_at`: set on insert by the app's SQL as `now() + make_interval(secs => $UNDO_WINDOW_SECONDS)`, using the database clock. The default window is 10 seconds (E1), and the minimum is 2 seconds. Even with undo cut, a short window keeps a slow commit from landing behind a poller's cursor. The column has no default of its own. Index `(couple_id, visible_at, id)`.\n- **`events`:** `id`, `user_id`, `couple_id` (nullable), `name` (enum), `props` (jsonb validated per event name, never message text), `created_at`.","newText":"  - `visible_at`: set on insert by the app's SQL as `clock_timestamp() + make_interval(secs => $UNDO_WINDOW_SECONDS)`, using the database clock at the moment of the insert (not the transaction start). The insert is the send transaction's last statement, and the transaction runs with `SET LOCAL lock_timeout = '1s'`. A send that would wait longer fails with 503 `busy` (`retryable: true`) instead of committing a `visible_at` that is already behind a poller's cursor. The default window is 10 seconds (E1), and the minimum is 2 seconds. Even with undo cut, a short window keeps a slow commit from landing behind a poller's cursor. The column has no default of its own. Index `(couple_id, visible_at, id)`.\n- **`events`:** `id`, `user_id`, `couple_id` (nullable), `name` (enum), `props` (jsonb validated per event name, never message text), `created_at`. Index `(user_id, name, created_at)`.\n- **Foreign keys:** every `user_id` / `sender_id` references `users(id) ON DELETE CASCADE`, and `couple_members.couple_id` references `couples`. Deleting a user removes their messages from both people's history, which is the privacy choice the App Store expects."},{"oldText":"  - 429s send a `Retry-After` header plus `retry_after` in seconds, counted from the oldest attempt in the window.","newText":"  - 429s send a `Retry-After` header plus `retry_after` in seconds: for pairing, from the oldest attempt in the hour; for AI calls, from the end of the fixed window."},{"oldText":"  - Every user is limited to 60 AI calls per hour (preview plus coach), counted in the `events` table, with 429 `ai_rate_limited` above that. This bounds paid spend.","newText":"  - Every user is limited to 120 AI calls per hour (preview plus coach), with 429 `ai_rate_limited` above that. That's 2 a minute, enough for a heated back-and-forth, and still bounds paid spend.\n    - The call is reserved **before** calling the AI with one atomic statement on the user row: a fixed one-hour window that resets `ai_window_start` and `ai_calls_in_window` when the window has passed, and otherwise increments only `WHERE ai_calls_in_window < 120`. Parallel requests can't overshoot.\n    - `Retry-After` is `ai_window_start + 1 hour - now()`. A failed AI call still counts (it cost money or time).\n- **CSRF:** mutating routes accept only `Content-Type: application/json` (415 `unsupported_media_type` otherwise), so a cross-site form post can't carry the session cookie past a CORS preflight.\n- **Dev routes** (`/api/dev/*`, `/dev/*`) need both `NODE_ENV !== 'production'` and `DEV_AUTH=1`."},{"oldText":"    - **Order:** the database transaction runs first, then the Clerk delete, and both steps are idempotent.","newText":"    - **Order:** the database transaction runs first (it deletes the `users` row, and the foreign keys cascade to messages, questionnaire, events and memberships), then the Clerk delete. Both steps are idempotent."},{"oldText":"  - `GET /api/pair/code` returns the current code, rotated when it has expired.\n  - `POST /api/pair` with `{code}` checks the rate limit, then creates the couple in one transaction. Unique indexes reject a second active couple. Errors, each mapped to its `/pair` page message:","newText":"  - `GET /api/pair/code` returns the current code. An expired code is rotated atomically (`UPDATE … WHERE pair_code_expires_at < now() RETURNING`), so two concurrent GETs agree on one code.\n  - `POST /api/pair` with `{code}` inserts the attempt first, then counts the hour's attempts (so parallel guesses can't skip the limit), then creates the couple in one transaction. Unique indexes reject a second active couple. Errors, each mapped to its `/pair` page message:"},{"oldText":"    | 403 | `age_required` | No birthdate set yet |","newText":"    | 403 | `age_required` | No birthdate set yet |\n    | 403 | `questionnaire_required` | Either person hasn't finished the questionnaire |"},{"oldText":"    - Both people keep read-only access to their past messages, and pending messages are deleted.","newText":"    - Both people keep read-only access to their past messages, and pending messages are deleted. Deleted pending messages refund their free slot when `charged_free_slot` is true."},{"oldText":"  - `GET /api/messages?cursor=<opaque>` lists the couple's messages through one serializer, ordered by `(visible_at, id)`. The cursor is base64url JSON of `(visible_at, id)`, returned as `next_cursor`. Clients pass it back unchanged and never build it themselves. A bad cursor is 400 `invalid_cursor`.","newText":"  - `GET /api/couples` lists the user's couples, active and past, with partner name and dates.\n  - `GET /api/messages?couple_id=&cursor=<opaque>` lists one couple's messages. `couple_id` defaults to the active couple. Past couples are read-only, and with no active couple and no `couple_id` the response is 404 `not_paired`. The cursor is per couple. It lists the messages through one serializer, ordered by `(visible_at, id)`. The cursor is base64url JSON of `(visible_at, id)`, returned as `next_cursor`. Clients pass it back unchanged and never build it themselves. A bad cursor is 400 `invalid_cursor`."},{"oldText":"    - The recipient sees only messages with `visible_at <= now()` (database clock). They get `original_text` only when `original_shared && recipient.plan === 'paid'`, and otherwise just `original_shared`.","newText":"    - The recipient sees only messages with `visible_at <= now()` (database clock). They get `original_text` only when `original_shared && hasPaidAccess(recipient, couple)`, and otherwise just `original_shared`. `hasPaidAccess` in `packages/core` is the single paid check for the serializer, coach and translation counters. In M1 it is `user.plan === 'paid'`, and M2 changes only this function to cover couple-level access."},{"oldText":"  - `DELETE /api/messages/:id` is undo (E1). The sender can use it while `now() < visible_at`.\n    - In one transaction, it hard-deletes the row, which frees the nonce with it. If the row was a free user's translated send, it also runs `free_translations_used = free_translations_used - 1`, so re-sending the same preview doesn't charge twice.","newText":"  - `DELETE /api/messages/:id` is undo (E1). The sender can use it while `clock_timestamp() < visible_at - interval '1 second'`. The 1-second margin keeps an undo from landing after a recipient poll already returned the message.\n    - In one transaction, it hard-deletes the row, which frees the nonce with it. If `charged_free_slot` is true, it also runs `free_translations_used = free_translations_used - 1`, so re-sending the same preview doesn't charge twice."},{"oldText":"   - **Unpaired users** can preview using neutral default traits, so the composer shows its value before the partner joins.","newText":"   - **Unpaired users** can preview using neutral default traits, so the composer shows its value before the partner joins. Only 3 of the 15 free previews can be used while unpaired (`free_previews_used < 3` is added to the reservation when there is no active couple, 402 `free_previews_used_up` with `limit: 3`), so the allowance survives until the partner arrives."},{"oldText":"   - **The token** is an HMAC over `{user_id, sha256(text), delivered_text, change_summary, heated, safety, nonce, exp}` and expires after 15 minutes. At send, the server reads `heated`, `safety`, `delivered_text` and `change_summary` from the verified token, never from the client.","newText":"   - **The token** is an HMAC over `{user_id, sha256(text), delivered_text, change_summary, heated, safety, nonce, exp}` and expires after 15 minutes. At send, the server reads `heated`, `safety`, `delivered_text` and `change_summary` from the verified token, never from the client.\n   - The HMAC is checked with `timingSafeEqual`. The token binds the sender, not the couple: a preview made before pairing (neutral traits) can still be sent after pairing, which is accepted."},{"oldText":"  - **Signed out:** the code is saved to sessionStorage, and the visitor chooses Sign up or Sign in. Both carry `redirect_url=/pair?code=XXXX`, so `/pair` routes them by their state after auth.","newText":"  - **Signed out:** the visitor chooses Sign up or Sign in. Both carry `redirect_url=/pair?code=XXXX`, so the code survives email verification in a new tab (no sessionStorage), and `/pair` routes them by their state after auth."},{"oldText":"- **Invite link, E2:** `/pair?code=` works for signed-out visitors through sign-up and onboarding, using sessionStorage and `redirect_url`. There's also a message for users who are already paired, a message for expired or used codes, and a \"Copy invite link\" button in onboarding and settings. Codes last 7 days and work once, and the rate limit applies.","newText":"- **Invite link, E2:** `/pair?code=` works for signed-out visitors through sign-up and onboarding, carried in `redirect_url`. There's also a message for users who are already paired, a message for expired or used codes, and a \"Copy invite link\" button in onboarding and settings. Codes last 7 days and work once, and the rate limit applies."},{"oldText":"- **One env check:** `apps/web/env.ts` validates every variable with zod and is imported from `instrumentation.ts`, so a bad config fails at startup, not on the first request. Each error names the variable and the fix, for example \"Set PREVIEW_TOKEN_SECRET to at least 32 random bytes\". It never prints values.","newText":"- **One env check:** `apps/web/env.ts` validates every variable with zod. It runs only from `register()` in `instrumentation.ts` at server start, never at module import, and is skipped during `next build` (`NEXT_PHASE === 'phase-production-build'`), so CI and preview builds need no production secrets. A bad config fails at startup, not on the first request. Each error names the variable and the fix, for example \"Set PREVIEW_TOKEN_SECRET to at least 32 random bytes\". It never prints values."},{"oldText":"- **Limits:** text over 4000 characters gets 400, and the 61st AI call in an hour gets 429 `ai_rate_limited`.","newText":"- **Limits:** text over 4000 characters gets 400, and the 121st AI call in an hour gets 429 `ai_rate_limited`."},{"oldText":"- **Events, E4:** `message_sent`, `message_undone` and `paired` rows are written. `POST /api/events` rejects unknown names and props, and no event row contains message text (checked against the schema).","newText":"- **Events, E4:** `message_sent`, `message_undone` and `paired` rows are written. `POST /api/events` rejects unknown names and props, and no event row contains message text (checked against the schema).\n- **Eng review additions:**\n  - 150 parallel AI calls for one user reserve exactly 120, and the 121st gets 429 with `Retry-After` (CI Postgres).\n  - An undo after the user switches from paid to free refunds nothing, because `charged_free_slot` is false. Unpair refunds pending charged sends. The CHECK constraints reject a negative counter.\n  - The AI client is built with `maxRetries: 0`, and a fake that hangs past 20 s returns 503 `translate_failed` with the reservation released.\n  - A send blocked on the user row lock for more than 1 s returns 503 `busy` (CI Postgres).\n  - A mutating route with `text/plain` gets 415. `/api/dev/*` returns 404 without `DEV_AUTH=1`.\n  - Two concurrent `GET /api/pair/code` calls after expiry return the same code. Parallel pair attempts can't exceed 10 per hour.\n  - After an unpair, `GET /api/messages` without `couple_id` returns 404 `not_paired`, the old couple is readable through `couple_id`, and `GET /api/couples` lists it.\n  - `DELETE /api/me` cascades through the foreign keys, and a later `ensureUser` with the same email works.\n  - A stale `.lock` with a dead pid is removed. A live one gives the \"stop pid N\" error.\n  - The parallel-send test mints tokens directly with the test `PREVIEW_TOKEN_SECRET`, because a free user only gets 15 previews.\n- **Outside-voice additions:**\n  - The app boots and serves `/dev/login` with empty Clerk keys and `DEV_AUTH=1`.\n  - `next build` succeeds with no production env.\n  - The 4th unpaired preview gets 402 with `limit: 3`, and pairing unlocks the rest.\n  - `POST /api/pair` before the questionnaire gets 403 `questionnaire_required`.\n  - `hasPaidAccess` is the only paid check (lint rule or grep test: no other `plan === 'paid'`).\n  - `admin:plan` refuses an empty `DATABASE_URL`."},{"oldText":"- **Mobile first with Expo:** web first was chosen, so M1 can reach testers with a link. `packages/core` and the API keep Expo cheap later.","newText":"- **Mobile first with Expo:** web first was chosen, so M1 can reach testers with a link. `packages/core` and the API keep Expo cheap later.\n- **One Postgres everywhere instead of PGlite** (outside voice, eng): removes the lock file, the one-process rule, the dev-route scripts and the race-test skip, but needs Docker or a hosted database account. Queued as TASTE d7."}]} -->

### Final gate (owner answer, 2026-11-17)
- Reply: `rec`, so d1-d7 take option a and p1 is approved, plus two founder revisions applied to the Implementation plan:
  - **Share outside the app** (a revision of d2): it doesn't replace the in-app chat. It's a premium feature beside it, with 5 free shares and then an upgrade. It's built through `POST /api/messages/share-out` with an atomic `free_shares_used < 5` reservation, `navigator.share` or a clipboard fallback, the `message_shared_out` event, and tests.
  - **Free translated messages: 10 instead of 5.** The preview cap scales to 30, about 3 per message. The unpaired preview cap is 5, which matches the free shares.
- **Re-check (parent, inline):** share-out reuses the preview-token verification and the atomic-reservation pattern already reviewed. No new infrastructure. The tests are listed under "Final gate additions". The CEO, DX and Eng phases were not re-run as subagent passes, because the change is in the blast radius of the reviewed patterns (P2, P6).
