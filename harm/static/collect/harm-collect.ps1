# Zom's HaRM spec collector for Windows (PowerShell 5.1+).
# Read-only: prints this machine's hardware details as JSON. Nothing is sent
# anywhere. Copy the output and paste it into HaRM (device page > Import specs).
$ErrorActionPreference = 'SilentlyContinue'

$cs   = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$os   = Get-CimInstance Win32_OperatingSystem
$cpus = @(Get-CimInstance Win32_Processor)
$memTypes = @{ 20 = 'DDR'; 21 = 'DDR2'; 24 = 'DDR3'; 26 = 'DDR4'; 34 = 'DDR5'; 35 = 'LPDDR5' }

$dimms = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
  [pscustomobject]@{
    size_bytes   = [int64]$_.Capacity
    type         = $memTypes[[int]$_.SMBIOSMemoryType]
    speed        = $_.Speed
    manufacturer = "$($_.Manufacturer)".Trim()
    part         = "$($_.PartNumber)".Trim()
    serial       = "$($_.SerialNumber)".Trim()
    locator      = $_.DeviceLocator
    form         = $_.FormFactor
  }
})

$disks = @(Get-PhysicalDisk | ForEach-Object {
  [pscustomobject]@{ model = $_.FriendlyName; serial = "$($_.SerialNumber)".Trim(); size_bytes = [int64]$_.Size
                     media = "$($_.MediaType)"; bus = "$($_.BusType)" }
})
if ($disks.Count -eq 0) {
  $disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object {
    [pscustomobject]@{ model = $_.Model; serial = "$($_.SerialNumber)".Trim(); size_bytes = [int64]$_.Size
                       media = "$($_.MediaType)"; bus = "$($_.InterfaceType)" }
  })
}

$nics = @(Get-NetAdapter -Physical | ForEach-Object {
  $idx = $_.ifIndex
  [pscustomobject]@{
    name  = $_.Name; description = $_.InterfaceDescription; mac = $_.MacAddress; speed = $_.LinkSpeed
    status = "$($_.Status)"
    ipv4  = @(Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
    ipv6  = @(Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv6 | Where-Object { $_.PrefixOrigin -ne 'WellKnown' -and $_.IPAddress -notlike 'fe80*' } | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
    dhcp  = "$((Get-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4).Dhcp)"
  }
})

[pscustomobject]@{
  harm_collect = 1
  platform     = 'windows'
  hostname     = $env:COMPUTERNAME
  os           = "$($os.Caption) $($os.Version)".Trim()
  system       = [pscustomobject]@{ manufacturer = $cs.Manufacturer; product = $cs.Model; serial = $bios.SerialNumber }
  cpu          = [pscustomobject]@{ model = ($cpus | Select-Object -First 1).Name; sockets = $cpus.Count
                                    cores = ($cpus | Measure-Object NumberOfCores -Sum).Sum
                                    threads = ($cpus | Measure-Object NumberOfLogicalProcessors -Sum).Sum }
  mem_total_bytes = [int64]$cs.TotalPhysicalMemory
  dimms        = $dimms
  disks        = $disks
  nics         = $nics
  gpus         = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })
} | ConvertTo-Json -Depth 5 -Compress
