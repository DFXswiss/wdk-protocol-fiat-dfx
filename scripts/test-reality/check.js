/**
 * Check test-reality JSON records.
 *
 *   node scripts/test-reality/check.js [dir]
 *
 * `dir` defaults to docs/test-reality, relative to the process working directory.
 * Cited files are read from the repository that contains this script.
 *
 * Every `*.json` must parse, equal canonical(), and be named slugify(title).json.
 * The title is non-empty and entries is non-empty. A five-field entry (table or
 * `layout: "bullets"`) has the fields as non-empty strings and a statusKind that
 * statusKind() would produce, and a table entry's optional `contentHeader` is a
 * non-empty string without `[ref N]`. Every `[ref N]` in an entry's text has refs[N] of
 * that entry, every `[ref N]` in the scope has the record's refs[N], and every
 * ref is used at least once. The title and the record's optional notes carry no
 * `[ref N]`, since no refs belong to them. ref.file exists, findAnchor locates its anchor, the
 * ref's occurrence exists, the cited range lies inside the file, and a range
 * longer than its anchor has an endAnchor that is its last line(s). An anchor
 * must occur as often as its `matches` says (once when absent); one that occurs
 * more than once as recorded is reported and does not fail.
 *
 * Failures are printed to stderr as `<file>: <problem>`, followed by their count, and exit
 * non-zero. An ambiguous anchor is printed to stdout and does not fail.
 */

const fs = require('fs');
const path = require('path');
const { STATUS_KINDS, slugify, findAnchor, canonical, statusKind, repoRoot, readRepoLines } = require('./lib');

const TEXT_FIELDS = ['heading', 'component', 'status', 'mechanism', 'insteadOf', 'doesNotProve', 'notes', 'body'];
const REQUIRED_FIELDS = ['component', 'status', 'mechanism', 'insteadOf', 'doesNotProve'];
const STYLE_KINDS = ['abs', 'base', 'rel', 'cont'];

function usage() {
  return 'usage: node scripts/test-reality/check.js [dir]';
}

function entryTexts(entry) {
  const texts = [];
  for (const field of TEXT_FIELDS) {
    if (typeof entry[field] === 'string') texts.push(entry[field]);
  }
  return texts;
}

function checkEntry(label, entry, index, readFile) {
  const failures = [];
  const where = `${label}: entries[${index}]`;
  const freeform = typeof entry.body === 'string';
  const headed = typeof entry.heading === 'string' && [3, 4].includes(entry.headingLevel);
  if (!headed && !(entry.heading === null && entry.headingLevel === null)) {
    failures.push(`${where}: heading and headingLevel are invalid`);
  }
  if (freeform) {
    // A body entry is prose only; five-field keys next to it would never be checked.
    const mixed = [...REQUIRED_FIELDS, 'statusKind', 'layout', 'contentHeader'].filter(
      (key) => entry[key] !== undefined,
    );
    if (mixed.length) failures.push(`${where}: body entry also has ${mixed.join(', ')}`);
  } else {
    for (const field of REQUIRED_FIELDS) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') failures.push(`${where}: ${field} is empty`);
    }
    if (!STATUS_KINDS.includes(entry.statusKind)) failures.push(`${where}: statusKind is invalid`);
    else if (typeof entry.status === 'string' && entry.statusKind !== statusKind(entry.status)) {
      failures.push(`${where}: statusKind does not match status`);
    }
    if (entry.layout !== undefined && entry.layout !== 'bullets') failures.push(`${where}: layout is invalid`);
    // The header label renders as a table heading; a bullet list has none, and a heading cannot carry a ref.
    if (entry.contentHeader !== undefined) {
      const label = entry.contentHeader;
      if (typeof label !== 'string' || label.trim() === '' || entry.layout !== undefined || /\[ref \d+\]/.test(label)) {
        failures.push(`${where}: contentHeader is invalid`);
      }
    }
  }
  const result = checkRefs(where, entryTexts(entry), entry.refs, readFile);
  return { failures: [...failures, ...result.failures], ambiguous: result.ambiguous };
}

