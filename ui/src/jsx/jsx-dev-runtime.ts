import type { ElementType, Key, ReactElement } from 'react';
import { Fragment, jsxDEV as reactJsxDEV } from 'react/jsx-dev-runtime';
import { withIconProps } from './jsx-runtime';

export { Fragment };
export type { JSX } from 'react/jsx-dev-runtime';

export function jsxDEV(type: ElementType, props: Record<string, unknown>, key: Key | undefined,
  isStatic: boolean, source?: unknown, self?: unknown) {
  return (reactJsxDEV as (...a: unknown[]) => ReactElement)(type, withIconProps(type, props), key, isStatic, source, self);
}
