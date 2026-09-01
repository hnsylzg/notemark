# temp script: dump MSI Registry table
$q = [char]96
$msi = "C:\Users\lzg\CodeBuddy\notemark\src-tauri\target\release\bundle\msi\NoteMark_0.3.1_x64_en-US.msi"
$sql = "SELECT ${q}Key${q},${q}Name${q},${q}Value${q},${q}Component_${q} FROM ${q}Registry${q}"
$installer = New-Object -ComObject WindowsInstaller.Installer
$db = $installer.GetType().InvokeMember("OpenDatabase", "InvokeMethod", $null, $installer, @($msi, 0))
$view = $db.GetType().InvokeMember("OpenView", "InvokeMethod", $null, $db, @($sql))
$view.GetType().InvokeMember("Execute", "InvokeMethod", $null, $view, $null)
while ($null -ne ($rec = $view.GetType().InvokeMember("Fetch", "InvokeMethod", $null, $view, $null))) {
    $k = $rec.GetType().InvokeMember("StringData", "GetProperty", $null, $rec, @(1))
    $n = $rec.GetType().InvokeMember("StringData", "GetProperty", $null, $rec, @(2))
    $v = $rec.GetType().InvokeMember("StringData", "GetProperty", $null, $rec, @(3))
    $c = $rec.GetType().InvokeMember("StringData", "GetProperty", $null, $rec, @(4))
    Write-Output ("key=" + $k + " name=[" + $n + "] value=[" + $v + "] comp=" + $c)
}
