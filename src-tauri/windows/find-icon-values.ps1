# temp script: find every registry value referencing notemark.exe
$targets = @("HKCU:\Software\Classes", "HKLM:\Software\Classes")

foreach ($root in $targets) {
    Write-Output "=== scanning $root ==="
    Get-ChildItem -Path $root -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        $key = $_
        foreach ($name in $key.GetValueNames()) {
            $val = ""
            try { $val = [string]$key.GetValue($name) } catch { continue }
            if ($val -match "notemark\.exe") {
                $label = if ($name -eq "") { "(Default)" } else { $name }
                Write-Output ("  {0}  [{1}] = {2}" -f $key.PSPath.Replace("Microsoft.PowerShell.Core\Registry::", ""), $label, $val)
            }
        }
    }
}
