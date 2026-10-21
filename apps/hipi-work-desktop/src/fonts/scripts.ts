/**
 * Original fixed programs. No renderer data, font names, paths, or environment values are interpolated.
 * AppKit: NSFontManager.availableMembersOfFontFamily returns [PostScript name, style, weight, traits].
 * NSFont.isFixedPitch is the native classification; no trait constants or name heuristics are guessed.
 * https://developer.apple.com/documentation/appkit/nsfontmanager/availablemembers(offontfamily:)
 * https://developer.apple.com/documentation/appkit/nsfont/isfixedpitch
 */
export const MAC_FONT_SCRIPT = `
ObjC.import('AppKit');
var manager = $.NSFontManager.sharedFontManager;
var families = ObjC.deepUnwrap(manager.availableFontFamilies);
var rows = [], partial = false, inspected = 0;
outer: for (var i = 0; i < families.length; i++) {
  var members = ObjC.deepUnwrap(manager.availableMembersOfFontFamily(families[i]));
  if (!Array.isArray(members)) { partial = true; continue; }
  for (var j = 0; j < members.length; j++) {
    if (++inspected > 2048) { partial = true; break outer; }
    try {
      var font = $.NSFont.fontWithNameSize(members[j][0], 12);
      var face = {
        family: ObjC.unwrap(font.familyName),
        fullName: ObjC.unwrap(font.displayName),
        postscriptName: ObjC.unwrap(font.fontName),
        style: members[j][1]
      };
      if (Object.keys(face).some(function(k) { return typeof face[k] !== 'string' || face[k].length > 128; })) {
        partial = true; continue;
      }
      var fixedPitch = font.isFixedPitch;
      if (typeof fixedPitch !== 'boolean') { fixedPitch = null; partial = true; }
      rows.push({ face: face, monospace: fixedPitch });
    } catch (_) { partial = true; }
  }
}
JSON.stringify({ rows: rows, truncated: partial });
`;

/**
 * PresentationCore enumerates installed typefaces. Only bounded name/post metadata is read from the
 * font streams, including collection members. No binary font files or filesystem paths reach IPC.
 * No Add-Type compilation, profile loading, script policy override, external process, or network.
 * https://learn.microsoft.com/dotnet/api/system.windows.media.fonts.systemtypefaces
 * https://learn.microsoft.com/dotnet/api/system.windows.media.glyphtypeface.getfontstream
 * https://learn.microsoft.com/typography/opentype/spec/otff
 * https://learn.microsoft.com/typography/opentype/spec/post
 */
