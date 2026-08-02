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

`GET /api/imports` returns the 20 most recent import runs.

`POST /api/imports` accepts up to 20 CSV/XLSX files in the multipart `files` field and returns a result for every file.

`GET /api/applications` returns the paginated application inventory. It accepts `server`, `application`, `port`, `page`, `pageSize`, and `resolution` (`resolved`, `unresolved`, or `all`). Resolution defaults to `resolved` so unnamed evidence does not obscure identified applications.

`GET /api/dependencies` accepts:

| Parameter | Description |
| --- | --- |
| `page` | 1-based page, default 1 |
| `pageSize` | 10-100, default 25 |
| `source` | Partial source server name |
| `destination` | Partial destination server name |
| `application` | Partial source or destination application |
| `port` | Exact destination port |

Example: `/api/dependencies?source=UTWMSWEB8V&port=443&page=1&pageSize=25`

## Azure deployment

The intended topology is one Linux Azure App Service hosting Express and the built React files, backed by Azure Database for MySQL Flexible Server. Azure infrastructure has intentionally not been generated against an arbitrary subscription. Before provisioning, select a subscription and validate App Service and MySQL region/SKU availability. The application requires these App Service settings:

- `MYSQL_HOST`
- `MYSQL_DATABASE`
- `MYSQL_PORT`
- `MYSQL_USER`
- `MYSQL_PASSWORD` (use a Key Vault reference)
- `MYSQL_SSL=true`
- `APPLICATIONINSIGHTS_CONNECTION_STRING`
- `NODE_ENV=production`

Reference material used for the Azure design:

- [Azure Database for MySQL connectivity](https://learn.microsoft.com/azure/mysql/flexible-server/connect-nodejs)
- [App Service managed identities](https://learn.microsoft.com/azure/app-service/overview-managed-identity)
- [App Service Key Vault references](https://learn.microsoft.com/azure/app-service/app-service-key-vault-references)