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

While authentication is disabled, administration endpoints accept requests only from the server's loopback interface. Perform the initial administrator bootstrap from `http://localhost:3000`, then enable authentication before exposing the application through a network listener or reverse proxy. Rotate any credential that has previously appeared in source control and keep real database passwords outside `.env.example`.

Local and Microsoft Entra users can be assigned Read, Modify, and Delete privileges. Administrators receive all privileges and can manage users and authentication settings. Authorization is enforced by the Express API; navigation visibility is only a user-interface convenience. Authenticated writes require the per-session CSRF token, and session identifiers are stored as SHA-256 hashes in MySQL.

To configure Microsoft Entra ID:

1. Register a confidential web application in the required tenant.
2. Add `<application-origin>/api/auth/entra/callback` as a Web redirect URI.
3. For local development, set `ENTRA_CLIENT_SECRET` only in the server environment.
4. In **Administration**, enter the tenant ID, client ID, and redirect URI, choose default privileges for newly seen Entra users, and enable Microsoft Entra ID.

For secretless authentication on Azure App Service, assign a user-assigned managed identity to the app and add that identity as a federated credential on the Entra app registration. Use audience `api://AzureADTokenExchange`, then set `ENTRA_USE_MANAGED_IDENTITY=true` and `AZURE_CLIENT_ID=<user-assigned-identity-client-id>` on the App Service. The managed identity and app registration must be in the same tenant. When managed identity mode is enabled, `ENTRA_CLIENT_SECRET` is not used. See [Configure an application to trust a managed identity](https://learn.microsoft.com/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity).

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
- `ApplicationServerMapping-Synthetic.csv`: an import-ready application-to-server mapping with application, server, IP address, and description columns. Database servers used by multiple applications are assigned to `Shared DB`.
- `DependencyExport-Synthetic-01.csv` through `DependencyExport-Synthetic-04.csv`: four import-ready files containing 500,000 dependency observations each.
- `ApplicationCatalog-Synthetic.csv`: an import-ready catalog of 96 meaningful applications plus the `Shared DB` application and owner details.
- `SharedDatabaseInventory-Synthetic.csv`: every shared database host, its engine and environment, and the applications consuming it.
- `CoreInfrastructure-Synthetic.csv`: 86 core infrastructure assignments plus eight private load-balancer IPs, ready for the Core Infrastructure upload.
- `LoadBalancers-Synthetic.csv`, `OfficeNetworks-Synthetic.csv`, and `VPNNetworks-Synthetic.csv`: separate network-edge inventories with correlated sample endpoints.
- `NetworkRanges-Synthetic.csv`: Office and VPN CIDR ranges for Dev, Test, Pre-prod, and Prod, ready for entry in Core Infrastructure.
- `LandingZoneResourceGroups-Synthetic.csv` and `LandingZoneNetworks-Synthetic.csv`: import-ready, correlated landing-zone resources spanning non-production, pre-production, and production subscriptions.
- `Corelight-Logs-Synthetic.zip`: Corelight/Zeek newline-delimited JSON `conn.log` and `dns.log` records covering a complete calendar month. The unpacked logs are also available under `corelight/`.
- `dataset-manifest.json`: generated counts and pass/fail assertions for server roles, database engines, environments, isolation, and dependency totals.

The topology includes private load-balancer IP traffic to optional web tiers and dedicated application servers, then application/report traffic to database tiers. Applications also connect to Active Directory/DNS, proxy, print, file, backup, monitoring, management, and Configuration Manager services. Every one of the 352 application/environment deployments has its own application server. Database sharing is assigned deliberately between application cohorts within the same environment, and every shared host uses `Shared DB` as its Server Assessment application name. Web, application, report, and database servers are never shared across Dev, Test, Pre-prod, and Prod; generation fails if a tier server or tier dependency crosses an environment boundary. Twelve highly sensitive applications use isolated private address ranges and dedicated management servers. Pre-prod is generated for 64 applications with the same logical connection profile and sizing as Prod. Dev and Test use proportionally smaller compute, memory, and storage recommendations.

The operating-system fleet contains 424 Windows and 200 Linux servers, approximating the requested 3.4:1.6 ratio. Every Windows server uses Datacenter edition; Windows Server 2012 and 2012 R2 together remain below 5% of Windows hosts, while Windows Server 2025 remains below 20%. Linux is split exactly 70% RHEL and 30% SLES across RHEL 7.x/8.x/9.x and SLES 14/15/16. Core infrastructure is restricted to Windows Server 2019 or newer, or the equivalent modern Linux versions. The manifest records the exact distribution and generation-blocking policy assertions.

Upload `ServerAssessment-Synthetic-624.csv` as Server Assessment data, upload `CoreInfrastructure-Synthetic.csv` in Core Infrastructure, enter the ranges from `NetworkRanges-Synthetic.csv`, and then upload all four `DependencyExport-Synthetic-*.csv` files as Dependency data. The complete enhanced dataset generated for this workspace is in `data/generated/enhanced-624/`. Generated files are excluded from Git because the dependency exports are intentionally large. To create a smaller development slice, override the row settings:

```powershell
npm run generate:dataset -- --output-dir=data/generated/sample --dependency-count=10000 --rows-per-file=5000
```

Use `--start-date=YYYY-MM-01` to choose the month represented by the Corelight logs. For example:

```powershell
npm run generate:dataset -- --output-dir=data/generated/january-sample --dependency-count=10000 --rows-per-file=5000 --start-date=2026-01-01
```

`dependency-count` controls both the Azure Migrate dependency row count and the Corelight `conn.log` row count so the two observations are generated from the same repeating connection profiles. Corelight DNS transactions use the same `uid` as their corresponding port 53 connection. Office clients, VPN clients, and load balancers are represented in Azure Migrate dependencies and both Corelight logs. The generator streams CSV and Corelight output and creates the ZIP without loading the full dataset into memory.

Imports are recorded in `import_runs`. Failed runs retain their imported-row count and error message. Re-running an export creates another import run; it does not replace previous data.

The web application also accepts bulk uploads through its data-ingestion section. Select or drop up to eight `.csv` or `.xlsx` Azure Migrate exports per request. Each dependency file may be up to 1 GB and receives an independent completion or failure result. Workbook-based assessment, mapping, and infrastructure uploads are limited to 100 MB and validated for unsafe archive expansion before processing.

The Imports workspace guides uploads from left to right: Applications, Application Mapping, Server Assessment, then Dependency Data. It accepts an application catalog as CSV or XLSX. The catalog requires an application column and accepts an optional description column. `application`, `application name`, `applications`, and `application names` all map to the same catalog name field. `application_description`, `description`, `descriptions`, `applicationdescription`, and `applicationdescriptions` all map to the same catalog description field; `APP_NAME` and `APP_DESCRIPTION` are also supported aliases. Catalog imports update descriptions without erasing an existing description when the incoming value is empty.

Application Mapping and Server Assessment imports converge on the unique `server_assessments.server_name` key rather than maintaining separate server records. A mapping import creates a minimal assessment row when its server is not yet known; a later assessment enriches that row without replacing non-empty mapping values with missing values. Importing the assessment first works in reverse: a later mapping updates only its application, IP address, and application description, leaving assessment metrics unchanged. Both paths create missing application catalog records in the same transaction before writing the server reference, preventing application foreign-key violations.

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

## Continuous integration

The GitHub Actions workflow in `.github/workflows/ci.yml` runs for pull requests and pushes to `main`. It installs the locked dependency graph with `npm ci`, builds both workspaces, runs the backend test suite and typecheck, and uploads the compiled application as a short-lived artifact.

Frontend ESLint and the production dependency audit currently report known upstream findings, so they run as visible non-blocking checks. Once their existing baselines are cleared, remove `continue-on-error` from those workflow steps to make them required gates.

### Azure App Service deployment

After CI succeeds on `main`, `.github/workflows/deploy-app-service.yml` deploys the tested revision directly to the production App Service. The workflow does not use a deployment slot. It can also be started manually from the GitHub Actions page.

Create a GitHub environment named `production`, then configure the repository variables `AZURE_WEBAPP_NAME` and `AZURE_RESOURCE_GROUP` with the existing App Service name and resource group. Add these GitHub environment secrets:

- `AZURE_CLIENT_ID`, `AZURE_SUBSCRIPTION_ID`, and `AZURE_TENANT_ID` for Azure workload identity federation.
- `DB_HOST`, `DB_NAME`, `DB_PASSWORD`, `DB_PORT`, `DB_SSL`, and `DB_USER` for MySQL.
- `FRONTEND_ORIGIN` with the public application origin, such as `https://<app-name>.azurewebsites.net`.

Configure a federated identity credential on the Entra application for the GitHub `production` environment, with subject `repo:<owner>/<repository>:environment:production`. Grant that identity the Website Contributor role scoped to the target App Service or its resource group. No Azure client secret or publish profile is required.

## REST API

`GET /api/health` checks MySQL connectivity.

`GET /api/summary` returns record, connection, source-server, and destination-server totals.

`GET /api/core-infrastructure-servers` returns the materialized core infrastructure server inventory and category totals. Use the optional `category` query parameter to filter the returned server rows.

`POST /api/core-infrastructure-servers/refresh` rebuilds the inventory from `server_assessments`. The same rebuild runs automatically and transactionally after every successful Server Assessment import. A server may have multiple roles, such as Active Directory Domain Controller and DNS Server.

`GET /api/core-infrastructure-inputs` returns manually gathered core server-role assignments, saved VPN/load-balancer/office network ranges, and individual load-balancer addresses in `loadBalancerIps`. `PUT /api/core-infrastructure-inputs` transactionally upserts a `servers` array containing `serverName`, `role`, and `ipAddress`, an optional `networks` object containing `vpn`, `loadBalancer`, and `office` CIDR ranges, and an optional `loadBalancerIps` string array. Reusing the same server name and role updates its IP address instead of creating a duplicate. Manual rows are preserved when assessment-derived infrastructure is refreshed.

`POST /api/core-infrastructure-inputs/upload` accepts one CSV or XLSX file in the multipart `file` field. Header matching is case-insensitive and ignores spaces and punctuation; recommended columns are `server_name`, `role`, `ip_address`, and `load_balancer_ip`. Each row may contain a complete server assignment, a load-balancer IP, or both. The complete file is validated before its records are transactionally upserted.

`GET /api/application-environments` lists every application and environment represented in Server Assessment data with its server count.

The **Application Treatments** workspace lists every imported application and stores its selected strategy in `applications.treatment_plan`. Allowed values are `Rehost`, `Replatform`, `Refactor`, `Rearchitect`, `Retire`, `Retain`, and `Replace`. Applications with no stored value display as `Rehost`; use **Save treatment plans** to persist the displayed selections. `PUT /api/applications/treatment-plans` accepts an `items` array of application names and treatment plans, validates the complete request, and updates the catalog transactionally.

`GET /api/server-coverage` returns `unmappedServers` for assessed servers whose application does not resolve to the application catalog and `unconnectedServers` for assessed servers absent from both maintained dependency source and destination server sets. The **Server Coverage** workspace displays each gap with its server, environment, application, and IP address.

The **Environment Identification** workspace under **Prepare** derives `server_assessments.environment_type` from prioritized rules. Rules can inspect server name, IP address, application, resource tags, source system, operating system, migration readiness, security readiness, or OS support status. Text fields support equals, contains, starts-with, ends-with, and case-insensitive glob conditions (`*` matches any characters and `?` matches one character); IP addresses also support IPv4 and IPv6 CIDR ranges. Lower priority numbers run first, and lower-priority rules are considered only when no stronger rule matches. Multiple rules at the winning priority may reinforce the same environment, while different environments at that priority create a conflict and are not applied. `POST /api/environment-identification/preview` evaluates every assessed server without changing data and reports matches, pending changes, conflicts, unmatched servers, winning priority, and evidence. `POST /api/environment-identification/apply` transactionally saves the rules, updates only unambiguous matches, and refreshes the derived core infrastructure inventory. `GET /api/environment-identification` returns the saved rules and converts legacy name-pattern and IP-range entries to the prioritized rule format.

Dependency, Server Assessment, and Application Mapping CSV/XLSX imports map source fields to MySQL columns by normalized header name, not column position. Column matching is case-insensitive and ignores spaces and punctuation; documented aliases such as `Hostname`, `Machine Name`, `Environment`, `Source Server`, and `Destination Server` are also accepted. Reordered columns are safe, unknown columns are ignored with a warning, and absent optional columns are stored as `NULL` or preserve existing values for upserts. Imports reject missing required columns, empty or duplicate canonical headers, rows containing values beyond the declared headers, and invalid typed values with a row-specific message. Server Assessment and Application Mapping writes are transactional; failed Dependency imports remove their rows and rebuild dependency summaries, distinct server lists, and database-server evidence from retained records. Validation warnings are returned with the upload result and displayed in the Imports workspace.

Application Mapping files require `APPLICATION` and `SERVER_NAME`; `IP_ADDRESS` and `APPLICATION_DESCRIPTION` are optional. Aliases include `Application Name`, `App Name`, `FQDN`, `Machine Name`, `Hostname`, `Server`, `IP`, and `Description`. Existing `server_assessments` rows are matched by server name and update only application, IP address, application description, and import provenance. Blank optional values preserve existing data, and Azure assessment fields are never overwritten. New server names create minimal assessment rows. Duplicate server names within one file are discarded after the first row, and relevant core infrastructure rows are refreshed transactionally.

`GET /api/application-map?application=<name>&environment=<name>` returns the selected application boundary, its servers, core infrastructure connections, configured load-balancer IP connections, VPN/office network connections, Shared DB servers, and inbound, outbound, or bidirectional service edges. Connected Shared DB servers appear inside the selected application's center block and expand one dependency hop so their other inbound and outbound systems are shown by application name. Shared DB nodes expose the database server name, while servers owned by other applications are represented only by application name. The Application Map workspace enriches core nodes from `GET /api/core-infrastructure-servers`, labels configured network boundaries, and opens another application's topology when its application node is selected.

`GET /api/server-profile?server=<name>` returns a server's identity, environment, operating system, hosted applications, server classification, infrastructure roles, current CPU/memory/disk configuration, and proposed Azure VM and storage sizing. This lightweight endpoint loads independently of dependency topology aggregation.

`POST /api/migration-wave-plan` creates an ordered migration plan from Server Assessment, Infrastructure Servers, and Dependency Records. The request accepts `minimumServers`, `maximumServers`, `considerEnvironments`, `prioritizeEnvironments`, `environmentOrder`, `dataHeavyStorageGb`, `separateDataHeavyWorkloads`, `excludedApplications`, `excludedServers`, `environmentFilters`, and `treatmentPlans`. Only the selected environments are considered for wave planning; an empty selection includes all environments. Treatment filtering defaults to `Rehost`; applications without a stored treatment are treated as Rehost. Data-heavy classification is informational by default so dependency co-location remains the first priority; set `separateDataHeavyWorkloads` to `true` to enforce at most one database or storage-heavy workload per sprint. Exclusion values are exact, case-insensitive names; excluding an application removes all of its servers. The response contains summary totals, environment waves, migration sprints, server assignments, grouping rationale, deferred and excluded servers, assumptions, explicit guardrail exceptions, complete cross-sprint dependencies, environment dependency summaries, a capped list of sequencing warnings, and a save mode.

Saved planning settings and the historical set of considered servers are stored in `migration_wave_plan_filters`. Expanding or clearing a scope filter generates an additive plan that is previewed together with the previously planned waves; only servers never considered by an earlier saved plan are added, and saving appends those sprints without resetting existing tasks and can create tasks for newly introduced cross-sprint dependencies. Narrowing scope, mixing additions and removals, or changing planning constraints replaces the current plan through the existing warning flow and can recreate cross-dependency tasks. `summary.severeDatabaseWarnings` counts database/application dependencies split across waves, and each affected wave includes the corresponding records in `severeWarnings`.

`GET /api/sprint-schedule` returns the saved waves, each sprint's applications and date window, and a `serverTimeline` row for every server in `server_assessments`. Sprint dates are stored on sprint objects inside the single saved `migration_wave_plans.plan_json` document; they are not copied into assessment columns. Server timeline rows are derived by matching each assessed server to the current sprint `servers` arrays, so moving or merging a server into another sprint automatically maps it to the destination sprint's dates on the next read or export. Deferred, excluded, or otherwise unassigned assessed servers remain present with null sprint and date values.

`PUT /api/sprint-schedule` accepts a `schedules` array containing a sprint `sequence`, `targetedStartDate`, and optional `targetedEndDate`. Dates use `YYYY-MM-DD`; when an end date is omitted, the API defaults it to 21 days after the start date. The endpoint updates only schedule fields in the saved plan and preserves sprint contents, task assignments, comments, dependencies, and history. `GET /api/sprint-schedule/export?format=xlsx` downloads an Excel workbook containing Sprint Summary, Server Timeline, and Sprint Gantt worksheets. `format=pptx` downloads a paginated PowerPoint Gantt with wave, sprint, date, server, and application summaries.

`GET /api/firewall-rules` generates firewall rules for the servers in a sprint from the perspective of a chosen firewall target. It requires `target` (`nsg`, `azure-firewall`, or `on-prem`) and accepts `sprint` (`all` for the entire saved plan or a sprint `sequence` number) and `excludeCoreInfrastructure` (`true` to drop connections to core infrastructure servers, load balancer IPs, and their addresses). Rules are aggregated from `dependency_records` inbound and outbound flows, deduplicated by direction, protocol, port, and remote endpoint, and enriched with Windows service metadata from `windows_services_ports`. Local server IPs are resolved from `server_assessments`; self-referential flows are dropped. Target-specific logic applies: `nsg` keeps the Azure inbound/outbound perspective; `azure-firewall` emits only egress (outbound) rules and omits east-west traffic between sprint servers; `on-prem` flips the perspective (Azure-inbound flows become on-prem outbound and vice versa) and discards traffic between two servers in the same sprint. Remote endpoints inside the saved Office or VPN network ranges (from `core_infrastructure_networks`) are summarized to their IP prefix. The response contains the resolved `scope`, `target`, `scopeLabel`, `sprints`, a `summary` (total, inbound, outbound, core-infrastructure-excluded, same-sprint-excluded, network-summarized, unresolved, sprint server counts), `sprintAddresses`, a `truncated` flag when the rule set exceeds the 6000-rule cap, and the `rules` array (each rule carries a `peerKind` of `host`, `server`, or `network`). It returns 400 when `target` is missing or invalid, and 404 when no wave plan is saved or the requested sprint is not found.

`GET /api/firewall-rules/export` accepts the same `target`, `sprint`, and `excludeCoreInfrastructure` parameters plus `format`. `format=xlsx` downloads an Excel workbook with an Overview sheet and a single rule sheet matching the selected target. `format=terraform` and `format=bicep` are available for the `nsg` and `azure-firewall` targets only (on-prem returns 400): `nsg` produces a `.zip` of NSG resource files (`provider.tf`/`variables.tf`/`network_security_group.tf` or `main.bicep`/`nsg.bicep`), and `azure-firewall` produces an Azure Firewall Policy egress rule collection (`firewall.tf` or `main.bicep`/`firewall.bicep`). Downloaded files are named `firewall-rules-<all-sprints|sprint-N>-<target>[-<format>].{xlsx|zip}`.

The Firewall Rules workspace (Plan & deliver) requires a firewall target to be chosen before any rules are shown; it then loads the selected sprint's rules for that target, offers sprint and exclude-core-infrastructure controls, previews rules with direction and text filters, and provides an Excel download for every target plus Terraform and Bicep downloads for the Azure NSG and Azure Firewall targets. Firewall queries are served by covering indexes `idx_dependencies_inbound_fw` and `idx_dependencies_outbound_fw`. The backend applies all pending schema changes (tables, columns, indexes) automatically in the background on startup, so no manual migration step is required after provisioning or importing data; `npm run migrate --workspace backend` remains available to apply them ahead of time.

The Wave Planning workspace exports UTF-8 CSV reports for an individual sprint, the selected environment, or the complete all-environment plan. Assignment reports include planning assumptions and sprint grouping rationale. Each environment also has a cross-dependency report and CSV export containing source/destination applications, environments, waves, sprints, sequencing status, and rationale. Cross-dependency reports exclude rows where either endpoint is a core infrastructure server; those dependencies still influence planning and sequencing.

After hard environment, capacity, and data-heavy constraints, minimizing cross-sprint dependencies is the planner's primary objective. It first keeps connected application affinity groups together, packs mutually dependent groups into the same sprint, and then performs bounded unit moves and swaps only when they strictly reduce dependency crossings without breaking guardrails. Database servers and their observed application consumers are prioritized for the same sprint and wave; unavoidable cross-wave exceptions are highlighted as severe warnings on every affected wave. The planner also sequences shared infrastructure and highly depended-on groups earlier and combines or rebalances compatible groups to meet the minimum where possible. Readiness values other than `Ready` or `Ready with conditions` are deferred. The default environment order is Dev, Test, UAT, Pre-prod, then Prod, and the default data-heavy threshold is 2048 GB.

`GET /api/imports` returns the 20 most recent import runs.

`POST /api/imports` accepts up to 20 CSV/XLSX files in the multipart `files` field and returns a result for every file.

`POST /api/application-server-mappings/sheets` accepts one XLSX file in the multipart `file` field and lists its worksheet names. `POST /api/application-server-mappings/import` accepts one CSV or XLSX file in `file`; XLSX requests also require `sheetName`. A successful import returns inserted, updated, discarded, and imported row counts plus validation warnings.

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
- `ENTRA_CLIENT_SECRET` (required for Microsoft Entra ID authentication when managed identity mode is disabled; use a Key Vault reference)
- `ENTRA_USE_MANAGED_IDENTITY=true` (enables secretless Entra workload identity federation)
- `AZURE_CLIENT_ID` (client ID of the user-assigned managed identity used for federation)
- `APPLICATIONINSIGHTS_CONNECTION_STRING`
- `NODE_ENV=production`

Reference material used for the Azure design:

- [Azure Database for MySQL connectivity](https://learn.microsoft.com/azure/mysql/flexible-server/connect-nodejs)
- [App Service managed identities](https://learn.microsoft.com/azure/app-service/overview-managed-identity)
- [App Service Key Vault references](https://learn.microsoft.com/azure/app-service/app-service-key-vault-references)