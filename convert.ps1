# convert.ps1 - source\<video>.mp4  ->  clips\clip_<ID>.txt  (+ clips\clip_<ID>.subs.json)
# Usage:  .\convert.ps1 video.mp4 001
#         .\convert.ps1 video.mp4 001 -NoSubs      (skip the transcript)
param(
  [Parameter(Mandatory=$true)][string]$Video,
  [Parameter(Mandatory=$true)][string]$Id,
  [switch]$NoSubs
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# pick up programs installed after this terminal was opened (ffmpeg, gcc, python)
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path','User')
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw 'ffmpeg not found. Install it with:  winget install Gyan.FFmpeg   then reopen VS Code.'
}

$W = 118; $H = 33          # characters per frame (about 1.4x the old 100x28 area)
$Id = $Id.PadLeft(3, '0')

$src = if (Test-Path $Video) { $Video } else { Join-Path 'source' $Video }
if (-not (Test-Path $src)) { throw "Can't find $Video (also looked in the source folder)" }
New-Item -ItemType Directory -Force clips | Out-Null

# (re)build the converter if it's missing or older than the .c file
if (-not (Test-Path ascii_conv.exe) -or
    (Get-Item ascii_conv.c).LastWriteTime -gt (Get-Item ascii_conv.exe).LastWriteTime) {
  Write-Host 'Compiling ascii_conv...'
  gcc -O2 -o ascii_conv ascii_conv.c -lm
  if ($LASTEXITCODE -ne 0) { throw 'Compile failed' }
}

$raw = "clips\temp_$Id.raw"
ffmpeg -y -loglevel error -i $src -vf "fps=12,scale=${W}:${H}" -f rawvideo -pix_fmt gray $raw
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg failed' }
.\ascii_conv.exe $raw $Id $W $H "clips\clip_$Id.txt"
Remove-Item $raw

if (-not $NoSubs) {
  $py = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { 'py' }
  & $py make_subs.py $src $Id
}
