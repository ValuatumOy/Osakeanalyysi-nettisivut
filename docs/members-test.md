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
  one is submitted for publication** (obligation on PROFILE, spans months).
  Submitting also publishes the modification prompts (`promptsText` on the PUB item).
- **Regular visitors**: weekly free-rotation reports only (`isFree` reports gate
  nothing) — unchanged from prod behaviour.
- **Investor 19 €/mo / 190 €/yr**: 5 picks/month. **Investor Plus 39 €/mo /
  390 €/yr**: 15 picks/month. **Company Coverage 59 €/yr**: covered company only,
  initial report once + 4 updates/calendar year.
- Quota period = calendar month (UTC), key `YYYY-MM`. No rollover.
- All quota writes are DynamoDB TransactWriteItems with condition expressions
  (`server/members/quota.js` builders) — concurrent requests cannot overspend.
- Entitlements: `oneoff` permanent; `pick`/`coverage` require active (or
  past_due) subscription at sign time; `free_pick` requires analyst role.
  Downloads are 5-minute S3 presigned GETs from `POST /reports/{id}/open`;
  the members `GET /reports` payload never exposes `pdfUrl`.

## SSM secrets (`/aiequityreports/test/`)

`members-jwt-secret`, `members-test-utils-secret`, `members-stripe-prices`
(JSON of price ids, created by `scripts/stripe-setup-members-test.mjs`),
`stripe-webhook-secret-members`, `stripe-secret-key` (sk_test), plus pending:
`linkedin-client-id`, `linkedin-client-secret`. LinkedIn app must register
redirect URI `https://members-test.aiequityreports.com/auth/linkedin/callback`.

## Test utilities (never on prod; bearer = members-test-utils-secret)

- `POST /test/users {email?, role, tier?, tierStatus?, coverageCompanyId?}` → `{userId, token}`
- `POST /test/force-publish {userId, genId}`
- Time travel: headers `x-test-now: <ISO>` + `x-test-secret: <utils secret>` move
  the quota clock (token expiry always uses the real clock).

## Verify

```bash
npm run test:members                     # unit: quota builders + jwt
MEMBERS_TEST_SECRET=… node scripts/members-smoke.mjs   # 22 checks against the deployed stack
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

After any infra change: `cd infra && npx cdk diff -c stage=prod --all` must show
**no changes** before anything is merged.

## Known gaps / prod-rollout blockers

- Prod public `/api/reports` still exposes permanent unsigned `pdfUrl` for paid
  reports — the paywall side door. Must be stripped when membership goes to prod.
- Free-generation engine invocation is stubbed (PUB stays `generating`); wire
  `ordersStore` + worker push when real runs are wanted (they cost engine time).
- Investor member-priced fresh generation not implemented yet.
- Final prices are business decisions; 19/39/59 are test points.
