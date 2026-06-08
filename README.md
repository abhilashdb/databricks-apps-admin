# Databricks Apps Admin

Automated idle detection, shutdown monitoring, and an admin panel for Databricks Apps.

## Repository structure

```
.
├── install.sh        ← Interactive installer for any workspace
├── monitoring/       ← Scale-to-zero monitoring job (DABs)
│   ├── src/scale_to_zero.py
│   ├── databricks.yml
│   └── resources/
└── admin-panel/      ← Admin UI (Databricks AppKit)
    ├── client/       ← React frontend
    ├── server/       ← Express + tRPC backend
    └── config/       ← SQL queries + costs config
```

## Quick start

```bash
git clone https://github.com/abhilashdb/databricks-apps-admin
cd databricks-apps-admin
./install.sh
```

The installer will prompt for:
- **Databricks CLI profile** (must be authenticated against the target workspace)
- **Unity Catalog** name and schema for telemetry tables
- **Force-stop hour** (stored as local time; default 22 = 10 PM IST)
- **DBU cost rate** for the cost dashboard (default $0.75/DBU)

### Prerequisites

- [Databricks CLI](https://docs.databricks.com/en/dev-tools/cli/install.html) installed and authenticated
- Node.js ≥ 18 (for admin panel build)

## What it deploys

| Component | Description |
|---|---|
| **Monitoring job** | Serverless notebook running every 15 min; stops idle apps, force-stops at configured hour, auto-enables telemetry |
| **Admin panel** | Databricks AppKit app: live app status, strategy config, cost dashboard, telemetry setup guide |

## Telemetry

The monitor uses `otel_metrics.http.server.duration` for traffic detection. App developers must add `opentelemetry-instrument` to their `app.yaml` — see the **Help** tab in the admin panel for per-framework instructions.

The monitor auto-configures the Unity Catalog telemetry export destinations on first encounter.

See [monitoring/README.md](monitoring/README.md) for full documentation.
