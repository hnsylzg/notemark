# temp script: compare exe icon indices vs actual .md associated icon
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeIcons {
    [DllImport("shell32.dll", CharSet=CharSet.Auto)]
    public static extern uint ExtractIconEx(string szFileName, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
"@

$out = Join-Path $env:TEMP "nm_icons"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$exe = "C:\Program Files\NoteMark\notemark.exe"

# 1) extract exe icon at index 0 and 1
foreach ($idx in 0,1) {
    $large = New-Object IntPtr[] 1
    $small = New-Object IntPtr[] 1
    $null = [NativeIcons]::ExtractIconEx($exe, $idx, $large, $small, 1)
    $h = $large[0]
    if ($h -ne [IntPtr]::Zero) {
        $icon = [System.Drawing.Icon]::FromHandle($h)
        $icon.ToBitmap().Save((Join-Path $out "exe_icon_$idx.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $null = [NativeIcons]::DestroyIcon($h)
        Write-Output "exe icon index $idx : OK"
    } else {
        Write-Output "exe icon index $idx : no handle"
    }
}

# 2) associated icon of a .md file
$md = Join-Path $env:TEMP "nm_test_icon.md"
Set-Content -Path $md -Value "# test" -Encoding UTF8
$assoc = [System.Drawing.Icon]::ExtractAssociatedIcon($md)
if ($assoc -ne $null) {
    $assoc.ToBitmap().Save((Join-Path $out "md_associated.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output "md associated icon : OK"
} else {
    Write-Output "md associated icon : null"
}

Write-Output "output dir: $out"
