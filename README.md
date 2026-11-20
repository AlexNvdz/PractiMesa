# PractiMesa

POS + online store SaaS for restaurants in Colombia (Factus Pay QR + Factus e-invoicing).

```
apps/
  api/   NestJS 12 + Prisma 7 (PostgreSQL 16)  -> Railway
  web/   Next.js 16 App Router + Tailwind 4     -> Vercel (*.domain wildcard)
```

## Local setup

```bash
npm install
cp apps/api/.env.example apps/api/.env      # fill Factus sandbox credentials
cp apps/web/.env.example apps/web/.env.local
npm run db:up                               # Postgres on localhost:5433
npm run db:migrate -w apps/api && npm run db:generate -w apps/api
npm run dev:api                             # http://localhost:4000/api/health
npm run dev:web                             # http://localhost:3000
```

## Quality

```bash
npm test                                    # Jest
npm run test:cov -w apps/api                # lcov -> apps/api/coverage
npm run sonar:up                            # SonarQube on http://localhost:9000 (admin/admin first login)
SONAR_TOKEN=... npm run sonar:local          # cloud scan runs in GitHub Actions
```

Schema changes: edit `apps/api/prisma/schema.prisma`, then `npx prisma migrate dev --name <change>` in `apps/api`.
