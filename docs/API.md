# API v1

Base: `/api/v1`. JSON in and out; writes need `Content-Type: application/json`. Auth: the web session cookie, or
`Authorization: Bearer <Clerk session token>` from mobile. Errors are problem+json ([codes](ERRORS.md)). The zod
schemas in `packages/core` are the contract; a breaking change ships as `/api/v2`.

Local examples use dev login: `curl -c jar "localhost:3000/dev/login?as=alice"`, then `-b jar` on each call.

| Route | Body | Returns |
|---|---|---|
| `GET /me` | | user, plan, free counts left, `birthdate_set`, `questionnaire_done`, couple |
| `PATCH /me` | `{display_name?, timezone?, share_traits?}` | user |
| `DELETE /me` | | `{ok}` (deletes all your data, then the sign-in) |
| `POST /me/birthdate` | `{birthdate: "YYYY-MM-DD"}` | user, or 403 `age_blocked` |
| `GET /questionnaire` | | `{questions}` |
| `PUT /questionnaire` | `{answers: {q1: "value", q9: ["a","b"]}, share_traits}` | `{ok}` |
| `GET /pair/code` | | `{code, expires_at}` |
| `POST /pair` | `{code}` | `{couple_id, partner_name}` |
| `DELETE /pair` | | `{ok}` |
| `GET /couples` | | `{couples: [{id, partner_name, active, ended_at}]}` |
| `GET /messages?couple_id=&cursor=` | | `{messages, pending, server_now, next_cursor}` |
| `POST /messages/preview` | `{text}` | `{delivered_text, change_summary, heated, safety, preview_token, alternatives: [{text, preview_token}], advice}`. `advice` is for the sender only; send or share any version with its own token. |
| `POST /messages` | `{text, mode: "translated"\|"as_written", preview_token?}` | message |
| `DELETE /messages/:id` | | undo inside the window: `{text, mode, refunded}` |
| `POST /messages/:id/share` | `{shared}` | share your original with your partner |
| `POST /messages/share-out` | `{text, preview_token}` | `{share_text}` for the OS share sheet |
| `POST /coach` | `{text}` | `{landing, swaps, encouragement, safety}` (paid) |
| `POST /events` | `{name, props}` | client events: `breath_step`, `invite_copied`, `invite_opened`, `upgrade_clicked` |

```bash
curl -b jar localhost:3000/api/v1/me
curl -b jar -H 'content-type: application/json' -d '{"text":"You never listen!"}' localhost:3000/api/v1/messages/preview
curl -b jar -H 'content-type: application/json' -d '{"text":"You never listen!","mode":"translated","preview_token":"<token>"}' localhost:3000/api/v1/messages
curl -b jar "localhost:3000/api/v1/messages?cursor=<next_cursor>"
curl -b jar -X DELETE localhost:3000/api/v1/messages/<id>
curl -b jar -H 'content-type: application/json' -d '{"text":"You never listen!","preview_token":"<token>"}' localhost:3000/api/v1/messages/share-out
```

Poll `GET /messages` every 5 s while visible (30 s hidden), always passing back `next_cursor`. Count the undo
timer from `visible_at - server_now`, not the device clock.
