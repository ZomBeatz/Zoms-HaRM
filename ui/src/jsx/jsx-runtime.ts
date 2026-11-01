/* React's JSX runtime, plus one thing: text inside elements gets its interface symbols drawn as
 * Lucide icons (see lib/icons). Set as jsxImportSource in tsconfig.json and vite.config.ts. */
import type { ElementType, Key } from 'react';
import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from 'react/jsx-runtime';
import { NO_ICONS, withIcons } from '../lib/icons';

export { Fragment };
export type { JSX } from 'react/jsx-runtime';

type Props = Record<string, unknown> & { children?: unknown };

function iconText(kid: unknown): unknown {
  return typeof kid === 'string' ? withIcons(kid) : kid;
}

export function withIconProps(type: unknown, props: Props): Props {
  // Fragments too: <>text with 📷</> passed as a child would otherwise keep its symbols.
  if (!(typeof type === 'string' ? !NO_ICONS.has(type) : type === Fragment) || props.children == null) return props;
  const kids = props.children;
  if (typeof kids === 'string') {
    const out = withIcons(kids);
    return out === kids ? props : { ...props, children: out };
  }
  if (Array.isArray(kids) && kids.some(k => typeof k === 'string')) return { ...props, children: kids.map(iconText) };
  return props;
}

export function jsx(type: ElementType, props: Props, key?: Key) {
  return reactJsx(type, withIconProps(type, props), key);
}
export function jsxs(type: ElementType, props: Props, key?: Key) {
  return reactJsxs(type, withIconProps(type, props), key);
}
