import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unionRect } from '../src/desktop/rect.ts';

test('expandir para todas as telas: união das áreas úteis dos monitores', () => {
  // Dois monitores lado a lado, o da direita mais alto e deslocado para cima.
  const left = { x: 0, y: 0, width: 1920, height: 1040 };
  const right = { x: 1920, y: -200, width: 1440, height: 2520 };
  assert.deepEqual(unionRect([left, right]), { x: 0, y: -200, width: 3360, height: 2520 });
  // Monitor à esquerda do principal (coordenadas negativas).
  assert.deepEqual(unionRect([left, { x: -1280, y: 0, width: 1280, height: 984 }]), { x: -1280, y: 0, width: 3200, height: 1040 });
  assert.deepEqual(unionRect([left]), left);
  assert.throws(() => unionRect([]), /nenhuma tela/);
});
