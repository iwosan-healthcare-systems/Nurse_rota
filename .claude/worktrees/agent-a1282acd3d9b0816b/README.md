# Nurses Rota — Iwosan Health

Staff scheduling system for Iwosan Healthcare. Manages 28-day shift rotas, leave requests, locum bookings, and live shift tracking across multiple facilities.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 19 · TypeScript · TanStack Router · React Query · Tailwind CSS · shadcn/ui |
| Backend | Node.js · Express (`nurse-api/`) |
| Database | PostgreSQL |
| Auth | JWT (bcrypt passwords, Bearer tokens) |
| Frontend hosting | Netlify (UAT) · VPS nginx (production) |
| API hosting | VPS · PM2 |
| CI/CD | GitHub Actions → VPS via SCP + SSH |

## Environments

| Env | Branch | Frontend URL | API URL |
|---|---|---|---|
| UAT | `main` | Netlify auto-deploy | `https://nrota.iwosanhealth.com/uat/api` |
| Production | `production` | `https://nrota.iwosanhealth.com` | `https://nrota.iwosanhealth.com/api` |

### Netlify env var (UAT)

```env
VITE_API_URL=https://nrota.iwosanhealth.com/uat/api
```

### GitHub Secrets (for Actions deploy to production)

```
VPS_HOST       — VPS IP or hostname
VPS_USER       — SSH username (root)
VPS_SSH_KEY    — private SSH key for VPS access
VITE_API_URL   — https://nrota.iwosanhealth.com/api
```

## Local development

### Frontend

```bash
npm install
npm run dev
```

### nurse-api

```bash
cd nurse-api
npm install
cp .env.example .env   # fill in DB_PASSWORD and JWT_SECRET
node server.js
```

The frontend reads `VITE_API_URL` — set it in a root `.env.local` for local dev:

```env
VITE_API_URL=http://localhost:3001
```

## nurse-api/.env

```env
PORT=3001
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=nurse_rota
DB_USER=nurseapp
DB_PASSWORD=<postgres password>
JWT_SECRET=<long random hex string>
ALLOWED_ORIGIN=https://nrota.iwosanhealth.com
```

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## Roles

| Role | Access |
|---|---|
| `admin` | Full access — users, rota, approvals, reports |
| `cno` | Approve/publish rotas, manage locum requests |
| `chief_matron` | Submit rotas for approval |
| `hr_admin` | Staff management, reports |
| `nurse` | View own published rota, track shifts, request leave |

## Key features

- **Rota** — 28-day auto-generated schedule per facility/ward; draft → submit → approve → publish pipeline
- **Leave & shift switch** — request, review, and auto-apply to published rota
- **Locum** — request bank nurses, send invites, atomic accept with race protection
- **Shift tracker** — GPS-verified start/end, late detection, overnight auto-end
- **Reports** — period hours summary, schedule archive download
- **Notifications** — per-user read/unread bell with upsert-on-conflict

## Project structure

```
src/
  lib/
    api.ts              # Central JWT fetch client
    auth-context.tsx    # Auth state + role context
    auto-schedule.ts    # 28-day scheduling engine
    audit.ts            # logAudit() helper
  routes/
    login.tsx
    _app/
      index.tsx         # Dashboard
      rota.tsx          # Shift grid + auto-schedule
      shift.tsx         # Live shift tracker
      leave.tsx         # Leave & shift switch requests
      locum.tsx         # Locum/bank nurse management
      approvals.tsx     # Approval workflow
      reports.tsx       # Reports & period close
      staff.tsx         # Staff management
      wards.tsx         # Ward configuration
      users.tsx         # User accounts
      permissions.tsx   # Role assignments
      audit.tsx         # Audit log
  components/
    ui/                 # shadcn/ui components

nurse-api/
  server.js
  db.js
  middleware/auth.js
  routes/
    auth.js             # POST /login, POST /change-password, GET /me
    nurses.js
    wards.js
    shift-assignments.js
    shift-logs.js
    leave-requests.js
    locum.js            # /requests + /invites
    nurse-period-hours.js
    profiles.js
    user-roles.js
    notifications.js
    audit-logs.js
    portal-settings.js

.github/
  workflows/
    deploy-production.yml
```

## Deployment (production branch push)

GitHub Actions (`.github/workflows/deploy-production.yml`) will:

1. Build the React app with `VITE_API_URL` from secrets
2. SCP `dist/` → `/home/nrotaiwosanhealt/public_html` on VPS
3. SCP `nurse-api/` → `/root/nurse-api` on VPS
4. SSH → `npm install --production && pm2 restart nurse-api`

## Database

Schema is documented in `schema.sql`. The database runs on the VPS as PostgreSQL.
