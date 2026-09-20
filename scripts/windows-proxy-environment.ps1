function Test-XiaosheNodeProxyVersion {
  param([AllowNull()][AllowEmptyString()][string]$Version)
  if ([string]::IsNullOrWhiteSpace($Version)) { return $false }
  $Match = [regex]::Match($Version.Trim(), '^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$')
  if (-not $Match.Success) { return $false }
  $Major = [int]$Match.Groups[1].Value
  $Minor = [int]$Match.Groups[2].Value
  # Credential-bearing proxy URLs were fixed after the initial env-proxy release.
  # Keep this gate aligned with package engines and fail before Node sees the flag.
  return (($Major -eq 22 -and $Minor -ge 23) -or
    ($Major -eq 24 -and $Minor -ge 17))
}

function ConvertTo-XiaosheProxyUri {
  param(
    [AllowNull()]
    [AllowEmptyString()]
    [string]$Value,
    [switch]$Strict
  )

  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $Candidate = $Value.Trim()
  if ($Candidate -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
    $Candidate = "http://$Candidate"
  }
  $Parsed = $null
  $Valid = [Uri]::TryCreate($Candidate, [UriKind]::Absolute, [ref]$Parsed)
  if (-not $Valid -or $null -eq $Parsed `
      -or $Parsed.Scheme -ne 'http' `
      -or [string]::IsNullOrWhiteSpace($Parsed.Host)) {
    if ($Strict) { throw 'HTTP_PROXY/HTTPS_PROXY must be an absolute http:// proxy URL.' }
    return $null
  }
  return $Parsed.AbsoluteUri
}

function ConvertFrom-XiaosheWindowsProxyServer {
  param(
    [AllowNull()]
    [AllowEmptyString()]
    [string]$ProxyServer
  )

  $Result = [ordered]@{ httpProxy = $null; httpsProxy = $null }
  if ([string]::IsNullOrWhiteSpace($ProxyServer)) { return [pscustomobject]$Result }

  $Parts = @($ProxyServer -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($Parts.Count -eq 1 -and $Parts[0] -notmatch '=') {
    $Proxy = ConvertTo-XiaosheProxyUri -Value $Parts[0]
    $Result.httpProxy = $Proxy
    $Result.httpsProxy = $Proxy
    return [pscustomobject]$Result
  }

  foreach ($Part in $Parts) {
    if ($Part -notmatch '^\s*([^=]+)=(.+)$') { continue }
    $Scheme = $Matches[1].Trim().ToLowerInvariant()
    $Proxy = ConvertTo-XiaosheProxyUri -Value $Matches[2]
    if ($null -eq $Proxy) { continue }
    if ($Scheme -eq 'http') { $Result.httpProxy = $Proxy }
    elseif ($Scheme -eq 'https') { $Result.httpsProxy = $Proxy }
  }
  return [pscustomobject]$Result
}

function ConvertTo-XiaosheNoProxy {
  param(
    [AllowNull()]
    [AllowEmptyString()]
    [string]$Value
  )

  $Entries = New-Object 'System.Collections.Generic.List[string]'
  $Seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($RawEntry in @($Value -split '[;,]')) {
    $Entry = $RawEntry.Trim()
    if (-not $Entry -or $Entry -eq '<-loopback>') { continue }
    if ($Entry -eq '<local>') {
      foreach ($LocalEntry in @('localhost', '127.0.0.1', '::1')) {
        if ($Seen.Add($LocalEntry)) { $Entries.Add($LocalEntry) }
      }
      continue
    }
    if ($Seen.Add($Entry)) { $Entries.Add($Entry) }
  }
  foreach ($LocalEntry in @('localhost', '127.0.0.1', '::1')) {
    if ($Seen.Add($LocalEntry)) { $Entries.Add($LocalEntry) }
  }
  return $Entries -join ','
}

function Resolve-XiaosheWindowsProxyEnvironment {
  [CmdletBinding()]
  param(
    [AllowNull()]
    [AllowEmptyString()]
    [string]$HttpProxy,
    [AllowNull()]
    [AllowEmptyString()]
    [string]$HttpsProxy,
    [AllowNull()]
    [AllowEmptyString()]
    [string]$NoProxy,
    [bool]$SystemProxyEnabled,
    [AllowNull()]
    [AllowEmptyString()]
    [string]$SystemProxyServer,
    [AllowNull()]
    [AllowEmptyString()]
    [string]$SystemProxyOverride
  )

  $HasExplicitProxy = -not [string]::IsNullOrWhiteSpace($HttpProxy) `
    -or -not [string]::IsNullOrWhiteSpace($HttpsProxy)
  if ($HasExplicitProxy) {
    $ResolvedHttp = ConvertTo-XiaosheProxyUri -Value $HttpProxy -Strict
    $ResolvedHttps = ConvertTo-XiaosheProxyUri -Value $HttpsProxy -Strict
    $ResolvedNoProxy = ConvertTo-XiaosheNoProxy -Value $NoProxy
    return [pscustomobject][ordered]@{
      enabled = $null -ne $ResolvedHttp -or $null -ne $ResolvedHttps
      httpProxy = $ResolvedHttp
      httpsProxy = $ResolvedHttps
      noProxy = $ResolvedNoProxy
      source = 'environment'
    }
  }

  if ($SystemProxyEnabled) {
    $SystemProxy = ConvertFrom-XiaosheWindowsProxyServer -ProxyServer $SystemProxyServer
    if ($null -ne $SystemProxy.httpProxy -or $null -ne $SystemProxy.httpsProxy) {
      $BypassSource = if (-not [string]::IsNullOrWhiteSpace($NoProxy)) { $NoProxy } else { $SystemProxyOverride }
      return [pscustomobject][ordered]@{
        enabled = $true
        httpProxy = $SystemProxy.httpProxy
        httpsProxy = $SystemProxy.httpsProxy
        noProxy = ConvertTo-XiaosheNoProxy -Value $BypassSource
        source = 'windows-user-proxy'
      }
    }
  }

  return [pscustomobject][ordered]@{
    enabled = $false
    httpProxy = $null
    httpsProxy = $null
    noProxy = ConvertTo-XiaosheNoProxy -Value $NoProxy
    source = 'none'
  }
}

function Invoke-XiaosheWithProxyEnvironment {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$ProxyEnvironment,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action
  )

  $SavedProxyEnvironment = @{}
  foreach ($Name in @('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY')) {
    $Path = "Env:\$Name"
    $Exists = Test-Path -LiteralPath $Path
    $SavedProxyEnvironment[$Name] = [pscustomobject]@{
      exists = $Exists
      value = if ($Exists) { (Get-Item -LiteralPath $Path).Value } else { $null }
    }
  }

  try {
    if ($null -ne $ProxyEnvironment.httpProxy) { $env:HTTP_PROXY = $ProxyEnvironment.httpProxy }
    if ($null -ne $ProxyEnvironment.httpsProxy) { $env:HTTPS_PROXY = $ProxyEnvironment.httpsProxy }
    if (-not [string]::IsNullOrWhiteSpace($ProxyEnvironment.noProxy)) { $env:NO_PROXY = $ProxyEnvironment.noProxy }
    & $Action
  } finally {
    foreach ($Name in @('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY')) {
      $Saved = $SavedProxyEnvironment[$Name]
      if ($Saved.exists) { Set-Item -LiteralPath "Env:\$Name" -Value $Saved.value }
      else { Remove-Item -LiteralPath "Env:\$Name" -ErrorAction SilentlyContinue }
    }
  }
}
