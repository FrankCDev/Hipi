param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$Thumbprint,
  [Parameter(Mandatory = $true)][string]$Publisher,
  [string]$Version
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$signature = Get-AuthenticodeSignature -LiteralPath $Target
if ($signature.Status -ne 'Valid' -or
    $null -eq $signature.SignerCertificate -or
    $null -eq $signature.TimeStamperCertificate -or
    $signature.SignerCertificate.Thumbprint -cne $Thumbprint -or
    $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne $Publisher) {
  throw 'Authenticode identity, trust, or timestamp verification failed.'
}
$verifiedVersion = $null
if ($Version) {
  $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Target)
  if ($info.ProductVersion -cnotin @($Version, "$Version.0")) {
    throw 'Windows product version verification failed.'
  }
  $verifiedVersion = $Version
}
[ordered]@{
  status = 'Valid'
  thumbprint = $signature.SignerCertificate.Thumbprint
  publisher = $Publisher
  timestamped = $true
  version = $verifiedVersion
} | ConvertTo-Json -Compress
