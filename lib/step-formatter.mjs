// qa-bot/lib/step-formatter.mjs — Clean up noisy step text for human-readable reports

export function formatStep(raw) {
  if (!raw || raw.trim() === '') return null;

  // Suppress infrastructure noise
  if (shouldSuppress(raw)) return null;

  // Before/After NTE JSON arrays → summary
  const nteMatch = raw.match(/^(Before|After) NTE(?: values)?:\s*(\[.+\])/);
  if (nteMatch) {
    try {
      const label = nteMatch[1];
      const data = JSON.parse(nteMatch[2]);
      const count = data.length;
      const nteValues = [...new Set(data.map(a => a.nte).filter(v => v != null))];
      if (nteValues.length === 1) return `${label}: ${count} assignments at $${nteValues[0].toFixed(2)}`;
      return `${label}: ${count} assignments ($${Math.min(...nteValues).toFixed(2)}–$${Math.max(...nteValues).toFixed(2)})`;
    } catch (_) {}
  }

  // Vendor NTE column JSON → brief
  const colMatch = raw.match(/^Vendor NTE column:\s*(\{.+\})/);
  if (colMatch) {
    try {
      const data = JSON.parse(colMatch[1]);
      return `Vendor NTE column: "${data.text}" (updaterField: ${data.hasUpdaterField ? data.updaterFieldName : 'none'})`;
    } catch (_) {}
  }

  // Auto-create candidates JSON → brief
  if (raw.startsWith('Auto-create candidates:')) {
    try {
      const jsonStr = raw.replace('Auto-create candidates: ', '');
      const data = JSON.parse(jsonStr);
      return `Auto-create candidates: ${data.length} assignments checked`;
    } catch (_) {}
  }

  // AC#11 failure_errors JSON → brief
  if (raw.startsWith('AC#11 failure_errors:')) return 'Failure errors present in MassUpdate record';

  // Truncate long text
  if (raw.length > 200) return raw.substring(0, 180) + '...';

  return raw;
}

function shouldSuppress(text) {
  const t = text.trim();

  // Rails/Spring noise
  if (t.includes('Spring preloader')) return true;
  if (t.includes('DEPRECATED')) return true;
  if (t.includes('directory is already being watched')) return true;
  if (t.includes('spawnSync')) return true;

  // Navigation boilerplate
  if (t === 'Navigate to Work Orders > Assignments via sidebar') return true;
  if (t.startsWith('Navigating to:')) return true;
  if (t.startsWith('Arrived at:')) return true;
  if (t === 'Check if a saved list is loaded (required for mass manage)') return true;
  if (t.startsWith('Force-calling loadLists()')) return true;
  if (t.startsWith('Clicking saved list:')) return true;
  if (t.startsWith('After clicking saved list:')) return true;
  if (t === 'No saved list loaded — attempting to load or create one') return true;
  if (t.startsWith('Loaded saved list: qa_bot')) return true;
  if (t.startsWith('Loaded saved list: {')) return true;
  if (t.startsWith('loadLists result:')) return true;
  if (t.match(/^Assignments view:/)) return true;

  // Mass manage activation boilerplate
  if (t === 'Resetting Updater plugin state and activating mass manage') return true;
  if (t.startsWith('Mass manage toggle:')) return true;
  if (t === 'Select all assignment rows via select-all checkbox') return true;
  if (t.startsWith('Click mass edit button')) return true;
  if (t.startsWith('Mass edit button:')) return true;
  if (t === 'Resetting grid state for fresh mass manage') return true;

  // Mass update submission boilerplate
  if (t.startsWith('Enter Vendor NTE value:')) return true;
  if (t === 'Click Next to go to finalize') return true;
  if (t === 'Click Update button') return true;
  if (t === 'Click Proceed in email confirmation') return true;
  if (t.startsWith('Capturing MassUpdate ID')) return true;
  if (t.startsWith('Attempting to force-process')) return true;
  if (t.startsWith('Force-process attempt:')) return true;

  // Login/logout boilerplate
  if (t === 'Logging out current user') return true;
  if (t.startsWith('ExtJS logout did not work')) return true;
  if (t === 'Logging back in as admin') return true;
  if (t.startsWith('Cleared cookies')) return true;

  // Poll attempts — suppress individual lines
  if (t.match(/Poll attempt \d+/)) return true;
  if (t.match(/Polling MassUpdate/)) return true;

  // Redundant field checks
  if (t.startsWith('NTE field name:')) return true;
  if (t.startsWith('NTE field component found:')) return true;
  if (t.startsWith('Vendor NTE in page text:')) return true;

  // JSON dumps
  if (t.startsWith('MassUpdate details:')) return true;
  if (t.startsWith('Callback check:')) return true;
  if (t.startsWith('Finalize summary:')) return true;
  if (t.startsWith('Mass update result:')) return true;

  return false;
}
