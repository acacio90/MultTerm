import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { which } from '../src/which.ts';

test('which: primeiro executável do PATH; ignora pastas e arquivos sem permissão', { skip: process.platform === 'win32' && 'permissão de execução é do Unix' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multterm-which-'));
  try {
    const [a, b] = [join(dir, 'a'), join(dir, 'b')];
    await mkdir(a);
    await mkdir(b);
    await writeFile(join(a, 'prog'), '#!/bin/sh\n');
    await writeFile(join(b, 'prog'), '#!/bin/sh\n');
    await chmod(join(b, 'prog'), 0o755);
    await mkdir(join(a, 'pasta'));
    const path = ['', a, b].join(delimiter);
    assert.equal(which('prog', path), join(b, 'prog'));
    assert.equal(which('pasta', path), undefined);
    assert.equal(which('nada', path), undefined);
    assert.equal(which('../b/prog', path), undefined);
    assert.equal(which(join(b, 'prog'), ''), join(b, 'prog'));
    assert.equal(which(join(a, 'prog'), ''), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
