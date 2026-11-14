$ErrorActionPreference = 'Stop'
$iconPath = Join-Path $PSScriptRoot 'stock-board.ico'
if (!(Test-Path -LiteralPath $iconPath)) { throw 'Missing stock-board.ico' }
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
