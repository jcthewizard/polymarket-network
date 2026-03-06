param(
    [string]$ResourceGroup = "rg-polymarket-test",
    [string]$Location = "westus2",
    [string]$PlanName = "asp-polymarket-test",
    [string]$AppName,
    [string]$Sku = "B1",
    [string]$PackagePath = "dist/polymarket-app.zip",
    [string]$AllowedIp,
    [string]$OpenAiApiKey = $env:OPENAI_API_KEY,
    [string]$PolyPrivateKey = $env:POLY_PRIVATE_KEY,
    [switch]$ResetResourceGroup
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$PSNativeCommandUseErrorActionPreference = $true

function Test-AzureCliInstalled {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw "Azure CLI ('az') is not installed or not on PATH."
    }
}

function Invoke-AzCli {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $quotedArguments = foreach ($argument in $Arguments) {
        '"' + ($argument -replace '"', '\"') + '"'
    }

    $commandText = "az " + ($quotedArguments -join " ") + " 2>&1"
    $output = cmd /c $commandText
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI command failed: az $($Arguments -join ' ')"
    }
}

function Get-AllowedLocationList {
    $policy = az policy assignment list --query "[?name=='sys.regionrestriction'] | [0].parameters.listOfAllowedLocations.value" -o json
    if ($LASTEXITCODE -ne 0 -or -not $policy) {
        return @()
    }

    $locations = $policy | ConvertFrom-Json
    if ($locations -is [System.Array]) {
        return $locations
    }

    if ($locations) {
        return @($locations)
    }

    return @()
}

function Resolve-DeployLocation {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RequestedLocation
    )

    $allowedLocations = Get-AllowedLocationList
    if (-not $allowedLocations -or $allowedLocations.Count -eq 0) {
        return $RequestedLocation
    }

    if ($allowedLocations -contains $RequestedLocation) {
        return $RequestedLocation
    }

    $preferredOrder = @("westus2", "westus", "southcentralus", "eastus2", "centralus")
    foreach ($candidate in $preferredOrder) {
        if ($allowedLocations -contains $candidate) {
            Write-Host "Requested location '$RequestedLocation' is blocked by policy. Using allowed location '$candidate' instead."
            return $candidate
        }
    }

    $fallback = $allowedLocations[0]
    Write-Host "Requested location '$RequestedLocation' is blocked by policy. Using allowed location '$fallback' instead."
    return $fallback
}

function Get-PreferredDeployLocations {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RequestedLocation
    )

    $allowedLocations = Get-AllowedLocationList
    if (-not $allowedLocations -or $allowedLocations.Count -eq 0) {
        return @($RequestedLocation)
    }

    $preferredOrder = @($RequestedLocation, "eastus2", "westus2", "westus", "southcentralus", "centralus")
    $ordered = New-Object System.Collections.Generic.List[string]

    foreach ($candidate in $preferredOrder) {
        if (($allowedLocations -contains $candidate) -and (-not $ordered.Contains($candidate))) {
            $ordered.Add($candidate)
        }
    }

    foreach ($candidate in $allowedLocations) {
        if (-not $ordered.Contains($candidate)) {
            $ordered.Add($candidate)
        }
    }

    return $ordered.ToArray()
}

