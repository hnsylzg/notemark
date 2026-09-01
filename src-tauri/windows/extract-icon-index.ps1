# temp: extract icon by index from exe
param([Parameter(Mandatory=$true)][string]$ExePath, [Parameter(Mandatory=$true)][int]$Index, [Parameter(Mandatory=$true)][string]$OutPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
public static class IconEx {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
    public static extern uint ExtractIconEx(string szFileName, int nIconIndex, out IntPtr phiconLarge, out IntPtr phiconSmall, uint nIcons);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
"@
$hl = [IntPtr]::Zero
$hs = [IntPtr]::Zero
$ok = [IconEx]::ExtractIconEx((Resolve-Path $ExePath).Path, $Index, [ref]$hl, [ref]$hs, 1)
if ($hl -eq [IntPtr]::Zero) { throw "no icon at index $Index" }
$ico = [System.Drawing.Icon]::FromHandle($hl)
$bmp = $ico.ToBitmap()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
[void][IconEx]::DestroyIcon($hl)
if ($hs -ne [IntPtr]::Zero) { [void][IconEx]::DestroyIcon($hs) }
Write-Output "extracted"
