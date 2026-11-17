/**
 * Shared helpers for the test-reality records.
 *
 * A record is one JSON file per area under docs/test-reality/. Citations
 * keep an anchor (trimmed source lines) instead of a line number. slugify names
 * the file. findAnchor locates that anchor again after the source moves.
 * canonical is the only byte layout the checker accepts. statusKind reads the
 * leading word of a Status cell.
 */

const fs = require('fs');
const path = require('path');

const STATUS_KINDS = ['real', 'fake', 'switched-off', 'mixed'];

// Lowercase ASCII. Every run of characters outside [a-z0-9] becomes one '-'.
// Dashes at either end are removed. The result is at most 80 characters, and a
// cut that lands on a dash does not leave a trailing dash.
function slugify(title) {
  let slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 80) {
    // Cut at the last word boundary within 80 characters; one word longer than that is cut as is.
    const cut = slug[80] === '-' ? 80 : slug.lastIndexOf('-', 80);
    slug = slug.slice(0, cut > 0 ? cut : 80).replace(/-+$/g, '');
  }
  return slug;
}

// 1-based start lines where `anchorLines` occur consecutively. Each line is
// compared after trimming, so indentation in the file does not matter.
function findAnchor(fileLines, anchorLines) {
  if (!Array.isArray(fileLines) || !Array.isArray(anchorLines) || anchorLines.length === 0) return [];
  const needle = anchorLines.map((line) => String(line).trim());
  const hits = [];
  const last = fileLines.length - needle.length;
  for (let start = 0; start <= last; start++) {
    let found = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (String(fileLines[start + offset]).trim() !== needle[offset]) {
        found = false;
        break;
      }
    }
    if (found) hits.push(start + 1);
  }
  return hits;
}

function canonical(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

// Leading word, or the leading pair "switched off" (a hyphen is accepted).
// "fake" / "bent" / "reality-bent" / "bypassed" are fake. "skipped" / "disabled" are switched off.
// A leading "real" is real. Anything else, including a longer word such as "reality", is mixed.
function statusKind(statusText) {
  const text = String(statusText ?? '')
    .trim()
    .toLowerCase();
  if (/^switched[\s-]+off\b/.test(text)) return 'switched-off';
  if (/^(skipped|disabled)\b/.test(text)) return 'switched-off';
  if (/^(fake|bent|reality-bent|bypassed)\b/.test(text)) return 'fake';
  if (/^real\b/.test(text)) return 'real';
  return 'mixed';
}

// Empty, shorter than 8 characters, or only brackets and punctuation.
function isWeakLine(line) {
  const text = String(line ?? '').trim();
  if (text.length < 8) return true;
  return /^[^A-Za-z0-9]+$/.test(text);
}

// Cells of a markdown table row. `\|` stays inside a cell.
function tableCells(line) {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const inner = trimmed.slice(1, -1);
  const cells = [];
  let current = '';
  for (let index = 0; index < inner.length; index++) {
    if (inner[index] === '\\' && inner[index + 1] === '|') {
      current += '\\|';
      index += 1;
      continue;
    }
    if (inner[index] === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += inner[index];
  }
  cells.push(current);
  return cells;
}

// Table padding only. Cells are trimmed, space runs collapse, and a separator
// cell (dashes, optional colons) becomes `---`. Prose is unchanged.
function normalizeMarkdown(markdown) {
  return String(markdown)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (!/^\s*\|.*\|\s*$/.test(line)) return line;
      const cells = tableCells(line);
      if (!cells) return line;
      const body = cells.map((cell) => {
        const collapsed = cell.trim().replace(/ {2,}/g, ' ');
        return /^:?-+:?$/.test(collapsed) ? '---' : collapsed;
      });
      return `| ${body.join(' | ')} |`;
    })
    .join('\n');
}

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

// `rel` is a repo-relative path. Missing files and paths that leave `root` are null.
function readRepoLines(root, rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel)) return null;
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  let text = fs.readFileSync(abs, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

module.exports = {
  STATUS_KINDS,
  slugify,
  findAnchor,
  canonical,
  statusKind,
  isWeakLine,
  normalizeMarkdown,
  repoRoot,
  readRepoLines,
  tableCells,
};
