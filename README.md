# Dependency Explorer

A TypeScript Node.js application that streams Azure Migrate dependency exports into MySQL and exposes them through a paginated REST API and React explorer.

## Service layout

```text
services/
|-- frontend/              React and Vite web application
|   `-- src/
|       |-- Dashboard.tsx  Dependency search and result UI
|       `-- Dashboard.css  Responsive visual design
`-- backend/               Node.js and Express service
	|-- src/
	|   |-- index.ts       REST API and production frontend hosting
	|   |-- application-inventory.ts  Evidence-based application resolution
	|   |-- dependency-import.ts  Shared streaming CSV/XLSX loader
	|   |-- import-csv.ts  Command-line import entry point
	|   |-- migrate.ts     Database migration command
	|   |-- db.ts          Knex query builder and connection pool
	|   `-- config.ts      Environment configuration
```

The 467 MB export is never loaded into memory. CSV and XLSX importers read rows as streams and write bounded batches through Knex. Schema creation, API filters, aggregation, pagination, inserts, and updates all use the Knex query builder; the application contains no raw SQL queries.

## Prerequisites

- Node.js 22 or newer
- MySQL 8.0 or Azure Database for MySQL Flexible Server
- A MySQL database and user with schema creation and data access permissions

## Configure

Copy `.env.example` to `.env` and set the `MYSQL_*` values. TLS certificate verification is enabled by default. Set `MYSQL_SSL=false` only for a trusted local MySQL instance that does not support TLS.

For Azure hosting, store `MYSQL_PASSWORD` as an App Service Key Vault reference rather than in source control.

### Authentication and authorization

Authentication is disabled after the auth schema is first created, preserving access to existing installations. Open **Administration** in the application, create at least one enabled local administrator with a password of 12 or more characters, and then turn on **Require authentication**. The server refuses to enable authentication without an enabled administrator and prevents the last enabled administrator from being disabled, demoted, or deleted.

Local and Microsoft Entra users can be assigned Read, Modify, and Delete privileges. Administrators receive all privileges and can manage users and authentication settings. Authorization is enforced by the Express API; navigation visibility is only a user-interface convenience. Authenticated writes require the per-session CSRF token, and session identifiers are stored as SHA-256 hashes in MySQL.

To configure Microsoft Entra ID:

1. Register a confidential web application in the required tenant.
2. Add `<application-origin>/api/auth/entra/callback` as a Web redirect URI.
3. Set `ENTRA_CLIENT_SECRET` only in the server environment. For Azure App Service, use a Key Vault reference.
4. In **Administration**, enter the tenant ID, client ID, and redirect URI, choose default privileges for newly seen Entra users, and enable Microsoft Entra ID.

The client secret and identity tokens are never returned to the browser or stored in application settings. Use the **Require authentication** toggle to disable sign-in and authorization for trusted, isolated deployments.

## Load the export

```powershell
npm install
npm run migrate
npm run import -- ".\DependencyExport-RWS-original (1).csv"
```

Validate the entire CSV without connecting to MySQL:

```powershell
npm run import -- ".\DependencyExport-RWS-original (1).csv" --validate-only
```

## Synthetic migration dataset

Generate a deterministic planning dataset locally:

```powershell
npm run generate:dataset
```

The command streams its output to `data/generated/` and creates:

- `ServerAssessment-Synthetic-624.csv`: an import-ready Server Assessment containing exactly 624 uniquely named and sized servers.
- `DependencyExport-Synthetic-01.csv` through `DependencyExport-Synthetic-04.csv`: four import-ready files containing 500,000 dependency observations each.
- `ApplicationCatalog-Synthetic-96.csv`: a reference catalog of 96 meaningful applications, environments, owners, and sensitivity classifications.
- `SharedDatabaseInventory-Synthetic.csv`: every shared database host, its engine and environment, and the applications consuming it.
- `CoreInfrastructure-Synthetic.csv`: 86 core infrastructure assignments plus eight private load-balancer IPs, ready for the Core Infrastructure upload.
- `NetworkRanges-Synthetic.csv`: corporate and isolated CIDR ranges for Dev, Test, Pre-prod, and Prod, labeled as Office and VPN networks for entry in Core Infrastructure.
- `dataset-manifest.json`: generated counts and pass/fail assertions for server roles, database engines, environments, isolation, and dependency totals.

The topology includes private load-balancer IP traffic to optional web tiers and dedicated application servers, then application/report traffic to database tiers. Applications also connect to Active Directory/DNS, proxy, print, file, backup, monitoring, management, and Configuration Manager services. Every one of the 352 application/environment deployments has its own application server. Database sharing is assigned deliberately between application cohorts within the same environment, and every shared host uses `Shared DB` as its Server Assessment application name. Web, application, report, and database servers are never shared across Dev, Test, Pre-prod, and Prod; generation fails if a tier server or tier dependency crosses an environment boundary. Twelve highly sensitive applications use isolated private address ranges and dedicated management servers. Pre-prod is generated for 64 applications with the same logical connection profile and sizing as Prod. Dev and Test use proportionally smaller compute, memory, and storage recommendations.

