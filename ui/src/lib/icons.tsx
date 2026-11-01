/* Interface symbols (📷 ⚙ ▤ …) in text are drawn as Lucide icons, per the ZomBeatz design system.
 * The JSX runtime (src/jsx) runs every text child of an element through withIcons(), so labels
 * can keep writing "📷 Scan label" and get the camera icon. */
import { Fragment, createElement, type ReactNode } from 'react';
import {
  Activity, Bell, Bot, Boxes, Cable, Camera, ChartColumn, ChevronDown, ChevronRight, CircleHelp, Clipboard, Compass, Copy,
  Download, ExternalLink, Eye, EyeOff, Flag, Globe, Hammer, HardDrive, House, Keyboard, KeyRound, Layers, Library, ListChecks,
  Lock, MapPin, Maximize, Menu, MessageSquare, Monitor, Moon, Network, NotebookPen, Package, Pencil, Pin, Play, Plug, Power,
  Printer, QrCode, Radar, RotateCw, ScrollText, Server, Settings, Share2, Shield, Smartphone, Snowflake, Square, Star, Sun,
  SunMoon, Tag, Trash2, TriangleAlert, Video, Wrench, Zap, type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  'house': House, 'list-checks': ListChecks, 'monitor': Monitor, 'layers': Layers, 'server': Server, 'package': Package,
  'hammer': Hammer, 'network': Network, 'radar': Radar, 'key-round': KeyRound, 'map-pin': MapPin, 'cable': Cable,
  'library': Library, 'share-2': Share2, 'scroll-text': ScrollText, 'settings': Settings, 'circle-help': CircleHelp,
  'menu': Menu, 'camera': Camera, 'bot': Bot, 'download': Download, 'trash-2': Trash2, 'notebook-pen': NotebookPen,
  'smartphone': Smartphone, 'clipboard': Clipboard, 'tag': Tag, 'external-link': ExternalLink, 'plug': Plug, 'pin': Pin,
  'globe': Globe, 'snowflake': Snowflake, 'qr-code': QrCode, 'wrench': Wrench, 'lock': Lock, 'pencil': Pencil, 'flag': Flag,
  'star': Star, 'chevron-down': ChevronDown, 'chevron-right': ChevronRight, 'compass': Compass, 'shield': Shield,
  'printer': Printer, 'hard-drive': HardDrive, 'video': Video, 'moon': Moon, 'sun': Sun, 'sun-moon': SunMoon,
  'rotate-cw': RotateCw, 'boxes': Boxes, 'triangle-alert': TriangleAlert, 'play': Play, 'square': Square, 'copy': Copy,
  'message-square': MessageSquare, 'keyboard': Keyboard, 'activity': Activity, 'zap': Zap, 'power': Power,
  'maximize': Maximize, 'bell': Bell, 'chart-column': ChartColumn, 'eye': Eye, 'eye-off': EyeOff,
};

export const ICON_FOR: Record<string, string> = {
  '◧': 'house', '☑': 'list-checks', '▤': 'monitor', '⧉': 'layers', '▥': 'server', '◫': 'package', '⚒': 'hammer',
  '⌗': 'network', '⌖': 'radar', '🔑': 'key-round', '⌂': 'map-pin', '⇄': 'cable', '▦': 'library', '⇪': 'share-2',
  '📜': 'scroll-text', '⚙': 'settings', '❓': 'circle-help', '☰': 'menu', '📷': 'camera', '📸': 'camera', '🤖': 'bot',
  '⬇': 'download', '⇩': 'download', '⤓': 'download', '🗑': 'trash-2', '📝': 'notebook-pen', '🖥': 'monitor', '📱': 'smartphone',
  '📋': 'clipboard', '🏷': 'tag', '↗': 'external-link', '🔌': 'plug', '📌': 'pin', '🌐': 'globe', '❄': 'snowflake',
  '🔳': 'qr-code', '🔧': 'wrench', '🛠': 'wrench', '🔒': 'lock', '✎': 'pencil', '⚑': 'flag', '★': 'star', '☆': 'star',
  '▾': 'chevron-down', '▸': 'chevron-right', '🧭': 'compass', '🛡': 'shield', '🖨': 'printer', '📍': 'map-pin',
  '💾': 'hard-drive', '🎥': 'video', '🌙': 'moon', '☀': 'sun', '◐': 'sun-moon', '⟳': 'rotate-cw', '🧩': 'boxes',
  '⚠': 'triangle-alert', '▶': 'play', '■': 'square', '⎘': 'copy', '💬': 'message-square', '⌨': 'keyboard', '📶': 'activity',
  '⚡': 'zap', '⏻': 'power', '⛶': 'maximize', '🔔': 'bell', '📊': 'chart-column', '🎉': '',
};
/* Elements whose text stays as typed. */
export const NO_ICONS = new Set(['option', 'textarea', 'title', 'style', 'script', 'code', 'pre']);
const KEYS = Object.keys(ICON_FOR).filter(k => k.length <= 2).sort((a, b) => b.length - a.length);
const SPLIT = new RegExp(`(${KEYS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\uFE0F?`, 'u');
const TEST = new RegExp(SPLIT.source, 'u');

/* A Lucide icon by name, as an inline SVG. */
export function Ic({ name, cls = '' }: { name: string; cls?: string }) {
  const Icon = ICONS[name];
  return Icon ? <Icon className={`ic ${cls}`.trim()} aria-hidden="true" /> : null;
}

/* Text with its symbols swapped for icons; plain text comes back unchanged. */
export function withIcons(text: string): ReactNode {
  if (!TEST.test(text)) return text;
  const parts: ReactNode[] = [];
  for (const part of text.split(SPLIT)) {
    if (!part) continue;
    const name = ICON_FOR[part];
    if (name === '') continue;
    parts.push(name ? createElement(Ic, { name, key: parts.length }) : part);
  }
  return createElement(Fragment, null, ...parts);
}