// Every `[ref N]` in the texts has refs[N], every ref is used, and every ref resolves: the anchor
// occurs in its file, the chosen occurrence exists, the cited range lies inside the file, and a range
// longer than its anchor ends on its endAnchor.
function checkRefs(where, texts, refsValue, readFile) {
  const failures = [];
  const ambiguous = [];
  const refs = Array.isArray(refsValue) ? refsValue : [];
  if (refsValue !== undefined && !Array.isArray(refsValue)) failures.push(`${where}: refs is not an array`);
  const used = new Set();
  const refRe = /\[ref (\d+)\]/g;
  for (const text of texts) {
    let match;
    while ((match = refRe.exec(text))) {
      const refIndex = Number(match[1]);
      if (!Object.prototype.hasOwnProperty.call(refs, refIndex)) {
        failures.push(`${where}: [ref ${refIndex}] has no refs[${refIndex}]`);
      } else used.add(refIndex);
    }
  }
  refs.forEach((ref, refIndex) => {
    if (!used.has(refIndex)) failures.push(`${where}: refs[${refIndex}] is unused`);
    if (!ref || typeof ref.file !== 'string' || ref.file === '') {
      failures.push(`${where}: refs[${refIndex}] file is missing`);
      return;
    }
    if (!Array.isArray(ref.anchor) || ref.anchor.length === 0) {
      failures.push(`${where}: refs[${refIndex}] anchor is empty`);
      return;
    }
    if (!ref.anchor.every((line) => typeof line === 'string')) {
      failures.push(`${where}: refs[${refIndex}] anchor is not a list of lines`);
      return;
    }
    if (!ref.style || !STYLE_KINDS.includes(ref.style.kind) || typeof ref.style.backtick !== 'boolean') {
      failures.push(`${where}: refs[${refIndex}] style is invalid`);
    }
    if (ref.occurrence !== undefined && (!Number.isInteger(ref.occurrence) || ref.occurrence < 0)) {
      failures.push(`${where}: refs[${refIndex}] occurrence is invalid`);
      return;
    }
    const lines = readFile(ref.file);
    if (!lines) {
      failures.push(`${where}: refs[${refIndex}] file does not exist (${ref.file})`);
      return;
    }
    const hits = findAnchor(lines, ref.anchor);
    if (hits.length === 0) {
      failures.push(`${where}: refs[${refIndex}] anchor not found in ${ref.file}`);
      return;
    }
    const matches = ref.matches === undefined ? 1 : ref.matches;
    if (ref.matches !== undefined && (!Number.isInteger(ref.matches) || ref.matches < 2)) {
      failures.push(`${where}: refs[${refIndex}] matches is invalid`);
      return;
    }
    // A changed number of copies would let `occurrence` point at another copy, so it fails.
    if (hits.length !== matches) {
      failures.push(
        `${where}: refs[${refIndex}] anchor occurs ${hits.length} times in ${ref.file}, expected ${matches}`,
      );
      return;
    }
    if (hits.length > 1) ambiguous.push(`${where}: refs[${refIndex}] ambiguous anchor in ${ref.file}`);
    const offset = ref.offset === undefined ? 0 : ref.offset;
    if (!Number.isInteger(offset) || offset < 0 || offset >= ref.anchor.length) {
      failures.push(`${where}: refs[${refIndex}] offset is outside its anchor`);
      return;
    }
    const hit = hits[ref.occurrence ?? 0];
    const start = hit === undefined ? undefined : hit + offset;
    if (
      !Number.isInteger(start) ||
      start < 1 ||
      !Number.isInteger(ref.span) ||
      ref.span < 1 ||
      start + ref.span - 1 > lines.length
    ) {
      failures.push(`${where}: refs[${refIndex}] cited range is outside ${ref.file}`);
      return;
    }
    const reachesEnd = offset + ref.span <= ref.anchor.length;
    if (!reachesEnd && ref.endAnchor === undefined) {
      failures.push(`${where}: refs[${refIndex}] range is longer than its anchor and has no endAnchor`);
    } else if (ref.endAnchor !== undefined) {
      const tail =
        Array.isArray(ref.endAnchor) && ref.endAnchor.every((line) => typeof line === 'string') ? ref.endAnchor : [];
      const end = start + ref.span - 1;
      const actual = lines.slice(end - tail.length, end).map((line) => String(line).trim());
      if (tail.length === 0 || actual.join('\n') !== tail.join('\n')) {
        failures.push(`${where}: refs[${refIndex}] range no longer ends at its end anchor in ${ref.file}`);
      }
    }
  });
  return { failures, ambiguous };
}

