import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlFromText, normalizeBody } from '../lib/mime.js';

// ---------- htmlFromText: matches Gmail web-compose structure ----------

test('single paragraph -> one div inside the ltr wrapper', () => {
  assert.equal(htmlFromText('Hello there'), '<div dir="ltr"><div>Hello there</div></div>');
});

test('two paragraphs separated by a blank-line div (Gmail structure)', () => {
  assert.equal(
    htmlFromText('Para one\n\nPara two'),
    '<div dir="ltr"><div>Para one</div><div><br></div><div>Para two</div></div>',
  );
});

test('apostrophe escaped as &#39; like Gmail', () => {
  assert.match(htmlFromText("it's here"), /it&#39;s here/);
});

test('html-significant characters are escaped', () => {
  assert.match(htmlFromText('a < b & c > d "q"'), /a &lt; b &amp; c &gt; d &quot;q&quot;/);
});

test('intra-paragraph newline -> <br>; blank line -> separator div', () => {
  assert.equal(
    htmlFromText('123 Main St.\nAnytown, CA\n\nSecond para'),
    '<div dir="ltr"><div>123 Main St.<br>Anytown, CA</div><div><br></div><div>Second para</div></div>',
  );
});

test('http(s) URL auto-linked, trailing sentence punctuation excluded', () => {
  assert.match(
    htmlFromText('See https://example.com/x.'),
    /<a href="https:\/\/example\.com\/x">https:\/\/example\.com\/x<\/a>\./,
  );
});

test('URL with query string links correctly (& already escaped)', () => {
  assert.match(
    htmlFromText('go https://x.io/a?b=1&c=2 now'),
    /<a href="https:\/\/x\.io\/a\?b=1&amp;c=2">https:\/\/x\.io\/a\?b=1&amp;c=2<\/a> now/,
  );
});

test('empty / nullish input is safe', () => {
  assert.equal(htmlFromText(''), '<div dir="ltr"></div>');
  assert.equal(htmlFromText(null), '<div dir="ltr"></div>');
  assert.equal(htmlFromText(undefined), '<div dir="ltr"></div>');
});

// ---------- normalizeBody: heal machine hard-wraps, preserve intent ----------

test('soft-authored paragraphs pass through unchanged', () => {
  const soft = 'One clean line that is a whole paragraph by itself.\n\nAnother whole paragraph here.';
  assert.equal(normalizeBody(soft), soft);
});

test('machine hard-wrapped prose is healed', () => {
  const wrapped = [
    'I am writing to follow up on the conversation we had about the new',
    'reporting workflow. There are a few moving parts, but the one that',
    'stood out to me was the idea of a shared dashboard for the whole',
    'team to use day to day.',
  ].join('\n');
  const healed = normalizeBody(wrapped);
  assert.ok(healed.split('\n').length < 4, 'continuation lines collapsed');
  assert.match(healed, /about the new reporting workflow/, '"new\\nreporting" wrap healed');
  assert.match(healed, /the one that stood out/, '"that\\nstood" wrap healed');
});

test('intentional short lines preserved: address block', () => {
  const addr = '123 Main St., Apt. 4\nAnytown, CA 90210';
  assert.equal(normalizeBody(addr), addr);
});

test('intentional short lines preserved: numbered list', () => {
  const list = 'Two short reads:\n1) The first article\n2) The second article';
  assert.equal(normalizeBody(list), list);
});

test('sentence-ending punctuation is a legitimate break (not joined)', () => {
  const t = 'This is a complete sentence that is plenty long enough to pass.\nnext line starts lowercase but must not join.';
  assert.equal(normalizeBody(t), t);
});

test('htmlFromText o normalizeBody on hard-wrapped input reflows (no narrow column)', () => {
  const wrapped = [
    'I am writing to follow up on the conversation we had about the new',
    'reporting workflow that the team has been building over the past',
    'couple of weeks.',
  ].join('\n');
  const html = htmlFromText(normalizeBody(wrapped));
  // The first two source lines must not be separated by a <br> anymore.
  assert.doesNotMatch(html, /the new<br>reporting/);
  assert.match(html, /about the new reporting workflow/);
});
