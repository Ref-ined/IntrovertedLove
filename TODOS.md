# TODOS

- **E5: recipient can ask for the original.** Why: a recipient who suspects softening has no way to ask. Context: CEO review deferred it to keep M1 small. Depends on: M1 messaging.
- **E6: PWA manifest.** Why: iOS needs it before web push works. Context: ships with M2 Web Push. Depends on: M2 realtime and push.
- **Changelog and API deprecation policy.** Why: the Expo app will run old builds against `/api/v1`. Context: DX review; write it before the first Expo build. Depends on: M2.
- **Live-model eval script for translate and coach prompts.** Why: fake fixtures don't catch prompt quality regressions. Context: eng review; run by hand with a real key, not in CI. Depends on: build step 3.
- **Revisit the polling budget with realtime.** Why: 5-second polling costs about 400 req/s at 1,000 active couples (estimated). Context: eng review Section 4. Depends on: M2 realtime.