The operating-system fleet contains 424 Windows and 200 Linux servers, approximating the requested 3.4:1.6 ratio. Every Windows server uses Datacenter edition; Windows Server 2012 and 2012 R2 together remain below 5% of Windows hosts, while Windows Server 2025 remains below 20%. Linux is split exactly 70% RHEL and 30% SLES across RHEL 7.x/8.x/9.x and SLES 14/15/16. Core infrastructure is restricted to Windows Server 2019 or newer, or the equivalent modern Linux versions. The manifest records the exact distribution and generation-blocking policy assertions.

Upload `ServerAssessment-Synthetic-624.csv` as Server Assessment data, upload `CoreInfrastructure-Synthetic.csv` in Core Infrastructure, enter the ranges from `NetworkRanges-Synthetic.csv`, and then upload all four `DependencyExport-Synthetic-*.csv` files as Dependency data. The complete enhanced dataset generated for this workspace is in `data/generated/enhanced-624/`. Generated files are excluded from Git because the dependency exports are intentionally large. To create a smaller development slice, override the row settings:

```powershell
npm run generate:dataset -- --output-dir=data/generated/sample --dependency-count=10000 --rows-per-file=5000
```

Imports are recorded in `import_runs`. Failed runs retain their imported-row count and error message. Re-running an export creates another import run; it does not replace previous data.

The web application also accepts bulk uploads through its data-ingestion section. Select or drop up to 20 `.csv` or `.xlsx` Azure Migrate exports per request. Each file may be up to 1 GB and receives an independent completion or failure result.

After each file is loaded, the importer automatically rebuilds that run's `application_inventory` rows from destination server, IP address, application, process, and port evidence. A name is populated only when Azure Migrate reports a non-placeholder application or an exact executable signature matches the audited rule set. Ports are never used alone to infer an application. Ambiguous endpoints remain in the table with a null `application_name`, `resolution_method = 'unresolved'`, and explanatory evidence instead of a guessed name.

## Run locally

```powershell
npm run dev
```

- React: http://localhost:5173
- API: http://localhost:3000/api/health

For a production-style local run:

```powershell
npm run build
npm start
```

The backend service serves the built frontend application at http://localhost:3000.

## REST API

`GET /api/health` checks MySQL connectivity.

`GET /api/summary` returns record, connection, source-server, and destination-server totals.

`GET /api/core-infrastructure-servers` returns the materialized core infrastructure server inventory and category totals. Use the optional `category` query parameter to filter the returned server rows.

`POST /api/core-infrastructure-servers/refresh` rebuilds the inventory from `server_assessments`. The same rebuild runs automatically and transactionally after every successful Server Assessment import. A server may have multiple roles, such as Active Directory Domain Controller and DNS Server.

`GET /api/core-infrastructure-inputs` returns manually gathered core server-role assignments, saved VPN/load-balancer/office network ranges, and individual load-balancer addresses in `loadBalancerIps`. `PUT /api/core-infrastructure-inputs` transactionally upserts a `servers` array containing `serverName`, `role`, and `ipAddress`, an optional `networks` object containing `vpn`, `loadBalancer`, and `office` CIDR ranges, and an optional `loadBalancerIps` string array. Reusing the same server name and role updates its IP address instead of creating a duplicate. Manual rows are preserved when assessment-derived infrastructure is refreshed.

`POST /api/core-infrastructure-inputs/upload` accepts one CSV or XLSX file in the multipart `file` field. Header matching is case-insensitive and ignores spaces and punctuation; recommended columns are `server_name`, `role`, `ip_address`, and `load_balancer_ip`. Each row may contain a complete server assignment, a load-balancer IP, or both. The complete file is validated before its records are transactionally upserted.

`GET /api/application-environments` lists every application and environment represented in Server Assessment data with its server count.

Dependency and Server Assessment CSV/XLSX imports map source fields to MySQL columns by normalized header name, not column position. Column matching is case-insensitive and ignores spaces and punctuation; documented aliases such as `Hostname`, `Machine Name`, `Environment`, `Source Server`, and `Destination Server` are also accepted. Reordered columns are safe, unknown columns are ignored with a warning, and absent optional columns are stored as `NULL`. Imports reject missing required columns, empty or duplicate canonical headers, rows containing values beyond the declared headers, and invalid typed values with a row-specific message. Server Assessment writes are transactional; failed Dependency imports remove their rows and rebuild dependency summaries, distinct server lists, and database-server evidence from retained records. Validation warnings are returned with the upload result and displayed in the Imports workspace.

