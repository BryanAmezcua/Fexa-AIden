/**
 * jira.mjs -- Fetch Jira ticket details, extract Acceptance Criteria,
 *             and post QA results back to Jira.
 *
 * Auth approach mirrors details.sh: HTTP Basic Auth with email + API token.
 * Token is read from a file (same file the Jira-Skill scripts use).
 *
 * Usage:
 *   import { fetchTicketAC, postQAComment, formatCommentADF } from './lib/jira.mjs';
 *
 *   // Fetch AC from a ticket:
 *   const acs = await fetchTicketAC('TANGO-44');
 *
 *   // Post QA results + attach the HTML report:
 *   await postQAComment('TANGO-9', testResults, reportPath);
 */

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN_PATH } from './config.mjs';

// ---------------------------------------------------------------------------
// Token loading
// ---------------------------------------------------------------------------

let _cachedToken = null;

async function loadToken() {
  if (_cachedToken) return _cachedToken;
  try {
    const raw = await readFile(JIRA_TOKEN_PATH, 'utf-8');
    const token = raw.replace(/[\r\n]+$/, '').trim();
    if (!token) throw new Error(`Token file is empty: ${JIRA_TOKEN_PATH}`);
    _cachedToken = token;
    return token;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Jira token file not found at ${JIRA_TOKEN_PATH}. ` +
        'Set JIRA_TOKEN_PATH env var or copy the token file to ./token. ' +
        'Generate a token at https://id.atlassian.com/manage-profile/security/api-tokens'
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Jira API call
// ---------------------------------------------------------------------------

/**
 * Fetch a single Jira issue by key (e.g. "TANGO-44").
 * Returns the raw JSON response from /rest/api/3/issue/{key}.
 */
export async function fetchTicketDetails(ticketKey) {
  const token = await loadToken();
  const fields = [
    'summary', 'status', 'issuetype', 'priority',
    'labels', 'description', 'parent', 'subtasks',
    'comment', 'assignee', 'reporter', 'created', 'updated',
  ].join(',');

  const url = `${JIRA_HOST}/rest/api/3/issue/${encodeURIComponent(ticketKey)}?fields=${fields}`;
  const auth = Buffer.from(`${JIRA_EMAIL}:${token}`).toString('base64');

  const res = await fetch(url, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API ${res.status}: ${body}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// ADF (Atlassian Document Format) text extraction
// ---------------------------------------------------------------------------

function adfToText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'mention') return node.attrs?.text || node.attrs?.displayName || '';
  if (node.type === 'inlineCard' || node.type === 'blockCard') return node.attrs?.url || '';
  if (node.type === 'hardBreak') return '\n';
  if (!node.content || !Array.isArray(node.content)) return '';
  return node.content.map(adfToText).join('');
}

function listItemToText(listItem) {
  if (!listItem?.content) return '';
  return listItem.content.map(child => adfToText(child)).join('\n').trim();
}

// ---------------------------------------------------------------------------
// Acceptance Criteria extraction
// ---------------------------------------------------------------------------

export function extractAcceptanceCriteria(description) {
  if (!description || !description.content) return [];

  const topLevel = description.content;
  let acSectionIndex = -1;

  for (let i = 0; i < topLevel.length; i++) {
    const node = topLevel[i];
    if (node.type === 'heading') {
      const headingText = adfToText(node).trim().toLowerCase();
      if (headingText.includes('acceptance criteria') || headingText.includes('acceptance criterion')) {
        acSectionIndex = i;
        break;
      }
    }
  }

  if (acSectionIndex === -1) return [];

  const criteria = [];
  for (let i = acSectionIndex + 1; i < topLevel.length; i++) {
    const node = topLevel[i];
    if (node.type === 'heading') break;

    if (node.type === 'orderedList' || node.type === 'bulletList') {
      if (!node.content) continue;
      for (const item of node.content) {
        const text = listItemToText(item);
        if (text) criteria.push(text);
      }
    }

    if (node.type === 'paragraph') {
      const text = adfToText(node).trim();
      if (text) criteria.push(text);
    }
  }

  return criteria.map((text, idx) => ({
    ac: idx + 1,
    name: deriveName(text),
    criteria: text,
  }));
}

function deriveName(text) {
  const sentenceMatch = text.match(/^(.+?\.)\s/);
  const firstSentence = sentenceMatch ? sentenceMatch[1] : text;
  const MAX_LEN = 60;
  if (firstSentence.length <= MAX_LEN) return firstSentence;
  return firstSentence.slice(0, MAX_LEN - 3).trimEnd() + '...';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchTicketAC(ticketKey) {
  const issue = await fetchTicketDetails(ticketKey);
  const description = issue.fields?.description;
  return extractAcceptanceCriteria(description);
}

export async function fetchTicketWithAC(ticketKey) {
  const issue = await fetchTicketDetails(ticketKey);
  const f = issue.fields || {};
  return {
    key: issue.key,
    summary: f.summary,
    status: f.status?.name,
    type: f.issuetype?.name,
    priority: f.priority?.name || null,
    assignee: f.assignee?.displayName || null,
    ac: extractAcceptanceCriteria(f.description),
  };
}

// ---------------------------------------------------------------------------
// ADF comment builder helpers
// ---------------------------------------------------------------------------

function adfTextNode(text, strong = false) {
  const node = { type: 'text', text };
  if (strong) node.marks = [{ type: 'strong' }];
  return node;
}

function adfParagraph(inlineNodes) {
  return {
    type: 'paragraph',
    content: Array.isArray(inlineNodes) ? inlineNodes : [inlineNodes],
  };
}

function adfHeadingNode(level, text) {
  return {
    type: 'heading',
    attrs: { level },
    content: [adfTextNode(text, true)],
  };
}

// ---------------------------------------------------------------------------
// formatCommentADF
// ---------------------------------------------------------------------------

export function formatCommentADF({ ticketKey, testResults, tester, environment, reportFilename, reportUrl }) {
  const date = new Date().toISOString().split('T')[0];
  const passed  = testResults.filter(t => t.status === 'pass').length;
  const failed  = testResults.filter(t => t.status === 'fail').length;
  const skipped = testResults.filter(t => t.status === 'skip').length;

  function statusTag(status) {
    if (status === 'pass') return '[PASS]';
    if (status === 'fail') return '[FAIL]';
    return '[SKIP]';
  }

  const testLines = testResults.map(
    t => `  ${statusTag(t.status)} AC #${t.ac} \u2014 ${t.name}`,
  );

  const overallStatus = failed > 0 ? 'fail' : (skipped > 0 && passed === 0) ? 'skip' : 'pass';
  const panelType = overallStatus === 'pass' ? 'success'
    : overallStatus === 'fail' ? 'error'
    : 'warning';

  return {
    version: 1,
    type: 'doc',
    content: [
      {
        type: 'panel',
        attrs: { panelType },
        content: [
          adfHeadingNode(3, `QA Report: ${ticketKey}`),
          adfParagraph([adfTextNode('Result: ', true), adfTextNode(`${passed} passed | ${failed} failed | ${skipped} skipped`)]),
          adfParagraph([adfTextNode('Tester: ', true), adfTextNode(tester)]),
          adfParagraph([adfTextNode('Date: ', true), adfTextNode(date)]),
          adfParagraph([adfTextNode('Environment: ', true), adfTextNode(environment)]),
        ],
      },
      adfHeadingNode(4, 'Test Cases'),
      {
        type: 'codeBlock',
        attrs: {},
        content: [adfTextNode(testLines.join('\n'))],
      },
      adfParagraph([
        adfTextNode('Full report attached: ', true),
        reportUrl
          ? { type: 'text', text: reportFilename, marks: [{ type: 'link', attrs: { href: reportUrl } }] }
          : adfTextNode(reportFilename),
      ]),
    ],
  };
}

