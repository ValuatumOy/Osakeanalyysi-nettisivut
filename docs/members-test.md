# Members test stack (members-test.aiequityreports.com)

Isolated membership/subscription system. Test stage ONLY — `MembersStack` throws
on `stage=prod` and `infra/bin/aiequityreports.ts` only instantiates it for
non-prod. Nothing here ships with the prod API Lambda.

## Resources

| Thing | Value |
|---|---|
| Stack | `AiEquityReportsMembers-test` (eu-west-1) |
| API | `https://members-test.aiequityreports.com` |
| Lambda | `AiEquityReportsMembers-test` (`server/lambda/members.js`) |
| Table | `AiEquityReportsMembers-test` (pk/sk, TTL `expiresAt`, RemovalPolicy DESTROY) |
| PDF source | test bucket `aiequityreports-pdfs-test` (read-only, presigned GETs) |
| Stripe | TEST mode only; webhook endpoint `we_…` → `/billing/webhook`, own signing secret |

## Product rules implemented

- **Freemium = analysts only** (LinkedIn login). 2 self-picked report views/month,
  only reports with `ageDays >= 30` (server-side, from the catalog). 1 free
  generation/month, reserved at start; **no new reservation until the previous
  one is published** (obligation on PROFILE, spans months). Submit publishes
  immediately (`companyId` required, `jobId` for provenance, `promptsText`
  published with it) — post-moderation via `POST /admin/members/takedown`.
  Bounty ledger at `GET /me/earnings`; see [analyst-publishing.md](analyst-publishing.md).
- **Regular visitors**: weekly free-rotation reports only (`isFree` reports gate
  nothing) — unchanged from prod behaviour.
- **Investor 19 €/mo / 190 €/yr**: 3 picks/month monthly, 5 annual. **Investor
  Plus 39 €/mo / 390 €/yr**: 10 picks/month monthly, 15 annual, plus one private
  generation per month (no publish obligation). **Company Coverage 59 €/yr**:
  covered company only, initial report once + 4 updates/calendar year.
- Monthly plans deliberately get a smaller allowance than annual ones: at the
  20 € one-off price, 5 picks for one 19 € month is 100 € of product and the
  subscriber can cancel immediately (the PDF is already downloaded).
- **Fresh reports cost members 40 €** instead of 50 €. The discount is applied
  server-side in `POST /billing/fresh-checkout` from the live subscription
  status — the client never selects the price.
- Quota period = calendar month (UTC), key `YYYY-MM`. No rollover.
- All quota writes are DynamoDB TransactWriteItems with condition expressions
  (`server/members/quota.js` builders) — concurrent requests cannot overspend.
- **Generations run the real pipeline.** `POST /generations/free` reserves the
  monthly slot, then creates an order in the stage's Orders table and pushes the
  worker — the same reconciler path as a paid fresh report, against the stage's
  engine (`pdf-report-api-test`). **Every reservation spends real engine time.**
  The quota transaction commits first, so a rejected reservation never starts a
  run. `GET /generations/{genId}` reports progress and hands over the
  entitlement once the report is delivered.
- Membership reports are ordered with `visibility: 'private'`, which makes
  `reconciler.deliver()` write a hidden, unpriced sidecar even when
  `RESALE_ENABLED` is on — a member's report is never resold from the catalog.
- Entitlements: `oneoff` and `generation` permanent; `pick`/`coverage` require
  active (or past_due) subscription at sign time; `free_pick` requires analyst role.
  Downloads are 5-minute S3 presigned GETs from `POST /reports/{id}/open`;
  the members `GET /reports` payload never exposes `pdfUrl`.

## SSM secrets (`/aiequityreports/test/`)

`members-jwt-secret`, `members-test-utils-secret`, `members-stripe-prices`
(JSON of price ids, created by `scripts/stripe-setup-members-test.mjs`),
`stripe-webhook-secret-members`, `stripe-secret-key` (sk_test),
`linkedin-client-id`, `linkedin-client-secret` (Valuatum's shared LinkedIn app —
every environment uses the same credentials; each new redirect URI must be added
in the LinkedIn developer console).

## Test utilities (never on prod; bearer = members-test-utils-secret)

