/**
 * Renders hook-free Preact view trees in Node (Vitest runs without a DOM): function components are
 * called with their props, host elements are kept with their props, and the result can be searched,
 * read as text and "clicked" by calling the element's handler. Signals are read when a component is
 * called, so calling the view again after an action shows the new state. Not a test file.
 */
import type { ComponentChildren, VNode } from 'preact';

type Props = Record<string, unknown>;

export interface HostNode {
  type: string;
  props: Props;
  children: TreeNode[];
}

export type TreeNode = HostNode | string;

/** Expands `node` into host elements and text. */
export function renderTree(node: ComponentChildren): TreeNode[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') return [String(node)];
  if (Array.isArray(node)) return node.flatMap((n) => renderTree(n as ComponentChildren));
  const v = node as VNode<Props>;
  if (typeof v.type === 'function') return renderTree((v.type as (p: Props) => ComponentChildren)(v.props));
  const { children, ...props } = v.props;
  return [{ type: v.type as string, props, children: renderTree(children as ComponentChildren) }];
}

function list(n: TreeNode | readonly TreeNode[]): readonly TreeNode[] {
  return Array.isArray(n) ? n : [n as TreeNode];
}

/** Concatenated text content. */
export function textOf(n: TreeNode | readonly TreeNode[]): string {
  return list(n)
    .map((x) => (typeof x === 'string' ? x : textOf(x.children)))
    .join('');
}

/** Every element (document order) that matches. */
export function findAll(n: TreeNode | readonly TreeNode[], match: (el: HostNode) => boolean): HostNode[] {
  const out: HostNode[] = [];
  const walk = (x: TreeNode): void => {
    if (typeof x === 'string') return;
    if (match(x)) out.push(x);
    x.children.forEach(walk);
  };
  list(n).forEach(walk);
  return out;
}

/** The one element that matches; throws when there is none or more than one. */
export function only(n: TreeNode | readonly TreeNode[], match: (el: HostNode) => boolean, what = 'element'): HostNode {
  const hits = findAll(n, match);
  if (hits.length !== 1) throw new Error(`expected one ${what}, found ${hits.length}`);
  return hits[0] as HostNode;
}

/** Elements of `type`. */
export const byType =
  (type: string) =>
  (el: HostNode): boolean =>
    el.type === type;

/** Elements carrying attribute `name` (with `value`, when given; compared as strings). */
export const byAttr =
  (name: string, value?: string | number) =>
  (el: HostNode): boolean =>
    el.props[name] !== undefined && (value === undefined || String(el.props[name]) === String(value));

/** The button whose text content starts with `text`. */
export function button(n: TreeNode | readonly TreeNode[], text: string): HostNode {
  return only(n, (el) => el.type === 'button' && textOf(el.children).startsWith(text), `button "${text}"`);
}

/** The buttons' texts, in order. */
export function buttonTexts(n: TreeNode | readonly TreeNode[]): string[] {
  return findAll(n, byType('button')).map((b) => textOf(b.children));
}

export function isDisabled(el: HostNode): boolean {
  return el.props.disabled === true;
}

/** Calls the element's onClick like a tap; throws when it has none or is disabled. */
export function click(el: HostNode): void {
  if (isDisabled(el)) throw new Error(`clicked a disabled ${el.type}`);
  const handler = el.props.onClick;
  if (typeof handler !== 'function') throw new Error(`${el.type} has no onClick`);
  (handler as (e: unknown) => void)({ preventDefault() {}, currentTarget: el });
}

/** Calls an input's onInput with `value`. */
export function input(el: HostNode, value: string): void {
  const handler = el.props.onInput;
  if (typeof handler !== 'function') throw new Error(`${el.type} has no onInput`);
  (handler as (e: unknown) => void)({ currentTarget: { value }, target: { value } });
}

/** Calls a form's onSubmit; returns whether the handler prevented the default (page) submit. */
export function submit(el: HostNode): boolean {
  const handler = el.props.onSubmit;
  if (typeof handler !== 'function') throw new Error(`${el.type} has no onSubmit`);
  let prevented = false;
  (handler as (e: unknown) => void)({
    preventDefault() {
      prevented = true;
    },
  });
  return prevented;
}
