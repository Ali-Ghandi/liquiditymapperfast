import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The Pages workflow reads each data file's published copy back (--previous). On a project site (owner.github.io/<repository>/) the copy
// is under the repository's path; on a user site (a repository named owner.github.io) it is at the root. Every step builds the address
// from SITE, which picks between the two, so none of them can point at the wrong place.
const workflow = fs.readFileSync('.github/workflows/pages.yml', 'utf8');

test('the Pages workflow defines SITE for both a project site and a user site', () => {
  const line = workflow.split('\n').find(l => /^\s+SITE:/.test(l));
  assert.ok(line, 'SITE is set');
  assert.match(line, /https:\/\/\$\{\{ github\.repository_owner \}\}\.github\.io\//);
  assert.match(line, /github\.event\.repository\.name != format\('\{0\}\.github\.io', github\.repository_owner\) && format\('\{0\}\/', github\.event\.repository\.name\) \|\| ''/);
});

test('every published copy the workflow reads back is addressed from SITE', () => {
  const previous = [...workflow.matchAll(/--previous (\S+)/g)].map(m => m[1]!);
  assert.deepEqual(previous.map(p => p.replace(/[a-z-]+\.json$/, '')), ['${SITE}', '${SITE}', '${SITE}']);
  assert.deepEqual(previous.map(p => p.slice('${SITE}'.length)), ['coins.json', 'put-flow.json', 'positioning.json']);
});

test('the Pages workflow says the positioning archive is read from data.binance.vision', () => {
  const start = workflow.indexOf('positioning.json');
  const end = workflow.indexOf('positioning.mjs', start);
  assert.ok(start >= 0 && end > start, 'the positioning step and its comment are present');
  assert.match(workflow.slice(start, end), /data\.binance\.vision/);
});

