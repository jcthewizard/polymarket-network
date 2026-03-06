param(
    [string]$ResourceGroup = "rg-polymarket-test"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI ('az') is not installed or not on PATH."
}

& az group delete --name $ResourceGroup --yes --no-wait
if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI resource group delete failed."
}

Write-Host "Deletion requested for resource group: $ResourceGroup"
