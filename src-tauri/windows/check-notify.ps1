# temp script: fire SHChangeNotify(SHCNE_ASSOCCHANGED) then re-query .md association
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class NMShellNotify {
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);

    [DllImport("shlwapi.dll", CharSet=CharSet.Auto, SetLastError=true)]
    public static extern uint AssocQueryString(int flags, int str, string pszAssoc, string pszExtra, StringBuilder pszOut, ref int pcchOut);
}
"@

Write-Output "--- BEFORE notify ---"
$sb = New-Object System.Text.StringBuilder 1024
$len = 1024
$ret = [NMShellNotify]::AssocQueryString(0, 15, ".md", $null, $sb, [ref]$len)
Write-Output ("DefaultIcon return={0} value=[{1}]" -f $ret, $sb.ToString())

# SHCNE_ASSOCCHANGED = 0x08000000
[NMShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output "SHChangeNotify(SHCNE_ASSOCCHANGED) fired"
Start-Sleep -Seconds 3

Write-Output "--- AFTER notify ---"
$sb.Clear(); $len = 1024
$ret = [NMShellNotify]::AssocQueryString(0, 15, ".md", $null, $sb, [ref]$len)
Write-Output ("DefaultIcon return={0} value=[{1}]" -f $ret, $sb.ToString())

$sb.Clear(); $len = 1024
$ret = [NMShellNotify]::AssocQueryString(0, 20, ".md", $null, $sb, [ref]$len)
Write-Output ("ProgId return={0} value=[{1}]" -f $ret, $sb.ToString())