function New-AppServicePlanWithFallback {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PlanName,
        [Parameter(Mandatory = $true)]
        [string]$ResourceGroup,
        [Parameter(Mandatory = $true)]
        [string]$Sku,
        [Parameter(Mandatory = $true)]
        [string[]]$CandidateLocations
    )

    foreach ($candidateLocation in $CandidateLocations) {
        Write-Host "Creating App Service plan in '$candidateLocation'..."
        $azCommand = "az appservice plan create --name `"$PlanName`" --resource-group `"$ResourceGroup`" --location `"$candidateLocation`" --sku `"$Sku`" --is-linux 2>&1"
        $planOutput = cmd /c $azCommand

        if ($LASTEXITCODE -eq 0) {
            return $candidateLocation
        }

        $errorText = ($planOutput | Out-String)
        if ($errorText -match "additional quota" -or $errorText -match "RequestDisallowedByAzure" -or $errorText -match "disallowed by Azure") {
            Write-Host "Region '$candidateLocation' failed for App Service plan creation. Trying next allowed region..."
            continue
        }

        throw "Azure CLI command failed while creating the App Service plan in '$candidateLocation'."
    }

    throw "Unable to create the App Service plan in any allowed region. Tried: $($CandidateLocations -join ', ')"
}

function Wait-ForResourceGroupDeletion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    while ($true) {
        $exists = az group exists --name $Name
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to check whether resource group '$Name' exists."
        }

        if ($exists -eq "false") {
            return
        }

        Write-Host "Waiting for resource group '$Name' deletion to complete..."
        Start-Sleep -Seconds 10
    }
}

function Test-WebAppExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ResourceGroup,
        [Parameter(Mandatory = $true)]
        [string]$AppName
    )

    $output = az webapp show --resource-group $ResourceGroup --name $AppName --query name -o tsv 2>$null
    return ($LASTEXITCODE -eq 0 -and $output -eq $AppName)
}

function Test-AppServicePlanExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ResourceGroup,
        [Parameter(Mandatory = $true)]
        [string]$PlanName
    )

    $output = az appservice plan show --resource-group $ResourceGroup --name $PlanName --query name -o tsv 2>$null
    return ($LASTEXITCODE -eq 0 -and $output -eq $PlanName)
}

function Wait-ForWebAppReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ResourceGroup,
        [Parameter(Mandatory = $true)]
        [string]$AppName
    )

    while ($true) {
        $state = cmd /c "az webapp show --resource-group ""$ResourceGroup"" --name ""$AppName"" --query state -o tsv 2>nul"
        if ($LASTEXITCODE -eq 0 -and $state) {
            return
        }

        Write-Host "Waiting for web app '$AppName' to become queryable..."
        Start-Sleep -Seconds 10
    }
}

function Test-AccessRestrictionRuleExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ResourceGroup,
        [Parameter(Mandatory = $true)]
        [string]$AppName,
        [Parameter(Mandatory = $true)]
        [string]$RuleName
    )

    $ruleName = cmd /c "az webapp config access-restriction show --resource-group ""$ResourceGroup"" --name ""$AppName"" --query ""ipSecurityRestrictions[?name=='$RuleName'].name | [0]"" -o tsv 2>nul"
    return ($LASTEXITCODE -eq 0 -and $ruleName -eq $RuleName)
}

function Get-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Key
    )

    if (-not (Test-Path $Path)) {
        return $null
    }

    foreach ($line in Get-Content $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) {
            continue
        }
        if ($trimmed -like "$Key=*") {
            return $trimmed.Substring($Key.Length + 1).Trim()
        }
    }

    return $null
}

$dotenvPath = Join-Path $repoRoot ".env"
Test-AzureCliInstalled
$Location = Resolve-DeployLocation -RequestedLocation $Location
$planCandidateLocations = Get-PreferredDeployLocations -RequestedLocation $Location

if (-not $OpenAiApiKey) {
    $OpenAiApiKey = Get-DotEnvValue -Path $dotenvPath -Key "OPENAI_API_KEY"
}

if (-not $PolyPrivateKey) {
    $PolyPrivateKey = Get-DotEnvValue -Path $dotenvPath -Key "POLY_PRIVATE_KEY"
}

if (-not $AppName) {
    $suffix = -join ((97..122) + (48..57) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
    $AppName = "app-polymarket-test-$suffix"
}

if (-not $AllowedIp) {
    try {
        $AllowedIp = (Invoke-RestMethod -Uri "https://api.ipify.org?format=text" -TimeoutSec 15).Trim()
    }
    catch {
        throw "AllowedIp not provided and public IP auto-detection failed."
    }
}

if (-not $OpenAiApiKey) {
    throw "OpenAiApiKey is required."
}

if (-not $PolyPrivateKey) {
    throw "PolyPrivateKey is required for live trading deployment."
}

$packageFullPath = Join-Path $repoRoot $PackagePath

if (-not (Test-Path $packageFullPath)) {
    & (Join-Path $PSScriptRoot "package-app.ps1") -OutputPath $PackagePath
}

$null = Invoke-AzCli -Arguments @("provider", "register", "--namespace", "Microsoft.Web")

do {
    Start-Sleep -Seconds 5
    $registrationState = az provider show -n Microsoft.Web --query registrationState -o tsv
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to read Microsoft.Web registration state."
    }
    Write-Host "Microsoft.Web registration state: $registrationState"
} while ($registrationState -ne "Registered")

$resourceGroupExists = az group exists --name $ResourceGroup
if ($LASTEXITCODE -ne 0) {
    throw "Failed to check whether resource group '$ResourceGroup' exists."
}

if ($resourceGroupExists -eq "true") {
    $existingLocation = az group show --name $ResourceGroup --query location -o tsv
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to read existing resource group '$ResourceGroup'."
    }

    if ($ResetResourceGroup) {
        Write-Host "Deleting existing resource group '$ResourceGroup' before redeploy..."
        $null = Invoke-AzCli -Arguments @("group", "delete", "--name", $ResourceGroup, "--yes")
        Wait-ForResourceGroupDeletion -Name $ResourceGroup
    }
    elseif ($existingLocation -ne $Location) {
        throw "Resource group '$ResourceGroup' already exists in location '$existingLocation'. Re-run with -ResetResourceGroup to wipe it and redeploy into '$Location'."
    }
}

$null = Invoke-AzCli -Arguments @("group", "create", "--name", $ResourceGroup, "--location", $Location)

if (Test-AppServicePlanExists -ResourceGroup $ResourceGroup -PlanName $PlanName) {
    $AppServiceLocation = az appservice plan show --resource-group $ResourceGroup --name $PlanName --query location -o tsv
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to read existing App Service plan '$PlanName'."
    }
    Write-Host "Reusing existing App Service plan '$PlanName' in '$AppServiceLocation'."
}
else {
    $AppServiceLocation = New-AppServicePlanWithFallback `
        -PlanName $PlanName `
        -ResourceGroup $ResourceGroup `
        -Sku $Sku `
        -CandidateLocations $planCandidateLocations
}

if (Test-WebAppExists -ResourceGroup $ResourceGroup -AppName $AppName) {
    Write-Host "Reusing existing web app '$AppName'."
}
else {
    $null = Invoke-AzCli -Arguments @(
        "webapp", "create",
        "--resource-group", $ResourceGroup,
        "--plan", $PlanName,
        "--name", $AppName,
        "--runtime", "PYTHON:3.11"
    )
}

Wait-ForWebAppReady -ResourceGroup $ResourceGroup -AppName $AppName

$null = Invoke-AzCli -Arguments @(
    "webapp", "config", "set",
    "--resource-group", $ResourceGroup,
    "--name", $AppName,
    "--startup-file", "python server.py",
    "--always-on", "true",
    "--http20-enabled", "true"
)

$null = Invoke-AzCli -Arguments @(
    "webapp", "update",
    "--resource-group", $ResourceGroup,
    "--name", $AppName,
    "--https-only", "true"
)

$appSettings = @(
    "SCM_DO_BUILD_DURING_DEPLOYMENT=true",
    "PORT=8000",
    "DB_PATH=/home/data/polymarket.db",
    "ENABLE_LLM_CLASSIFICATION=0",
    "MAX_MARKETS_STORE=500",
    "MAX_MARKETS_CORRELATE=200",
    "OPENAI_API_KEY=$OpenAiApiKey",
    "POLY_PRIVATE_KEY=$PolyPrivateKey",
    "TRADING_MODE=live",
    "TRADING_ENABLED=false",
    "BET_SIZE_USDC=1.00",
    "TRACKER_POLL_INTERVAL=10",
    "POSITION_POLL_INTERVAL=5",
    "FILL_CHECK_INTERVAL=10",
    "POSITION_EXIT_SECONDS=180",
    "STALE_ORDER_SECONDS=60",
    "SELL_DISCOUNT_PCT=0.02",
    "OPENAI_REQS_PER_SEC=1.2",
    "OPENAI_BURST_SIZE=3",
    "CLOB_REQS_PER_SEC=2.0",
    "CLOB_BURST_SIZE=4",
    "GAMMA_REQS_PER_SEC=2.0",
    "GAMMA_BURST_SIZE=4",
    "LLM_MAX_RETRIES=6",
    "DISCOVER_LLM_BATCH_SIZE=50",
    "BACKTEST_LLM_BATCH_SIZE=50",
    "REFRESH_INTERVAL=600",
    "AUTO_REFRESH=1"
)

$appSettingsArguments = @(
    "webapp", "config", "appsettings", "set",
    "--resource-group", $ResourceGroup,
    "--name", $AppName,
    "--settings"
) + $appSettings

$null = Invoke-AzCli -Arguments $appSettingsArguments

$null = Invoke-AzCli -Arguments @(
    "webapp", "config", "appsettings", "delete",
    "--resource-group", $ResourceGroup,
    "--name", $AppName,
    "--setting-names", "WEBSITE_RUN_FROM_PACKAGE"
)

if (-not (Test-AccessRestrictionRuleExists -ResourceGroup $ResourceGroup -AppName $AppName -RuleName "AllowMyIp")) {
    $null = Invoke-AzCli -Arguments @(
        "webapp", "config", "access-restriction", "add",
        "--resource-group", $ResourceGroup,
        "--name", $AppName,
        "--rule-name", "AllowMyIp",
        "--action", "Allow",
        "--ip-address", "$AllowedIp/32",
        "--priority", "100"
    )
}

if (-not (Test-AccessRestrictionRuleExists -ResourceGroup $ResourceGroup -AppName $AppName -RuleName "DenyAll")) {
    $null = Invoke-AzCli -Arguments @(
        "webapp", "config", "access-restriction", "add",
        "--resource-group", $ResourceGroup,
        "--name", $AppName,
        "--rule-name", "DenyAll",
        "--action", "Deny",
        "--ip-address", "0.0.0.0/0",
        "--priority", "200"
    )
}

$null = Invoke-AzCli -Arguments @(
    "webapp", "deployment", "source", "config-zip",
    "--resource-group", $ResourceGroup,
    "--name", $AppName,
    "--src", $packageFullPath
)

$null = Invoke-AzCli -Arguments @("webapp", "restart", "--resource-group", $ResourceGroup, "--name", $AppName)

$hostName = az webapp show --resource-group $ResourceGroup --name $AppName --query "defaultHostName" -o tsv
if ($LASTEXITCODE -ne 0) {
    throw "Failed to read the deployed web app hostname."
}

Write-Host "Deployment complete."
Write-Host "Resource group: $ResourceGroup"
Write-Host "App name: $AppName"
Write-Host "URL: https://$hostName"
