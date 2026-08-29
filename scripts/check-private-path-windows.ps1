[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0, ValueFromRemainingArguments)]
  [string[]]$LiteralPath
)

$ErrorActionPreference = 'Stop'
$CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$AllowedSids = @(
  $CurrentSid,
  'S-1-5-18',
  'S-1-5-32-544',
  'S-1-3-4'
)

$Results = foreach ($Candidate in $LiteralPath) {
  $Resolved = [IO.Path]::GetFullPath($Candidate)
  if ([IO.Directory]::Exists($Resolved)) {
    $Acl = [IO.Directory]::GetAccessControl($Resolved)
  } elseif ([IO.File]::Exists($Resolved)) {
    $Acl = [IO.File]::GetAccessControl($Resolved)
  } else {
    throw "Path does not exist: $Resolved"
  }
  $OwnerSid = $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $UnexpectedAllowSids = @(
    $Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
      Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow } |
      ForEach-Object { $_.IdentityReference.Value } |
      Where-Object { $_ -notin $AllowedSids } |
      Sort-Object -Unique
  )
  [pscustomobject]@{
    path = $Resolved
    private = $OwnerSid -eq $CurrentSid -and $UnexpectedAllowSids.Count -eq 0
    ownerSid = $OwnerSid
    currentSid = $CurrentSid
    aclProtected = $Acl.AreAccessRulesProtected
    unexpectedAllowSids = $UnexpectedAllowSids
  }
}

[pscustomobject]@{
  private = @($Results | Where-Object { -not $_.private }).Count -eq 0
  paths = @($Results)
} | ConvertTo-Json -Depth 5 -Compress
