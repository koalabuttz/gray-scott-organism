/**
 * Failure-safe publication of gate artifacts.
 *
 * The gate's provenance assertions have to be able to fail *before* anything an operator might read
 * is published. With a straight `writeFileSync`/`screenshot` path they could not: a failed run left a
 * half-written `artifacts/phase1-gate/` — some captures from this revision, some from the previous
 * one, plus stale files the run never reached — with nothing in the tree itself recording which
 * provenance applied to which file.
 *
 * Every output is therefore written into a staging directory inside `artifacts/` and published, after
 * the last assertion has passed, with a **failure-safe two-rename swap**: the previous tree is renamed
 * aside to a backup, the staging tree is renamed into place, and the backup is deleted only once the
 * swap has succeeded. There is a brief window between the two renames in which the published path is
 * absent, but a reader never observes a **mixed** tree — it sees either the complete old tree or the
 * complete new one — and an aborted or failed run restores the previous tree exactly as it was.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ARTIFACTS_DIR } from './browser.ts';

/**
 * The `rename(2)` primitive used by `publish()`; injectable so a test can force the *second* rename
 * (staging -> final) to fail and observe the restore path.
 */
export type RenameFn = (from: string, to: string) => void;

/** File paths below `dir`, relative to it and sorted; empty when `dir` does not exist. */
export function treeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(resolve(current, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(dir, '');
  return files;
}

/** `{ relative path: sha256 }` for every file below `dir` — a content fingerprint of a whole tree. */
export function treeDigest(dir: string): Record<string, string> {
  const digest: Record<string, string> = {};
  for (const file of treeFiles(dir)) {
    const contents = readFileSync(resolve(dir, file));
    digest[file] = createHash('sha256').update(contents).digest('hex');
  }
  return digest;
}

/**
 * Staging and backup directories left behind for `name` (absolute paths, sorted). Used by the
 * negative publish test to prove the temporary tree is gone; an empty array is the expected result.
 */
export function stagingLeftovers(name: string, root: string = ARTIFACTS_DIR): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => entry.startsWith(`.${name}.staging-`) || entry.startsWith(`.${name}.replaced-`))
    .sort()
    .map((entry) => resolve(root, entry));
}

export class GatePublisher {
  readonly name: string;
  /** Where the tree ends up once published. */
  readonly finalDir: string;
  /** Where every output is written until `publish()` is called. */
  readonly stagingDir: string;
  private readonly rename: RenameFn;
  private published = false;

  constructor(name: string, root: string = ARTIFACTS_DIR, options: { rename?: RenameFn } = {}) {
    this.name = name;
    this.finalDir = resolve(root, name);
    this.stagingDir = resolve(root, `.${name}.staging-${process.pid}-${Date.now().toString(36)}`);
    this.rename = options.rename ?? renameSync;
    rmSync(this.stagingDir, { recursive: true, force: true });
    mkdirSync(this.stagingDir, { recursive: true });
  }

  /** Absolute staging path for one output file, with its parent directory created. */
  path(relative: string): string {
    const target = resolve(this.stagingDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    return target;
  }

  /** Write one text or binary output into staging. */
  write(relative: string, content: string | Buffer): string {
    const target = this.path(relative);
    writeFileSync(target, content);
    return target;
  }

  /** File paths staged so far, relative to the published tree (sorted). */
  stagedFiles(): string[] {
    return treeFiles(this.stagingDir);
  }

  /**
   * Publish the staged tree with a failure-safe two-rename swap: rename the previous tree aside, then
   * rename staging into place, deleting the backup only on success. This is the only step that touches
   * the published directory. There is a brief window between the two renames in which the published
   * path is absent, but a reader never sees a mixed tree, and if the second rename fails the previous
   * tree is renamed back.
   */
  publish(): void {
    if (this.published) throw new Error(`gate tree ${this.name} was already published`);
    if (!existsSync(this.stagingDir)) throw new Error(`gate staging directory ${this.stagingDir} is missing`);
    const backup = resolve(
      dirname(this.finalDir),
      `.${this.name}.replaced-${process.pid}-${Date.now().toString(36)}`,
    );
    const hadPrevious = existsSync(this.finalDir);
    if (hadPrevious) this.rename(this.finalDir, backup);
    try {
      this.rename(this.stagingDir, this.finalDir);
    } catch (error) {
      // Put the previous tree back rather than leaving the artifacts directory empty.
      if (hadPrevious) this.rename(backup, this.finalDir);
      throw error;
    }
    if (hadPrevious) rmSync(backup, { recursive: true, force: true });
    this.published = true;
  }

  /** Discard the staged tree. Idempotent, and a no-op once published. */
  abort(): void {
    if (this.published) return;
    rmSync(this.stagingDir, { recursive: true, force: true });
  }
}
