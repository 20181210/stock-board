$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconPath = Join-Path $PSScriptRoot 'guanshi.ico'
$bitmap = New-Object System.Drawing.Bitmap 64,64
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(34,158,137))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 5
$graphics.DrawLines($pen, [System.Drawing.Point[]]@((New-Object System.Drawing.Point 12,46),(New-Object System.Drawing.Point 27,29),(New-Object System.Drawing.Point 39,36),(New-Object System.Drawing.Point 53,15)))
$graphics.DrawLine($pen, 41,15,53,15)
$graphics.DrawLine($pen, 53,15,53,28)
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$stream = [System.IO.File]::Create($iconPath)
try { $icon.Save($stream) } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $pen.Dispose() }
$desktopDirectory = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopDirectory '股票看板.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"' + (Join-Path $PSScriptRoot 'launch.vbs') + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.IconLocation = $iconPath
$shortcut.Description = '股票看板：美股、外汇、黄金、A股、加密货币，自定义周期与画图'
$shortcut.Save()
Write-Output $shortcutPath
