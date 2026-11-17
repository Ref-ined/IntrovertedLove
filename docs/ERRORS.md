# Error codes

Every error is `application/problem+json`:

```json
{ "type": "/docs/errors#<code>", "title": "...", "status": 402, "code": "free_translations_used_up",
  "detail": "...", "retryable": false, "request_id": "a1b2c3d4", "limit": 10, "used": 10 }
```

`code` is stable. Give `request_id` when you report a problem. 429s also send a `Retry-After` header.

| Code | Status | Meaning | Fix |
|---|---|---|---|
| <a id="invalid_input"></a>`invalid_input` | 400 | The body failed validation; `fields` lists each problem. | Fix the named fields and send again. |
| <a id="invalid_cursor"></a>`invalid_cursor` | 400 | The `cursor` wasn't one the API returned. | Pass `next_cursor` back unchanged, or omit it. |
| <a id="invalid_token"></a>`invalid_token` | 400 | The preview token is missing, expired (15 min), tampered with, or for different text. | Preview the message again. |
| <a id="own_code"></a>`own_code` | 400 | You entered your own pair code. | Send your code to your partner instead. |
| <a id="unauthenticated"></a>`unauthenticated` | 401 | No signed-in user. | Sign in (cookie) or send `Authorization: Bearer <Clerk session token>`. |
| <a id="upgrade_required"></a>`upgrade_required` | 403 | Coaching is a paid feature. | Upgrade. |
| <a id="age_required"></a>`age_required` | 403 | No birthdate yet. | `POST /api/v1/me/birthdate`. |
| <a id="age_blocked"></a>`age_blocked` | 403 | The account is under 18. | None: the client signs out. |
| <a id="questionnaire_required"></a>`questionnaire_required` | 403 | One of you hasn't finished the questionnaire. | `PUT /api/v1/questionnaire`, then pair. |
| <a id="free_translations_used_up"></a>`free_translations_used_up` | 402 | The 10 free translated messages are used (and, for previews, the 5 free shares too). | Upgrade, or send as written. |
| <a id="free_previews_used_up"></a>`free_previews_used_up` | 402 | Free previews are used: 30 paired, 5 before pairing (`limit` says which). | Invite your partner, upgrade, or send as written. |
| <a id="free_shares_used_up"></a>`free_shares_used_up` | 402 | The 5 free shares outside the app are used. | Upgrade. |
| <a id="not_paired"></a>`not_paired` | 404 | No active couple. | Pair first, or pass `couple_id` for a past conversation. |
| <a id="not_found"></a>`not_found` | 404 | No such message or conversation for you. | Check the id. |
| <a id="already_paired"></a>`already_paired` | 409 | You're already in a couple (or just paired in parallel). | Unpair first. |
| <a id="partner_unavailable"></a>`partner_unavailable` | 409 | The invite's owner is already paired. | Ask for a different invite. |
| <a id="already_sent"></a>`already_sent` | 409 | This preview token was already used. | Preview again to send another message. |
| <a id="undo_window_closed"></a>`undo_window_closed` | 409 | The message is already delivered. | None. |
| <a id="code_expired"></a>`code_expired` | 410 | The pair code is expired, used or unknown. | Ask your partner for a new link. |
| <a id="unsupported_media_type"></a>`unsupported_media_type` | 415 | A write without `Content-Type: application/json`. | Send JSON. |
| <a id="safety_requires_as_written"></a>`safety_requires_as_written` | 422 | The message was flagged for safety, so it can't be softened or shared. | Edit it, or send as written. |
| <a id="rate_limited"></a>`rate_limited` | 429 | More than 10 pair attempts this hour. | Wait `retry_after` seconds. |
| <a id="ai_rate_limited"></a>`ai_rate_limited` | 429 | More than 120 AI calls this hour. | Wait `retry_after` seconds, or send as written. |
| <a id="internal"></a>`internal` | 500 | Unexpected server error; details are in the server log under `request_id`. | Retry once; report the `request_id`. |
| <a id="account_delete_incomplete"></a>`account_delete_incomplete` | 502 | Your data is deleted but the sign-in account wasn't closed. `retryable`. | Call `DELETE /api/v1/me` again. |
| <a id="translate_failed"></a>`translate_failed` | 503 | The AI didn't answer within 20 s. Nothing was charged or stored. `retryable`. | Retry up to twice, then send as written. |
| <a id="busy"></a>`busy` | 503 | The send waited too long on a lock. Nothing was sent. `retryable`. | Retry. |