function checkText(label, text, readFile) {
  const failures = [];
  const ambiguous = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { failures: [`${label}: invalid JSON`], ambiguous };
  }
  if (text !== canonical(data)) failures.push(`${label}: not canonical JSON`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    failures.push(`${label}: record is not an object`);
    return { failures, ambiguous };
  }
  if (typeof data.title !== 'string' || data.title.trim() === '') failures.push(`${label}: title is empty`);
  else if (slugify(data.title) === '') failures.push(`${label}: title has an empty slug`);
  else if (path.basename(label) !== `${slugify(data.title)}.json`) {
    failures.push(`${label}: file name is not slugify(title) + '.json'`);
  }
  if (data.notes !== undefined && typeof data.notes !== 'string') failures.push(`${label}: notes is not a string`);
  // The title and the record's notes have no refs, so a `[ref N]` there could never be checked.
  for (const field of ['title', 'notes']) {
    if (typeof data[field] === 'string' && /\[ref \d+\]/.test(data[field])) {
      failures.push(`${label}: ${field} has a [ref N] it cannot resolve`);
    }
  }
  if (typeof data.scope !== 'string') failures.push(`${label}: scope is not a string`);
  const scope = checkRefs(`${label}: scope`, [typeof data.scope === 'string' ? data.scope : ''], data.refs, readFile);
  failures.push(...scope.failures);
  ambiguous.push(...scope.ambiguous);
  if (!Array.isArray(data.entries) || data.entries.length === 0) failures.push(`${label}: entries is empty`);
  else {
    data.entries.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        failures.push(`${label}: entries[${index}] is not an object`);
        return;
      }
      const result = checkEntry(label, entry, index, readFile);
      failures.push(...result.failures);
      ambiguous.push(...result.ambiguous);
    });
  }
  return { failures, ambiguous };
}

function checkDirectory(dir, options = {}) {
  const root = options.root || repoRoot();
  const cache = new Map();
  const readFile = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const lines = readRepoLines(root, rel);
    cache.set(rel, lines);
    return lines;
  };
  const failures = [];
  const ambiguous = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { failures: [`${dir}: directory not found`], ambiguous };
  }
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  for (const name of names) {
    const abs = path.join(dir, name);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (error) {
      failures.push(`${name}: cannot read`);
      continue;
    }
    const result = checkText(name, text, readFile);
    failures.push(...result.failures);
    ambiguous.push(...result.ambiguous);
  }
  return { failures, ambiguous };
}

function run(argv, options = {}) {
  const log = options.stdout || ((line) => console.log(line));
  const err = options.stderr || ((line) => console.error(line));
  const args = argv.slice(2);
  if (args.length > 1) {
    err(usage());
    return 1;
  }
  const dir = path.resolve(options.cwd || process.cwd(), args[0] || 'docs/test-reality');
  const result = checkDirectory(dir, { root: options.root || repoRoot() });
  for (const line of result.ambiguous) log(line);
  for (const line of result.failures) err(line);
  if (result.failures.length) {
    err(`${result.failures.length} failure${result.failures.length === 1 ? '' : 's'}`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exit(run(process.argv));
}

module.exports = {
  checkDirectory,
  checkText,
  run,
};
