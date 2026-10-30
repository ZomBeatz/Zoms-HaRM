#!/usr/bin/env bash
# Zom's HaRM spec collector for Linux and macOS.
# Read-only: prints this machine's hardware details as JSON. Nothing is sent
# anywhere. Copy the output and paste it into HaRM (device page > Import specs).
# Run with sudo on Linux to include the serial number and memory module details.
set -u
export LC_ALL=C

esc() {  # JSON string
  local s=${1-}
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\t'/ }; s=${s//$'\r'/}; s=${s//$'\n'/ }
  printf '"%s"' "$s"
}
have() { command -v "$1" >/dev/null 2>&1; }
readf() { [ -r "$1" ] && tr -d '\n' < "$1" 2>/dev/null; }

if [ "$(uname -s)" = "Darwin" ]; then
  printf '{"harm_collect":1,"platform":"macos","hostname":%s,"os":%s,"profile":' \
    "$(esc "$(scutil --get LocalHostName 2>/dev/null || hostname)")" \
    "$(esc "macOS $(sw_vers -productVersion 2>/dev/null)")"
  system_profiler -json SPHardwareDataType SPMemoryDataType SPNVMeDataType SPSerialATADataType \
    SPNetworkDataType SPDisplaysDataType 2>/dev/null || printf '{}'
  printf '}\n'
  exit 0
fi

# ---------------------------------------------------------------- Linux
os=""
[ -r /etc/os-release ] && os=$(. /etc/os-release; echo "${PRETTY_NAME:-$NAME}")
vendor=$(readf /sys/class/dmi/id/sys_vendor); product=$(readf /sys/class/dmi/id/product_name)
serial=$(readf /sys/class/dmi/id/product_serial); board=$(readf /sys/class/dmi/id/board_name)
if [ -z "$serial" ] && have dmidecode && [ "$(id -u)" = 0 ]; then
  serial=$(dmidecode -s system-serial-number 2>/dev/null | head -n1)
fi
cpu=$(awk -F': ' '/^model name/{print $2; exit}' /proc/cpuinfo 2>/dev/null)
[ -z "$cpu" ] && cpu=$(awk -F': ' '/^Hardware|^Model/{print $2; exit}' /proc/cpuinfo 2>/dev/null)
threads=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 0)
sockets=$(awk -F': ' '/^physical id/{print $2}' /proc/cpuinfo 2>/dev/null | sort -u | wc -l)
cores=$(awk -F': ' '/^cpu cores/{print $2; exit}' /proc/cpuinfo 2>/dev/null)
memkb=$(awk '/^MemTotal/{print $2}' /proc/meminfo 2>/dev/null)

printf '{"harm_collect":1,"platform":"linux","hostname":%s,"os":%s,"kernel":%s,' \
  "$(esc "$(hostname 2>/dev/null)")" "$(esc "$os")" "$(esc "$(uname -r)")"
printf '"system":{"manufacturer":%s,"product":%s,"serial":%s,"board":%s},' \
  "$(esc "$vendor")" "$(esc "$product")" "$(esc "$serial")" "$(esc "$board")"
printf '"cpu":{"model":%s,"sockets":%s,"cores_per_socket":%s,"threads":%s},' \
  "$(esc "$cpu")" "${sockets:-0}" "${cores:-0}" "${threads:-0}"
printf '"mem_total_kb":%s,' "${memkb:-0}"

# Memory modules (needs root)
printf '"dimms":['
if have dmidecode && [ "$(id -u)" = 0 ]; then
  dmidecode -t 17 2>/dev/null | awk '
    function e(s){ gsub(/\\/,"\\\\",s); gsub(/"/,"\\\"",s); return "\"" s "\"" }
    /^Memory Device/ { if (n++) flush(); split("",f) }
    /^\t[A-Za-z ]+: / { k=$0; sub(/^\t/,"",k); v=k; sub(/: .*/,"",k); sub(/^[^:]*: /,"",v); f[k]=v }
    function flush() {
      if (f["Size"] ~ /^[0-9]/) {
        printf "%s{\"size\":%s,\"type\":%s,\"speed\":%s,\"manufacturer\":%s,\"part\":%s,\"serial\":%s,\"locator\":%s,\"form\":%s}",
          (out++ ? "," : ""), e(f["Size"]), e(f["Type"]), e(f["Speed"]), e(f["Manufacturer"]),
          e(f["Part Number"]), e(f["Serial Number"]), e(f["Locator"]), e(f["Form Factor"])
      }
    }
    END { if (n) flush() }'
fi
printf '],'

# Disks
printf '"lsblk":'
if have lsblk; then
  lsblk -J -b -d -o NAME,MODEL,SERIAL,SIZE,ROTA,TRAN,TYPE,VENDOR 2>/dev/null || printf '{}'
else
  printf '{}'
fi
printf ','

# Network
printf '"ip":'
if have ip && ip -j addr >/dev/null 2>&1; then ip -j addr; else printf '[]'; fi
printf ',"links":['
first=1
for d in /sys/class/net/*; do
  n=${d##*/}; [ "$n" = lo ] && continue
  sp=$(cat "$d/speed" 2>/dev/null || true)
  phys=0; [ -e "$d/device" ] && phys=1
  [ $first = 1 ] || printf ','; first=0
  printf '{"name":%s,"speed":%s,"physical":%s}' "$(esc "$n")" "$(esc "$sp")" "$phys"
done
printf '],'

# GPUs
printf '"gpus":['
if have lspci; then
  first=1
  while IFS= read -r line; do
    [ $first = 1 ] || printf ','; first=0
    esc "${line#*: }"
  done < <(lspci 2>/dev/null | grep -Ei 'vga|3d controller|display controller')
fi
printf ']}\n'
