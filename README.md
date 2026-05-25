# QA Bot

Automated QA testing bot for Fexy-Zamo using Playwright. Runs acceptance criteria tests against a local or remote instance, captures screenshots, and generates self-contained HTML reports.

## Setup

```bash
# 1. Clone and install
git clone <repo-url> qa-bot
cd qa-bot
npm install
npx playwright install chromium

# 2. Configure
cp .env.example .env
# Edit .env with your credentials and paths

# 3. Jira integration (optional)
# Copy your Jira API token to ./token
# Generate at: https://id.atlassian.com/manage-profile/security/api-tokens
```

## Usage

```bash
# Run a ticket's test suite
node run.mjs TANGO-9

# With Jira posting
node run.mjs TANGO-44 --post-to-jira

# Keep seed data after run (for debugging)
node run.mjs TANGO-44 --no-cleanup

# Custom environment
QA_BASE_URL=https://qa.fexa.io node run.mjs TANGO-9
```

## Project Structure

```
qa-bot/
  run.mjs              # Entry point
  lib/
    config.mjs         # Centralized configuration (paths, env vars)
    auth.mjs           # Login/logout/persona switching
    browser.mjs        # Playwright browser lifecycle
    evidence.mjs       # DB verification → styled HTML table screenshots
    extjs.mjs          # ExtJS-specific helpers (ComponentQuery, wait)
    import.mjs         # Import wizard: template download/fill/upload
    jira.mjs           # Jira API: fetch tickets, post comments, attach files
    navigation.mjs     # Sidebar tree navigation
    report.mjs         # HTML report generator (dark theme)
    screenshots.mjs    # Screenshot capture + base64 encoding
    seeds.mjs          # Ruby seed script generation + rails runner execution
    step-formatter.mjs # Clean up verbose step text for reports
  tickets/
    TANGO-9.mjs        # V2 Pricing Import (12 ACs)
    TANGO-44.mjs       # Vendor NTE Mass Manage (14 ACs, 9 tests)
  tools/
    clean-report.mjs   # Post-process HTML reports (remove noise)
    clean-report-v2.mjs
    clean-tango9.mjs
  jira-skill/          # Claude Code Jira skill (shell scripts)
    SKILL.md
    details.sh
    list.sh
    fetch_attachments.sh
    download_attachment.sh
```

## Writing a New Test

Create `tickets/TICKET-KEY.mjs` exporting:

```js
export const metadata = {
  summary: 'Ticket title',
  tester: 'Name',
  branch: 'branch-name',
};

export const seed = {
  tag: 'ticket_key',
  // See seeds.mjs for seed definition structure
};

export const tests = [
  {
    ac: 1,
    name: 'Short description',
    criteria: 'Full AC text from Jira',
    run: async (page, step, screenshot) => {
      step('What you are doing');
      // ... Playwright automation ...
      await screenshot('evidence-label');
    },
  },
];
```

## Prerequisites

- Node.js 18+
- WSL with Ruby 2.7.8 + Rails (for seed scripts)
- Fexy-Zamo running on localhost:3000
- Playwright Chromium browser (`npx playwright install chromium`)
