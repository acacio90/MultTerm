import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, releaseNotesText } from '../src/desktop/release-notes.ts';

// Trecho no formato em que o GitHub entrega as notas da release.
const HTML = `<h2>Novidades</h2>
<ul>
<li><strong>Importação</strong> (<a class="issue-link js-issue-link" data-id="1" href="https://github.com/o/r/issues/4">#4</a>): reconhece <code>host</code> &amp; faixas.</li>
<li><strong>Ícone próprio</strong> na janela.</li>
</ul>
<h2>Instalar</h2>
<p>Baixe o instalador &mdash; <em>Mais informações &rarr; Executar</em> &#8212; ok&#x21;</p>`;

test('converte as notas em HTML para texto legível', () => {
  assert.equal(htmlToText(HTML), [
    'Novidades',
    '• Importação (#4): reconhece host & faixas.',
    '• Ícone próprio na janela.',
    'Instalar',
    'Baixe o instalador — Mais informações → Executar — ok!',
  ].join('\n'));
});

test('releaseNotesText aceita texto, lista de notas e vazio', () => {
  assert.equal(releaseNotesText('<p>a</p>'), 'a');
  assert.equal(releaseNotesText([{ note: '<p>a</p>' }, { note: 'b' }]), 'a\nb');
  assert.equal(releaseNotesText(undefined), undefined);
  assert.equal(releaseNotesText('<p> </p>'), undefined);
});
