# RENEWZONE – Sales Performance

Node.js/Express + PostgreSQL. Responsive web app for phone and desktop.

## Main features (v1.5)
- Lavender Galaxy dashboard with daily revenue chart, total revenue breakdown, and branch summary table.
- The business overview, chart, and branch summary use employee-entered records only; KiotViet remains separate for import and reconciliation.
- Employee-entered machine sales and daily customer statistics include a branch/store field. Existing records are migrated automatically to “Chưa phân cửa hàng” until a manager edits them.
- Managers can edit or delete employee-entered machine sales and daily customer statistics. Changes and deletions are written to the audit log.
- Branch and date filters apply to employee-entered dashboard data.
- Dashboard display settings remain available in a dropdown.
- Managers can create additional manager accounts; each user can change their own password.

## Main features
- Manager and employee accounts; employee access is scoped to their own records.
- Daily customer funnel and individual machine sales.
- Insurance revenue is calculated from machine price: below 10m = 799,000đ; 10m to below 20m = 999,000đ; 20m+ = 1,499,000đ.
- Stock source, condition category, insurance sold/dropped, KPI targets and forecasts.
- Dashboard with date filters and previous-period comparison.
- Separate KiotViet CSV import and summary reconciliation.
- Basic audit log and CSV export.

## Important architecture changes in v1.1
- PostgreSQL is now used instead of local SQLite.
- No Render persistent disk is required.
- `DATABASE_URL` must point to a managed PostgreSQL database (for example Neon).
- Render web service is configured with the Free plan. Free services can sleep when idle and have resource limits; availability and terms may change.

## Deploy
1. Create a PostgreSQL project with a provider such as Neon. Copy its pooled or direct connection string; use the connection string with SSL enabled.
2. Push this project to a private GitHub repository.
3. In Render, create a Blueprint from that repository. The `render.yaml` creates only a Free web service; it does not create a paid database or disk.
4. When prompted, provide `DATABASE_URL`. Render generates `JWT_SECRET` from `generateValue: true`.
5. Wait for the deploy and verify `/api/health` returns `{ "ok": true, "database": "connected" }`.
6. Open the site. The first user creates the manager account on the setup screen. Use a unique password of at least 10 characters.
7. Create employee accounts from the manager account.

## Backups and free-tier limitations
- Free database plans have quotas, sleep/compute limits, and provider-specific backup/retention terms. Do not assume the free tier is a guaranteed production backup.
- Export sales CSV regularly from the app and use the database provider's backup/export features when available.
- Before using real sales data, verify the provider's retention, restore, and quota policies and perform a test restore.
- Render Free web services may spin down when idle. The first request after idle can take time.

## KiotViet
This version imports KiotViet CSV files. It does not connect to KiotViet API automatically. API access requires valid API credentials/partner permissions.
