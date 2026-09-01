# temp script: compare DefaultIcon resolution across progids
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class NMAssoc2 {
    [DllImport("shlwapi.dll", CharSet=CharSet.Auto, SetLastError=true)]
    public static extern uint AssocQueryString(int flags, int str, string pszAssoc, string pszExtra, StringBuilder pszOut, ref int pcchOut);
}
"@

function Query([string]$assoc, [int]$str, [string]$label) {
    $sb = New-Object System.Text.StringBuilder 1024
    $len = 1024
    $ret = [NMAssoc2]::AssocQueryString(0, $str, $assoc, $null, $sb, [ref]$len)
    $null = $sb
    Write-Output ("assoc=[{0}] {1} return={2} value=[{3}]" -f $assoc, $label, $ret, $sb.ToString())
}

Write-Output "--- DefaultIcon (ASSOCSTR_DEFAULTICON = 15) ---"
Query ".md"                 15 "DEFAULTICON"
Query "NoteMark.md"         15 "DEFAULTICON"
Query "Markdown Document"   15 "DEFAULTICON"
Query ".txt"                15 "DEFAULTICON"

Write-Output ""
Write-Output "--- ProgId (ASSOCSTR_PROGID = 20) ---"
Query ".md"   20 "PROGID"
Query ".txt"  20 "PROGID"
