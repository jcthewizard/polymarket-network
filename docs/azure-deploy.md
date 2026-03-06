# Azure Deployment

This app is deployed as a single Linux Azure App Service with Azure CLI `zip deploy`.

## Prerequisites

- Azure CLI installed and logged in with `az login`
- PowerShell
- `OPENAI_API_KEY` available in either your current shell env or the repo `.env`
- `POLY_PRIVATE_KEY` available in either your current shell env or the repo `.env`

## One-time deploy

Run:

```powershell
$env:OPENAI_API_KEY = "your-openai-key"
$env:POLY_PRIVATE_KEY = "your-polygon-private-key"
.\scripts\azure-deploy.ps1
```

Optional parameters:

```powershell
.\scripts\azure-deploy.ps1 `
  -ResourceGroup "rg-polymarket-test" `
  -Location "westus2" `
  -PlanName "asp-polymarket-test" `
  -AppName "app-polymarket-test-abc123" `
  -AllowedIp "x.x.x.x"
```

The deploy script now checks the subscription region restriction policy and will automatically switch to an allowed region if the requested one is blocked. The current default is `westus2`.

The script will:

- create the resource group
- create the Linux App Service plan
- create the Python 3.11 web app
- set App Service settings
- restrict access to your IP
- build a deployment zip
- deploy and restart the app

## Update after code changes

Run:

```powershell
.\scripts\azure-update.ps1 `
  -ResourceGroup "rg-polymarket-test" `
  -AppName "app-polymarket-test-abc123"
```

This rebuilds the zip, redeploys, restarts the app, and prints the smoke test URL.

## Delete everything

Run:

```powershell
.\scripts\azure-delete.ps1 -ResourceGroup "rg-polymarket-test"
```

Deleting the resource group removes the full test environment.

## Runtime settings used

Core:

- `SCM_DO_BUILD_DURING_DEPLOYMENT=true`
- `WEBSITE_RUN_FROM_PACKAGE=1`
- `PORT=8000`
- `DB_PATH=/home/data/polymarket.db`

Trading:

- `TRADING_MODE=live`
- `TRADING_ENABLED=false`

Refresh:

- `AUTO_REFRESH=1`
- `REFRESH_INTERVAL=600`

## Packaging behavior

The deployment zip excludes:

- `.git/`
- `.github/`
- `.venv/`
- `venv/`
- `__pycache__/`
- `.pytest_cache/`
- `data/`
- `dist/`
- `.env`
- `tmp_*.json`

## Smoke checks

After deployment, verify:

```text
GET /api/data/status
GET /
GET /trading.html
```

Then confirm:

- the app starts cleanly
- market refresh works
- relationships can be discovered
- autotrader is only started manually