// ---------------------------------------------------------------------------
// Jira POST helper
// ---------------------------------------------------------------------------

async function jiraPost(path, body) {
  const token = await loadToken();
  const auth = Buffer.from(`${JIRA_EMAIL}:${token}`).toString('base64');
  const url = `${JIRA_HOST}${path}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jira POST ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// attachFile
// ---------------------------------------------------------------------------

async function attachFile(ticketKey, filePath) {
  const token = await loadToken();
  const auth = Buffer.from(`${JIRA_EMAIL}:${token}`).toString('base64');
  const url = `${JIRA_HOST}/rest/api/3/issue/${encodeURIComponent(ticketKey)}/attachments`;
  const filename = basename(filePath);
  const fileBuffer = readFileSync(filePath);

  const boundary = `----QABotBoundary${Date.now()}`;
  const CRLF = '\r\n';

  const preamble = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: text/html',
    '',
    '',
  ].join(CRLF);

  const epilogue = `${CRLF}--${boundary}--${CRLF}`;

  const body = Buffer.concat([
    Buffer.from(preamble, 'utf8'),
    fileBuffer,
    Buffer.from(epilogue, 'utf8'),
  ]);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'X-Atlassian-Token': 'no-check',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jira attachment upload failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// postQAComment
// ---------------------------------------------------------------------------

export async function postQAComment(ticketKey, testResults, reportPath, opts = {}) {
  const tester = opts.tester || 'Bryan';
  const environment = opts.environment || 'Local Dev (WSL)';
  const reportFilename = basename(reportPath);

  // Attach the report FIRST so the comment can hyperlink the filename to it.
  console.log(`[jira] Attaching ${reportFilename} to ${ticketKey}...`);
  const attachResult = await attachFile(ticketKey, reportPath);
  const reportUrl = Array.isArray(attachResult) ? attachResult[0]?.content : undefined;
  console.log(`[jira] Attachment uploaded.`);

  const adfBody = formatCommentADF({ ticketKey, testResults, tester, environment, reportFilename, reportUrl });

  console.log(`[jira] Posting QA comment to ${ticketKey}...`);
  const commentResult = await jiraPost(
    `/rest/api/3/issue/${encodeURIComponent(ticketKey)}/comment`,
    { body: adfBody },
  );
  console.log(`[jira] Comment posted (id: ${commentResult.id})`);

  return { commentId: commentResult.id, reportFilename, reportUrl };
}
