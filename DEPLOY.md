# Deploy workflow

## Branch → environment

| Branch | Environment | Worker | D1 |
|--------|-------------|--------|-----|
| `main` | **Staging** | `digital-kingsmen-portal-api-staging` | `portal-db-staging` |
| `production` | **Production** | `digital-kingsmen-portal-api` | `portal-db` |

Push to `main` for daily work and QA. Merge or push to `production` only when ready for live users.

## URLs

| | Staging | Production |
|---|---------|------------|
| API | https://digital-kingsmen-portal-api-staging.auto-cca.workers.dev/api | https://digital-kingsmen-portal-api.auto-cca.workers.dev/api |
| Swagger | …/api/docs | …/api/docs |

## Manual deploy (local)

```bash
npm ci
npm run deploy:staging   # staging
npm run deploy:prod      # production
```

Migrations:

```bash
npm run cf:migrate:staging   # staging D1
npm run cf:migrate:remote    # production D1
```

## GitHub Actions

Workflow: [.github/workflows/deploy.yml](.github/workflows/deploy.yml)

Required repo secret: **`CLOUDFLARE_API_TOKEN`** (Workers Scripts Edit + D1 Edit on account `cca5a114f4b3baf1459a9b2697cad2e1`).

## One-time staging setup (already done)

- D1: `portal-db-staging` (`41bdf661-d653-4a94-aceb-6571f290664a`)
- R2: `portal-uploads-staging`
- Secret: `wrangler secret put JWT_SECRET --env staging`

Optional seed on staging (never copy prod data):

```bash
npm run cf:setup:local
CF_SEED=1 npm run db:seed:cf
# then export/import to staging D1 via wrangler d1 execute if needed
```

## CORS

Staging `CORS_ORIGIN` / `APP_URL` in [wrangler.toml](wrangler.toml) `[env.staging.vars]` must include the staging frontend URL.