export const WINDOWS_FONT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$stage = 'assembly'
try {
Add-Type -AssemblyName PresentationCore
function U16([byte[]]$b, [int]$p) { return [int]$b[$p] * 256 + [int]$b[$p + 1] }
function U32([byte[]]$b, [int]$p) { return [long]$b[$p] * 16777216 + [long]$b[$p + 1] * 65536 + [long]$b[$p + 2] * 256 + [long]$b[$p + 3] }
function ReadBlock($s, [long]$offset, [int]$length) {
  if ($offset -lt 0 -or $length -lt 0 -or $length -gt 65536 -or $offset + $length -gt $s.Length) { throw 'Invalid font table' }
  [void]$s.Seek($offset, [System.IO.SeekOrigin]::Begin)
  $b = [byte[]]::new($length)
  $read = 0
  while ($read -lt $length) {
    $n = $s.Read($b, $read, $length - $read)
    if ($n -le 0) { throw 'Incomplete font table' }
    $read += $n
  }
  return ,$b
}
function IsLocalFontUri([System.Uri]$uri) {
  if (-not $uri.IsFile -or $uri.IsUnc) { return $false }
  $path = $uri.LocalPath
  if ($path -notmatch '^[A-Za-z]:\\') { return $false }
  $root = [System.IO.Path]::GetPathRoot($path)
  if ([System.IO.DriveInfo]::new($root).DriveType -ne [System.IO.DriveType]::Fixed) { return $false }
  $current = $root
  foreach ($segment in $path.Substring($root.Length).Split('\')) {
    if ($segment -eq '' -or $segment -eq '.' -or $segment -eq '..') { return $false }
    $current = [System.IO.Path]::Combine($current, $segment)
    if (([System.IO.File]::GetAttributes($current) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  }
  return $true
}
$rows = [System.Collections.Generic.List[object]]::new()
$seen = [System.Collections.Generic.HashSet[string]]::new()
$partial = $false
$inspected = 0
$budget = 0
$stage = 'enumeration'
:fonts foreach ($typeface in [System.Windows.Media.Fonts]::SystemTypefaces) {
  if (++$inspected -gt 4096) { $partial = $true; break }
  $glyph = $null
  $stage = 'glyph'
  if (-not $typeface.TryGetGlyphTypeface([ref]$glyph)) { $partial = $true; continue }
  if ($glyph.StyleSimulations -ne [System.Windows.Media.StyleSimulations]::None) { $partial = $true; continue }
  try {
    $stage = 'local-uri'
    if (-not (IsLocalFontUri $glyph.FontUri)) { $partial = $true; continue }
  } catch [System.UnauthorizedAccessException] { throw }
    catch [System.Security.SecurityException] { throw }
    catch { $partial = $true; continue }
  if (-not $seen.Add($glyph.FontUri.LocalPath)) { continue }
  $stream = $null
  try {
    $stage = 'font-stream'
    $stream = $glyph.GetFontStream()
    if (-not $stream.CanSeek) { $partial = $true; continue }
    $header = ReadBlock $stream 0 12
    $offsets = @(0)
    if ([System.Text.Encoding]::ASCII.GetString($header, 0, 4) -eq 'ttcf') {
      $count = U32 $header 8
      if ($count -lt 1 -or $count -gt 256) { throw 'Invalid font collection' }
      $directory = ReadBlock $stream 12 ($count * 4)
      $offsets = @(for ($i = 0; $i -lt $count; $i++) { U32 $directory ($i * 4) })
    }
    foreach ($offset in $offsets) {
      if ($rows.Count -ge 2048) { $partial = $true; break fonts }
      $header = ReadBlock $stream $offset 12
      $signature = U32 $header 0
      if ($signature -ne 65536 -and $signature -ne 1330926671) { $partial = $true; continue }
      $count = U16 $header 4
      if ($count -lt 1 -or $count -gt 256) { throw 'Invalid font directory' }
      $directory = ReadBlock $stream ($offset + 12) ($count * 16)
      $name = $null
      $mono = $null
      for ($i = 0; $i -lt $count; $i++) {
        $p = $i * 16
        $tag = [System.Text.Encoding]::ASCII.GetString($directory, $p, 4)
        $start = U32 $directory ($p + 8)
        $length = U32 $directory ($p + 12)
        if ($tag -eq 'name' -and $length -ge 6 -and $length -le 65536) {
          $name = ReadBlock $stream $start $length
        }
        if ($tag -eq 'post' -and $length -ge 32) {
          $post = ReadBlock $stream $start 32
          if ((U32 $post 0) -in @(65536, 131072, 151552, 196608)) { $mono = (U32 $post 12) -ne 0 }
        }
      }
      if ($null -eq $name) { $partial = $true; continue }
      $encoded = [Convert]::ToBase64String($name)
      $budget += $encoded.Length
      if ($budget -gt 2097152) { $partial = $true; break fonts }
      $rows.Add(@{ name = $encoded; monospace = $mono })
    }
  } catch [System.UnauthorizedAccessException] { throw }
    catch [System.Security.SecurityException] { throw }
    catch { $partial = $true }
  finally { if ($null -ne $stream) { $stream.Dispose() } }
}
$stage = 'serialization'
@{ tables = @($rows.ToArray()); truncated = $partial } | ConvertTo-Json -Compress -Depth 4
} catch [System.UnauthorizedAccessException] { [Console]::WriteLine('{"error":"DENIED","stage":"' + $stage + '"}') }
  catch [System.Security.SecurityException] { [Console]::WriteLine('{"error":"DENIED","stage":"' + $stage + '"}') }
  catch { [Console]::WriteLine('{"error":"FAILED","stage":"' + $stage + '"}') }
`;

/** Control separators cannot be part of valid metadata names; parser rejects malformed records. */
export const FONTCONFIG_FORMAT =
	"%{family[0]}\x1f%{fullname[0]}\x1f%{postscriptname[0]}\x1f%{style[0]}\x1f%{spacing[0]}\x1e";
