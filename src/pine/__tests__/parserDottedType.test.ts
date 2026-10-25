// Dotted type annotations: `var zigzag.ZigZag zigZag = zigzag.newInstance(settings)`.
// `zigzag` is an import alias, so the type name is a qualified `ns.Type`.
import { describe, expect, it } from 'vitest';
import type { Node } from '../contracts';
import { parse } from '../parser';

const body = (src: string): Node[] => parse(src).body;

describe('parser: namespaced type annotations', () => {
  it('parses a top-level `var ns.Type name = ...` declaration', () => {
    const nodes = body('var zigzag.ZigZag zigZag = zigzag.newInstance(settings)\n');
    const decl = nodes[0] as Extract<Node, { type: 'var' }>;
    expect(decl.type).toBe('var');
    expect(decl.name).toBe('zigZag');
    expect(decl.typeAnn).toBe('zigzag.ZigZag');
    expect(decl.value.type).toBe('call');
  });

  it('parses a namespaced type declaration inside an indented block', () => {
    const nodes = body(
      'if barstate.isfirst\n' +
      '    var zigzag.ZigZag zigZag = zigzag.newInstance(settings)\n',
    );
    const iff = nodes[0] as Extract<Node, { type: 'if' }>;
    expect(iff.type).toBe('if');
    const inner = iff.then[0] as Extract<Node, { type: 'var' }>;
    expect(inner.type).toBe('var');
    expect(inner.typeAnn).toBe('zigzag.ZigZag');
  });

  it('keeps `x = zigzag.newInstance(settings)` an assignment, not a declaration', () => {
    const nodes = body('x = zigzag.newInstance(settings)\n');
    const n = nodes[0] as Extract<Node, { type: 'assign' }>;
    expect(n.type).toBe('assign');
    expect(n.name).toBe('x');
  });

  it('keeps a lone `zigzag.newInstance(settings)` a call statement', () => {
    const nodes = body('zigzag.newInstance(settings)\n');
    expect(nodes[0]!.type).toBe('call');
  });

  it('accepts an unqualified typed decl with the same shape', () => {
    const nodes = body('ZigZag zigZag = zigzag.newInstance(settings)\n');
    const n = nodes[0] as Extract<Node, { type: 'typed' }>;
    expect(n.type).toBe('typed');
    expect(n.ann).toBe('ZigZag');
  });

  it('leaves existing generic and qualified annotations unchanged', () => {
    const nodes = body(
      'array<float> x = array.new<float>(0)\n' +
      'series float y = 1\n' +
      'int[] z = array.new<int>(0)\n',
    );
    expect((nodes[0] as Extract<Node, { type: 'typed' }>).ann).toBe('array<float>');
    expect((nodes[1] as Extract<Node, { type: 'typed' }>).ann).toBe('series float');
    expect((nodes[2] as Extract<Node, { type: 'typed' }>).ann).toBe('int[]');
  });
});