- `POST /test/users {email?, role, tier?, tierStatus?, coverageCompanyId?}` → `{userId, token}`
- `POST /test/force-publish {userId, genId, companyId?, jobId?}`
- `POST /test/publications {userId, companyId?, publishedAt?}` → seeds a published
  PUB item with a backdatable date, so the bounty rules can be exercised without
  spending an engine run
- Time travel: headers `x-test-now: <ISO>` + `x-test-secret: <utils secret>` move
  the quota clock (token expiry always uses the real clock).

## Verify

```bash
npm run test:members                     # unit: quota builders + jwt
MEMBERS_TEST_SECRET=… node scripts/members-smoke.mjs   # 26 checks against the deployed stack
# ADMIN_PASSWORD=… adds the payout/takedown checks; SMOKE_ENGINE=1 adds the
# generation loop and costs one real engine run
```

## Environments

| Site | URL | Git branch |
|---|---|---|
| Production | `www.aiequityreports.com` | `main` |
| Staging | `test.aiequityreports.com` | `staging` |
| Local | `http://localhost:3100` | working tree (`.claude/launch.json`) |

**Deploy only by pushing a branch.** Never run `vercel deploy` from this repo —
`--prod=false` does *not* prevent a production deployment (it published an
unreviewed branch to www on 6.8.2026; recovered with `vercel rollback`).

The staging domain is a branch-assigned domain on the same Vercel project
(`vercel domains add` + `PATCH /v9/projects/{id}/domains/{domain}` with
`gitBranch: staging`), with a Route53 CNAME to the project's
`…vercel-dns-017.com` target.

Member page: `members.html` — branded, unlinked from the nav, talks only to the
members-test API. All three sites share that API: the sign-in flows pass a
`returnTo` that must be on the `MEMBERS_FRONTEND_URLS` allowlist, so a user
lands back on the site they started from and an arbitrary URL cannot be
injected.

After any infra change: `cd infra && npx cdk diff -c stage=prod --all`. It is
**no longer zero** — wiring generations to the real pipeline touched
`server/reconciler.js` and `server/aws/orders-store.js`, which the prod Worker
and API Lambdas bundle, so their code hashes differ. The change is additive
(`visibility` is only ever set by the members flow; without it every branch
behaves exactly as before, covered by
`test/members/generation-visibility.test.mjs`). Read the diff before any prod
deploy rather than expecting an empty one.

## Known gaps / prod-rollout blockers

- **The public catalog no longer publishes `pdfUrl` for paid reports** (only for
  free ones). Buyers download through `GET /api/report-download?session_id=…`,
  which verifies the Stripe session and 302s to a 15-minute signed S3 URL;
  the backend route `POST /api/report-download` is guarded by the catalog-sync
  secret and is never called from the browser. Deployed to the test stage;
  **production still serves the old payload until it is deployed there.**
- Remaining gap in that fix: `files*.aiequityreports.com` still serves the whole
  bucket publicly, so a *guessed* filename (`AMD_05062026.pdf`) still downloads.
  Closing that means either CloudFront signed URLs (key-group setup) or dropping
  the public origin — both break the permanent links in already-sent receipt
  emails, so it is a business decision, not a code one.
- Fresh-report delivery emails (reconciler) still link the PDF directly; that
  path needs the same treatment as the ready-report receipt.
- VAT: no `automatic_tax` anywhere, one-off or subscription. Selling digital
  subscriptions to EU consumers needs an OSS registration decision.
- The analyst freemium has **no off switch**: any LinkedIn sign-in becomes an
  analyst with picks and a generation. Nothing verifies that the person is an
  analyst, so this must be gated before production.
- No Stripe billing portal: cancelling is an email to support, and the site copy
  says exactly that.
- Submitting auto-publishes and post-moderation takes it back down
  (`POST /admin/members/takedown`) — the admin page has no UI for either yet.
- Final prices are business decisions; 19/39/59 are test points.
- Published analyses are recorded but nothing renders them on the site yet —
  blocked on the handoff contract with the engine team
  ([analyst-publishing.md](analyst-publishing.md), open question 1).
- `BOUNTY_EUR_PER_REPORT` defaults to 0, so the ledger states are real but the
  amounts are not.
