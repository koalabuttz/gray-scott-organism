/**
 * Round-3 review (MINOR): the gate publisher is a **failure-safe two-rename swap**, not a single
 * atomic replacement, and it must restore the previous tree byte-for-byte when the second rename
 * fails. This is GPU-free and Playwright-free, so it runs in the vitest suite instead of the browser
 * suite; it publishes only into a throwaway temp root and never touches `artifacts/`.
 */
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GatePublisher, stagingLeftovers, treeDigest, type RenameFn } from './support/gate-publish.ts';

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-publish-test-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('GatePublisher (failure-safe two-rename swap)', () => {
  it('publishes the staged tree and leaves no temp directories', () => {
    const root = tempRoot();
    const publisher = new GatePublisher('tree', root);
    publisher.write('a.txt', 'one');
    publisher.write('nested/b.txt', 'two');
    expect(publisher.stagedFiles()).toEqual(['a.txt', 'nested/b.txt']);

    publisher.publish();

    expect(readFileSync(join(root, 'tree', 'a.txt'), 'utf8')).toBe('one');
    expect(readFileSync(join(root, 'tree', 'nested', 'b.txt'), 'utf8')).toBe('two');
    expect(stagingLeftovers('tree', root)).toEqual([]);
  });

  it('replaces an existing published tree on success', () => {
    const root = tempRoot();
    const first = new GatePublisher('tree', root);
    first.write('a.txt', 'one');
    first.publish();

    const second = new GatePublisher('tree', root);
    second.write('a.txt', 'two');
    second.write('b.txt', 'three');
    second.publish();

    expect(readFileSync(join(root, 'tree', 'a.txt'), 'utf8')).toBe('two');
    expect(readFileSync(join(root, 'tree', 'b.txt'), 'utf8')).toBe('three');
    expect(stagingLeftovers('tree', root)).toEqual([]);
  });

  it('restores the previous tree byte-for-byte when the second rename fails', () => {
    const root = tempRoot();
    // Establish an existing published tree.
    const existing = new GatePublisher('tree', root);
    existing.write('a.txt', 'original');
    existing.write('nested/b.txt', 'original-nested');
    existing.publish();
    const before = treeDigest(join(root, 'tree'));
    expect(Object.keys(before).sort()).toEqual(['a.txt', 'nested/b.txt']);

    // Inject a rename that succeeds for the first swap (final -> backup) but fails for the second
    // (staging -> final): the two-rename swap must recover, not leave a missing or mixed tree.
    let calls = 0;
    let failedCall = 0;
    const failingRename: RenameFn = (from, to) => {
      calls += 1;
      if (calls === 2) {
        failedCall = 2;
        throw new Error('injected second-rename failure');
      }
      renameSync(from, to);
    };
    const publisher = new GatePublisher('tree', root, { rename: failingRename });
    publisher.write('a.txt', 'replacement');
    publisher.write('extra.txt', 'replacement-only');

    expect(() => publisher.publish()).toThrow(/injected second-rename failure/);
    expect(failedCall).toBe(2); // the *second* rename (staging -> final) was the one that failed
    expect(calls).toBe(3); // ...and the catch-path restore rename went through afterwards

    // The old tree is restored byte-for-byte — no mixed tree, no missing directory.
    expect(treeDigest(join(root, 'tree'))).toEqual(before);
    expect(readFileSync(join(root, 'tree', 'a.txt'), 'utf8')).toBe('original');
    expect(readFileSync(join(root, 'tree', 'nested', 'b.txt'), 'utf8')).toBe('original-nested');

    // The un-published staging tree is still present until abort(), which removes it; the backup was
    // already renamed back, so it is not left behind either.
    const leftovers = stagingLeftovers('tree', root);
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toContain('.tree.staging-');
    publisher.abort();
    expect(stagingLeftovers('tree', root)).toEqual([]);
    expect(treeDigest(join(root, 'tree'))).toEqual(before);
  });

  it('publishes nothing when the first rename (no previous tree) fails', () => {
    const root = tempRoot();
    const failingRename: RenameFn = () => {
      throw new Error('injected first-rename failure');
    };
    const publisher = new GatePublisher('fresh', root, { rename: failingRename });
    publisher.write('a.txt', 'x');

    expect(() => publisher.publish()).toThrow(/injected first-rename failure/);
    // No previous tree existed, so there is nothing to restore and nothing was published.
    expect(treeDigest(join(root, 'fresh'))).toEqual({});
    publisher.abort();
    expect(stagingLeftovers('fresh', root)).toEqual([]);
  });

  it('refuses to publish twice', () => {
    const root = tempRoot();
    const publisher = new GatePublisher('tree', root);
    publisher.write('a.txt', 'one');
    publisher.publish();
    expect(() => publisher.publish()).toThrow(/already published/);
  });
});
