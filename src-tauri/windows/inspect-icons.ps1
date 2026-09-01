# temp: dump icon groups of an exe
param([Parameter(Mandatory=$true)][string]$ExePath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ResEnumX {
    public static List<string> Lines = new List<string>();
    public delegate bool EnumProc(IntPtr hModule, IntPtr lpszType, IntPtr lpszName, IntPtr lParam);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool EnumResourceNames(IntPtr hModule, IntPtr type, EnumProc proc, IntPtr lParam);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool FreeLibrary(IntPtr hModule);
    public static bool IsInt(IntPtr p) { return ((long)p >> 16) == 0; }
    public static bool OnGroup(IntPtr m, IntPtr t, IntPtr n, IntPtr l) {
        if (IsInt(n)) Lines.Add("GROUP_ICON id = " + n.ToInt64());
        else Lines.Add("GROUP_ICON name = " + Marshal.PtrToStringUni(n));
        return true;
    }
}
"@
$exe = (Resolve-Path $ExePath).Path
Write-Output ("exe: " + $exe)
$h = [ResEnumX]::LoadLibraryEx($exe, [IntPtr]::Zero, 0x2)
if ($h -eq [IntPtr]::Zero) { throw "LoadLibraryEx failed" }
try {
    $g = [ResEnumX+EnumProc]{ param($m,$t,$n,$l) [ResEnumX]::OnGroup($m,$t,$n,$l) }
    [void][ResEnumX]::EnumResourceNames($h, [IntPtr]14, $g, [IntPtr]::Zero)
} finally { [void][ResEnumX]::FreeLibrary($h) }
[ResEnumX]::Lines | ForEach-Object { Write-Output $_ }
