/* Icons a service card can show (Services > Edit card). Plain symbols, no brand logos. */
import {
  Activity, Bell, Book, BookOpen, Bot, Box, Calendar, ChartColumn, Cloud, Code, Container, Cpu, Database, Download, FileText,
  Film, Folder, Gamepad2, Gauge, Globe, HardDrive, Headphones, House, Image, KeyRound, Lightbulb, Lock, Mail, MessageSquare,
  Monitor, Music, Network, Phone, Plug, Printer, Puzzle, Radio, Router, Rss, Search, Server, Shield, ShoppingCart,
  SquareTerminal, Thermometer, Tv, Video, Wifi, Workflow, Wrench, Zap, type LucideIcon,
} from 'lucide-react';

export const SERVICE_ICONS: Record<string, [LucideIcon, string]> = {
  'globe': [Globe, 'Web page'], 'server': [Server, 'Server'], 'monitor': [Monitor, 'Admin page'], 'film': [Film, 'Movies'],
  'tv': [Tv, 'TV'], 'music': [Music, 'Music'], 'headphones': [Headphones, 'Audio'], 'image': [Image, 'Photos'],
  'video': [Video, 'Cameras'], 'house': [House, 'Smart home'], 'lightbulb': [Lightbulb, 'Lights'], 'thermometer': [Thermometer, 'Climate'],
  'shield': [Shield, 'Security'], 'lock': [Lock, 'Passwords'], 'key-round': [KeyRound, 'Keys'], 'router': [Router, 'Router'],
  'wifi': [Wifi, 'Wi-Fi'], 'network': [Network, 'Network'], 'database': [Database, 'Database'], 'hard-drive': [HardDrive, 'Storage'],
  'folder': [Folder, 'Files'], 'cloud': [Cloud, 'Cloud'], 'download': [Download, 'Downloads'], 'container': [Container, 'Containers'],
  'box': [Box, 'Box'], 'cpu': [Cpu, 'Compute'], 'gauge': [Gauge, 'Dashboard'], 'chart-column': [ChartColumn, 'Charts'],
  'activity': [Activity, 'Monitoring'], 'bell': [Bell, 'Alerts'], 'mail': [Mail, 'Mail'], 'message-square': [MessageSquare, 'Chat'],
  'phone': [Phone, 'Phone'], 'calendar': [Calendar, 'Calendar'], 'book-open': [BookOpen, 'Reading'], 'book': [Book, 'Docs'],
  'file-text': [FileText, 'Documents'], 'rss': [Rss, 'Feeds'], 'search': [Search, 'Search'], 'bot': [Bot, 'AI'],
  'code': [Code, 'Code'], 'square-terminal': [SquareTerminal, 'Terminal'], 'workflow': [Workflow, 'Automation'],
  'gamepad': [Gamepad2, 'Games'], 'printer': [Printer, 'Printer'], 'shopping-cart': [ShoppingCart, 'Shopping'],
  'radio': [Radio, 'Radio'], 'plug': [Plug, 'Power'], 'zap': [Zap, 'Energy'], 'puzzle': [Puzzle, 'Other'], 'wrench': [Wrench, 'Tools'],
};

/* A guess from the name, for cards without a chosen icon. */
const GUESS: [RegExp, string][] = [
  [/plex|jellyfin|emby|radarr|sonarr|movie|film/i, 'film'], [/music|navidrome|lidarr|spotify/i, 'music'],
  [/photo|immich|photoprism/i, 'image'], [/camera|frigate|nvr|blue ?iris|cctv/i, 'video'],
  [/home ?assistant|openhab|hubitat/i, 'house'], [/pi-?hole|adguard|dns/i, 'shield'], [/vault|bitwarden|password/i, 'lock'],
  [/unifi|router|pfsense|opnsense|openwrt|mikrotik/i, 'router'], [/nextcloud|seafile|owncloud/i, 'cloud'],
  [/nas|dsm|truenas|unraid|smb|storage/i, 'hard-drive'], [/portainer|docker|kuma|grafana|prometheus|netdata/i, 'activity'],
  [/proxmox|esxi|vcenter|idrac|ilo|ipmi/i, 'server'], [/ssh|terminal|shell/i, 'square-terminal'], [/mail/i, 'mail'],
  [/paperless|docs?|wiki/i, 'file-text'], [/torrent|sabnzbd|nzb|download/i, 'download'], [/git|code/i, 'code'],
  [/n8n|node-?red|automation/i, 'workflow'], [/printer|octoprint|cups/i, 'printer'], [/game|minecraft|steam/i, 'gamepad'],
];
export function serviceIcon(icon: string | null | undefined, name: string): LucideIcon {
  if (icon && SERVICE_ICONS[icon]) return SERVICE_ICONS[icon][0];
  const g = GUESS.find(([re]) => re.test(name));
  return SERVICE_ICONS[g ? g[1] : 'globe'][0];
}

export const SERVICE_COLORS: Record<string, string> = {
  blue: 'var(--zb-blue)', orange: 'var(--zb-orange)', green: 'var(--zb-ok)', purple: 'var(--zb-cat-3)',
  red: 'var(--zb-danger)', teal: 'var(--zb-cat-5)', yellow: 'var(--zb-warn)', gray: 'var(--zb-slate)',
};