`GET /api/application-map?application=<name>&environment=<name>` returns the selected application boundary, its servers, core infrastructure connections, configured load-balancer IP connections, VPN/office network connections, Shared DB servers, and inbound, outbound, or bidirectional service edges. Connected Shared DB servers appear inside the selected application's center block and expand one dependency hop so their other inbound and outbound systems are shown by application name. Shared DB nodes expose the database server name, while servers owned by other applications are represented only by application name. The Application Map workspace enriches core nodes from `GET /api/core-infrastructure-servers`, labels configured network boundaries, and opens another application's topology when its application node is selected.

`GET /api/server-profile?server=<name>` returns a server's identity, environment, operating system, hosted applications, server classification, infrastructure roles, current CPU/memory/disk configuration, and proposed Azure VM and storage sizing. This lightweight endpoint loads independently of dependency topology aggregation.

`POST /api/migration-wave-plan` creates an ordered migration plan from Server Assessment, Infrastructure Servers, and Dependency Records. The request accepts `minimumServers`, `maximumServers`, `considerEnvironments`, `prioritizeEnvironments`, `environmentOrder`, `dataHeavyStorageGb`, `separateDataHeavyWorkloads`, `excludedApplications`, and `excludedServers`. Data-heavy classification is informational by default so dependency co-location remains the first priority; set `separateDataHeavyWorkloads` to `true` to enforce at most one database or storage-heavy workload per sprint. Exclusion values are exact, case-insensitive names; excluding an application removes all of its servers. The response contains summary totals, environment waves, migration sprints, server assignments, grouping rationale, deferred and excluded servers, assumptions, explicit guardrail exceptions, complete cross-sprint dependencies, environment dependency summaries, and a capped list of sequencing warnings. `summary.severeDatabaseWarnings` counts database/application dependencies split across waves, and each affected wave includes the corresponding records in `severeWarnings`.

The Wave Planning workspace exports UTF-8 CSV reports for an individual sprint, the selected environment, or the complete all-environment plan. Assignment reports include planning assumptions and sprint grouping rationale. Each environment also has a cross-dependency report and CSV export containing source/destination applications, environments, waves, sprints, sequencing status, and rationale. Cross-dependency reports exclude rows where either endpoint is a core infrastructure server; those dependencies still influence planning and sequencing.

After hard environment, capacity, and data-heavy constraints, minimizing cross-sprint dependencies is the planner's primary objective. It first keeps connected application affinity groups together, packs mutually dependent groups into the same sprint, and then performs bounded unit moves and swaps only when they strictly reduce dependency crossings without breaking guardrails. Database servers and their observed application consumers are prioritized for the same sprint and wave; unavoidable cross-wave exceptions are highlighted as severe warnings on every affected wave. The planner also sequences shared infrastructure and highly depended-on groups earlier and combines or rebalances compatible groups to meet the minimum where possible. Readiness values other than `Ready` or `Ready with conditions` are deferred. The default environment order is Dev, Test, UAT, Pre-prod, then Prod, and the default data-heavy threshold is 2048 GB.

`GET /api/imports` returns the 20 most recent import runs.

`POST /api/imports` accepts up to 20 CSV/XLSX files in the multipart `files` field and returns a result for every file.

`GET /api/applications` returns the paginated application inventory. It accepts `server`, `application`, `port`, `page`, `pageSize`, and `resolution` (`resolved`, `unresolved`, or `all`). Resolution defaults to `resolved` so unnamed evidence does not obscure identified applications.

`GET /api/dependencies` accepts:

| Parameter | Description |
| --- | --- |
| `page` | 1-based page, default 1 |
| `pageSize` | 10-100, default 25 |
| `server` | Partial source or destination server name |
| `ip` | Partial source or destination IP address |
| `port` | Exact destination port |

Example: `/api/dependencies?server=CUSIDE01&port=443&page=1&pageSize=25`

## Azure deployment

The intended topology is one Linux Azure App Service hosting Express and the built React files, backed by Azure Database for MySQL Flexible Server. Azure infrastructure has intentionally not been generated against an arbitrary subscription. Before provisioning, select a subscription and validate App Service and MySQL region/SKU availability. The application requires these App Service settings:

- `MYSQL_HOST`
- `MYSQL_DATABASE`
- `MYSQL_PORT`
- `MYSQL_USER`
- `MYSQL_PASSWORD` (use a Key Vault reference)
- `MYSQL_SSL=true`
- `ENTRA_CLIENT_SECRET` (required only when Microsoft Entra ID authentication is enabled; use a Key Vault reference)
- `APPLICATIONINSIGHTS_CONNECTION_STRING`
- `NODE_ENV=production`

Reference material used for the Azure design:

- [Azure Database for MySQL connectivity](https://learn.microsoft.com/azure/mysql/flexible-server/connect-nodejs)
- [App Service managed identities](https://learn.microsoft.com/azure/app-service/overview-managed-identity)
- [App Service Key Vault references](https://learn.microsoft.com/azure/app-service/app-service-key-vault-references)