# Exports one Office document to PDF using the installed Office application.
#
# The source and destination paths arrive in NEXA_SRC and NEXA_DST rather than as
# arguments. A filename is user-controlled text: passed on the command line it
# would be re-parsed by PowerShell, and a file named `-Command` or one containing
# a quote would change what this script does. An environment variable is data and
# is never parsed, which removes that entire class of problem.
#
# Office is driven read-only and told not to prompt: a conversion must never be
# able to modify the source, and a modal dialog on a headless run would hang the
# application until the user found the invisible window.

$ErrorActionPreference = 'Stop'

[string]$src = $env:NEXA_SRC
[string]$dst = $env:NEXA_DST

if (-not $src -or -not $dst) { Write-Error 'NEXA_SRC and NEXA_DST must both be set.'; exit 2 }
if (-not (Test-Path -LiteralPath $src)) { Write-Error "Source does not exist: $src"; exit 3 }

$ext = [System.IO.Path]::GetExtension($src).ToLowerInvariant()

function Release($o) {
  if ($o) { try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) | Out-Null } catch {} }
}

switch -Regex ($ext) {

  '^\.(docx?|docm|rtf|odt|txt|html?)$' {
    $app = New-Object -ComObject Word.Application
    $app.Visible = $false
    $app.DisplayAlerts = 0
    try {
      # ConfirmConversions=$false, ReadOnly=$true, AddToRecentFiles=$false
      $doc = $app.Documents.Open($src, $false, $true, $false)
      try {
        $doc.ExportAsFixedFormat($dst, 17)   # 17 = wdExportFormatPDF
      } finally {
        $doc.Close(0)                        # 0 = wdDoNotSaveChanges
        Release $doc
      }
    } finally { $app.Quit(); Release $app }   # no argument: Quit's is by-reference
  }

  '^\.(pptx?|pptm|odp)$' {
    # PowerPoint has no supported invisible mode: setting Visible=$false throws on
    # most builds. It is opened WithWindow=$false instead, which keeps it off the
    # screen for the life of the conversion.
    $app = New-Object -ComObject PowerPoint.Application
    try {
      $pres = $app.Presentations.Open($src, $true, $false, $false)  # ReadOnly, Untitled, WithWindow
      try {
        $pres.SaveAs($dst, 32)               # 32 = ppSaveAsPDF
      } finally {
        $pres.Close()
        Release $pres
      }
    } finally { $app.Quit(); Release $app }
  }

  '^\.(xlsx?|xlsm|xlsb|csv|ods)$' {
    $app = New-Object -ComObject Excel.Application
    $app.Visible = $false
    $app.DisplayAlerts = $false
    try {
      $wb = $app.Workbooks.Open($src, 0, $true)   # UpdateLinks=0, ReadOnly=$true
      try {
        $wb.ExportAsFixedFormat(0, $dst)          # 0 = xlTypePDF
      } finally {
        $wb.Close($false)
        Release $wb
      }
    } finally { $app.Quit(); Release $app }
  }

  default { Write-Error "No Office application handles $ext"; exit 4 }
}

if (-not (Test-Path -LiteralPath $dst)) {
  Write-Error 'The Office application reported success but wrote no file.'
  exit 5
}
Write-Output ((Get-Item -LiteralPath $dst).Length)
