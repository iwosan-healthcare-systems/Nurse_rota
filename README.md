# Nurse Rota — Iwosan Health

Staff scheduling and workforce management system for Iwosan Healthcare. Manages shift rotas, leave requests, locum bookings, multi-stage approval workflows, and reporting across multiple wards and facilities.

**Production:** [nrota.iwosanhealth.com](https://nrota.iwosanhealth.com)
**UAT:** [nurserota.netlify.app](https://nurserota.netlify.app)

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 19 · TypeScript · Vite 7 · TanStack Router · TanStack Query v5 · Tailwind CSS v4 · shadcn/ui |
| Backend | Node.js · Express (`nurse-api/`) |
| Database | PostgreSQL |
| Auth | JWT (bcrypt passwords, Bearer tokens) |
| Frontend hosting | Netlify (UAT) · VPS (production) |
| API hosting | VPS · PM2 |
| CI/CD | GitHub Actions → VPS via SCP + SSH |

---

## Environments

| Env | Branch | Frontend | API Port |
|---|---|---|---|
| UAT | `develop` | Netlify auto-deploy (nurserota.netlify.app) | 3002 |
| Production | `master` | VPS `/home/nrotaiwosanhealt/public_html` | 3001 |

---

## Local Development

### Frontend

```bash
npm install
npm run dev          # http://localhost:5000
```

Create a root `.env.local` for the API URL:

```env
VITE_API_URL=http://localhost:3001/api
```

### nurse-api

```bash
cd nurse-api
npm install
cp .env.example .env   # fill in DB_PASSWORD and JWT_SECRET
node server.js
```

`nurse-api/.env`:

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

UAT instance uses `PORT=3002`, `DB_NAME=nurse_rota_uat`, `DB_USER=nurseapp_uat`.

---

## Roles

| Role | Access |
|---|---|
| `admin` | Full access — users, rota, approvals, reports, settings |
| `cno` | Chief Nursing Officer — approve/publish rotas, manage shift switches |
| `chief_matron` | Submit rotas for approval, manage locum requests |
| `head_nurse` | Auto-generate rotas, manage ward schedules |
| `hr_admin` | Staff management, leave administration, reports |
| `nurse` | View own published rota, request leave, view schedule |
| `porter` | View own published rota, request leave |
| `nursing_assistant` | View own published rota, request leave |

Capabilities (what each role can do) are configurable per-role from the **Permissions** page without a code deploy.

---

## Key Features

- **Rota** — Monthly shift grid per ward; auto-generate schedules → draft → submit → approve → publish pipeline. Shift types: Day, Night, ON-CALL, OFF, LEAVE, SICK, LOCUM (LO), and more.
- **Approval workflow** — Multi-stage: Head Nurse → Chief Matron → CNO; per-ward approval with comments.
- **Leave & shift switch** — Request, review, and auto-apply leave to the published rota; coordinate shift swaps between nurses.
- **Locum** — Request bank nurses for specific shifts, send invites, nurses accept/decline via the portal. Accepted locums display the **LO** badge on the rota. Matron and CNO receive bell notifications on acceptance.
- **Shift tracker** — GPS-verified shift start/end, late detection.
- **Reports** — Period hours summary per nurse, locum hours and cost; exportable to Excel.
- **Notifications** — Per-user read/unread bell with role-targeted messages and dismiss support.
- **Audit log** — Timestamped record of all rota changes, approvals, and shift swaps.
- **Auto-logout** — Users are warned at 55 minutes and automatically logged out after 60 minutes of inactivity.

---

## Project Structure

```
src/
  lib/
    api.ts              # Central JWT fetch client
    auth-context.tsx    # Auth state, role context, idle timeout
    auto-schedule.ts    # Scheduling engine
    audit.ts            # logAudit() helper
  routes/
    login.tsx
    _app/
      index.tsx         # Dashboard
      rota.tsx          # Shift grid + auto-schedule
      shift.tsx         # Shift tracker
      leave.tsx         # Leave & shift switch requests
      locum.tsx         # Locum/bank nurse management
      approvals.tsx     # Approval workflow
      reports.tsx       # Reports & period close
      staff.tsx         # Staff management
      wards.tsx         # Ward configuration
      users.tsx         # User accounts
      permissions.tsx   # Role capability matrix
      menu-permissions.tsx
      audit.tsx         # Audit log
  components/
    ui/                 # shadcn/ui components
    AppShell.tsx        # Nav, notification bell

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
    locum.js
    nurse-period-hours.js
    profiles.js
    user-roles.js
    notifications.js
    audit-logs.js
    portal-settings.js
    rpc.js
  migrations/           # SQL migration files

.github/
  workflows/
    deploy-production.yml
```

---

## Deployment

GitHub Actions (`.github/workflows/deploy-production.yml`):

**On push to `develop`** — deploys the API to the UAT VPS instance and restarts PM2.

**On push to `master`:**

1. Builds the React app with `VITE_API_URL` from secrets
2. SCPs `dist/` → `/home/nrotaiwosanhealt/public_html` on VPS
3. SCPs `nurse-api/` → `/root/nurse-api` on VPS
4. SSHs in → runs pending migrations → `pm2 restart nurse-api`

### Required GitHub Secrets

| Secret | Purpose |
| --- | --- |
| `VPS_HOST` | VPS IP or hostname |
| `VPS_USER` | SSH username |
| `VPS_SSH_KEY` | Private SSH key |
| `VITE_API_URL` | Production API base URL injected at build time |
| `DB_PASSWORD` | Production PostgreSQL password |
| `DB_PASSWORD_UAT` | UAT PostgreSQL password |

---

## Database Migrations

SQL migrations live in `nurse-api/migrations/`. Run each file against the target database after deploying a new version:

```bash
PGPASSWORD=your_password psql -h 127.0.0.1 -U nurseapp -d nurse_rota \
  -f nurse-api/migrations/001_add_employee_id.sql
```

---

## Available Scripts

```bash
npm run dev          # Dev server (port 5000)
npm run build        # Production build
npm run build:dev    # Development build
npm run lint         # ESLint
npm run format       # Prettier
```
