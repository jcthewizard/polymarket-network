param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroup,
    [Parameter(Mandatory = $true)]
    [string]$AppName,
    [string]$PackagePath = "dist/polymarket-app.zip"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI ('az') is not installed or not on PATH."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageFullPath = Join-Path $repoRoot $PackagePath

& (Join-Path $PSScriptRoot "package-app.ps1") -OutputPath $PackagePath

& az webapp config appsettings set `
    --resource-group $ResourceGroup `
    --name $AppName `
    --settings ENABLE_LLM_CLASSIFICATION=0 MAX_MARKETS_STORE=500 MAX_MARKETS_CORRELATE=200 SCM_DO_BUILD_DURING_DEPLOYMENT=true
if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI appsettings update failed."
}

& az webapp deployment source config-zip `
    --resource-group $ResourceGroup `
    --name $AppName `
    --src $packageFullPath
if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI config-zip deploy failed."
}

& az webapp restart --resource-group $ResourceGroup --name $AppName
if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI webapp restart failed."
}

$dbPath = az webapp config appsettings list `
    --resource-group $ResourceGroup `
    --name $AppName `
    --query "[?name=='DB_PATH'].value | [0]" -o tsv
if ($LASTEXITCODE -ne 0) {
    throw "Failed to read DB_PATH from App Service settings."
}

$hostName = az webapp show --resource-group $ResourceGroup --name $AppName --query "defaultHostName" -o tsv
if ($LASTEXITCODE -ne 0) {
    throw "Failed to read the deployed web app hostname."
}

Write-Host "Update complete."
Write-Host "DB_PATH: $dbPath"
Write-Host "Smoke test: https://$hostName/api/data/status"
