# RejectRadar

RejectRadar shows food exporters and importers which shipments are refused at US, EU, UK and Australian borders, and why.

## Stack

- Nx monorepo
- Angular web app (`apps/web`)
- NestJS API (`apps/api`)
- Node ingest CLI (`apps/ingest`)
- PostgreSQL with Drizzle ORM (`libs/db`)

## Prerequisites

- Node 24
- Docker (for local PostgreSQL and Mailpit)

## Setup

```sh
npm ci
cp .env.example .env
npm run secret   # copy the output into JWT_SECRET in .env
npm run db:up    # PostgreSQL on 127.0.0.1:5432, Mailpit on 127.0.0.1:1025 / 8025
```

## Common commands

```sh
npx nx run-many -t lint test build      # lint, test and build every project
npx nx serve api                        # then open http://localhost:3000/v1/health
npx nx build ingest && node dist/apps/ingest/main.js --help
```

## Docs

Design documents are kept outside this repository.
