# 把 md-file.ico 作为额外图标组(ID 40000)写入 notemark.exe。
#
# 为什么是 40000:Tauri 生成的主图标组 ID 是 32512(0x7F00)。
# Windows 按资源 ID 升序给图标组排索引:索引 0 = ID 最小的组。
# 若 md 组 ID 小于 32512(如 101),它就会变成索引 0,
# 导致 notemark.exe 自身的默认图标被顶成文档图标。
# 所以 md 组必须大于 32512,让索引 0 = 主图标(32512)、索引 1 = md 图标(40000)。
# 注册表 DefaultIcon 用 "notemark.exe,1" 引用 md 图标。
# 注意:必须让本脚本的 RT_ICON 名称(2001..)避开主图标的 1..N,否则资源冲突。
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$exe = Join-Path $root 'target\release\notemark.exe'
$icoPath = Join-Path $root 'icons\md-file.ico'

if (-not (Test-Path $exe)) { throw "not found: $exe" }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ResEdit {
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cb);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
}
"@

$ico = [System.IO.File]::ReadAllBytes($icoPath)
if ($ico.Length -lt 6) { throw "invalid ico" }
$count = [BitConverter]::ToUInt16($ico, 4)
if ($count -eq 0 -or $count -gt 64) { throw "invalid icon count: $count" }

$images = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $count; $i++) {
    $off = 6 + $i * 16
    $bytesInRes = [BitConverter]::ToUInt32($ico, $off + 8)
    $imageOffset = [BitConverter]::ToUInt32($ico, $off + 12)
    $data = New-Object byte[] $bytesInRes
    [Array]::Copy($ico, [int]$imageOffset, $data, 0, [int]$bytesInRes)
    $null = $images.Add(@{
        w = $ico[$off]
        h = $ico[$off + 1]
        colorCount = $ico[$off + 2]
        planes = [BitConverter]::ToUInt16($ico, $off + 4)
        bitCount = [BitConverter]::ToUInt16($ico, $off + 6)
        bytesInRes = $bytesInRes
        data = $data
    })
}

$h = [ResEdit]::BeginUpdateResource($exe, $false)
if ($h -eq [IntPtr]::Zero) { throw "BeginUpdateResource failed, error=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

# 组 ID:40000(必须大于主图标组的 32512);内部 RT_ICON 名称:2001..(避开主图标占用的 1..N)
$groupMs = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($groupMs)
$bw.Write([UInt16]0)          # reserved
$bw.Write([UInt16]1)          # type = icon
$bw.Write([UInt16]$count)     # image count
$idStart = 2001
for ($i = 0; $i -lt $count; $i++) {
    $img = $images[$i]
    $id = $idStart + $i
    $ok = [ResEdit]::UpdateResource($h, [IntPtr]3, [IntPtr]$id, 0x0409, $img.data, [UInt32]$img.bytesInRes)
    if (-not $ok) { throw "UpdateResource RT_ICON $id failed, error=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    $bw.Write([byte]$img.w)
    $bw.Write([byte]$img.h)
    $bw.Write([byte]$img.colorCount)
    $bw.Write([byte]0)
    $bw.Write([UInt16]$img.planes)
    $bw.Write([UInt16]$img.bitCount)
    $bw.Write([UInt32]$img.bytesInRes)
    $bw.Write([UInt16]$id)
}
$bw.Flush()
$groupData = $groupMs.ToArray()
$ok = [ResEdit]::UpdateResource($h, [IntPtr]14, [IntPtr]40000, 0x0409, $groupData, [UInt32]$groupData.Length)
if (-not $ok) { throw "UpdateResource RT_GROUP_ICON 40000 failed, error=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

$null = [ResEdit]::EndUpdateResource($h, $false)
Write-Output "OK: embedded $count images into $exe (group ID 40000)"
