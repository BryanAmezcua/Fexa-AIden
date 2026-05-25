// qa-bot/lib/import.mjs — Template download, fill, upload, and import verification helpers

import ExcelJS from 'exceljs';
import { writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { TMP_DIR } from './config.mjs';

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

// ── Template Download ──────────────────────────────────────────────────────────

// Download the import template by clicking the hamburger menu item.
// Returns the saved file path.
export async function downloadTemplate(page, step, variant = 'subcontractor') {
  step('Initiate template download via hamburger menu');

  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });

  // Click the grid hamburger → Download Import Template
  await page.evaluate(() => {
    Ext.ComponentQuery.query('menu').forEach(m => m.hide?.());
    const btn = Ext.ComponentQuery.query('accountingpricinggrid button[reference=toolbarHamburgerButton]')[0];
    if (!btn) throw new Error('Hamburger button not found');
    btn.el.dom.click();
  });
  await page.waitForTimeout(1000);

  // Click the Download Import Template menu item
  await page.evaluate(() => {
    const items = document.querySelectorAll('.x-menuitem, .x-menu-item, .x-menu .x-component');
    for (const item of items) {
      if (item.textContent.trim().toLowerCase().includes('download import template')) {
        item.click();
        return true;
      }
    }
    // Fallback: try via Ext menu items
    const btn = Ext.ComponentQuery.query('accountingpricinggrid button[reference=toolbarHamburgerButton]')[0];
    if (btn?.getMenu) {
      const menu = btn.getMenu();
      const menuItems = menu.getItems().items;
      for (const mi of menuItems) {
        if (mi.getText?.().toLowerCase().includes('template') || mi.getText?.().toLowerCase().includes('download')) {
          mi.fireEvent('click', mi);
          return true;
        }
      }
    }
    return false;
  });

  let download;
  try {
    download = await downloadPromise;
  } catch (e) {
    // Template may open in new tab via window.open instead of download event
    step('Download event not caught — template may use window.open. Trying direct API download.');
    return await downloadTemplateDirect(page, step, variant);
  }

  ensureTmpDir();
  const filename = download.suggestedFilename() || 'template.xlsx';
  const savePath = join(TMP_DIR, filename);
  await download.saveAs(savePath);
  step(`Template saved: ${savePath}`);
  return savePath;
}

// Fallback: download template directly via the API endpoint
async function downloadTemplateDirect(page, step, variant = 'subcontractor') {
  ensureTmpDir();

  // Determine the object type based on variant or grid context
  let objectType;
  if (variant === 'subcontractor') {
    objectType = 'Products::SubcontractorProductPricingV2';
  } else if (variant === 'client') {
    objectType = 'Products::ClientProductPricingV2';
  } else {
    objectType = await page.evaluate(() => {
      const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
      const ctrl = grid?.getController?.();
      const cfg = ctrl?.getVariantConfig?.();
      return cfg?.objectTypeV2 || 'Products::SubcontractorProductPricingV2';
    });
  }

  const savePath = join(TMP_DIR, 'pricing_template.xlsx');

  // Use page context to fetch with auth cookies
  const base64 = await page.evaluate(async (objType) => {
    const resp = await fetch('/api/v1/import/get_keys?object_type=' + encodeURIComponent(objType), {
      credentials: 'include',
    });
    const blob = await resp.blob();
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.readAsDataURL(blob);
    });
  }, objectType);

  const buffer = Buffer.from(base64, 'base64');
  writeFileSync(savePath, buffer);
  step(`Template downloaded via API: ${savePath}`);
  return savePath;
}

// ── Template Inspection ────────────────────────────────────────────────────────

// Read the template and return its structure: headers, hidden sheets, lookup values
export async function inspectTemplate(templatePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);

  const result = {
    headers: [],
    sheets: [],
    lookups: {},
  };

  workbook.eachSheet((sheet, id) => {
    const sheetInfo = {
      name: sheet.name,
      hidden: sheet.state === 'hidden' || sheet.state === 'veryHidden',
      rowCount: sheet.rowCount,
    };
    result.sheets.push(sheetInfo);

    if (id === 1) {
      // Main data sheet — read headers from row 1
      const headerRow = sheet.getRow(1);
      headerRow.eachCell((cell, colNumber) => {
        result.headers.push({ col: colNumber, name: cell.value?.toString() || '' });
      });
    } else if (sheetInfo.hidden) {
      // Hidden lookup sheet — read all values
      const values = [];
      sheet.eachRow((row, rowNumber) => {
        const rowValues = [];
        row.eachCell((cell) => {
          rowValues.push(cell.value?.toString() || '');
        });
        if (rowValues.length > 0) values.push(rowValues);
      });
      result.lookups[sheet.name] = values;
    }
  });

  return result;
}

// ── Template Fill ──────────────────────────────────────────────────────────────

// Fill the template with test data rows and save as a new file.
// rows: array of objects keyed by column header name, e.g. { 'Action': 'CREATE', 'Pricing Name': 'Test' }
export async function fillTemplate(templatePath, outputPath, rows) {
  ensureTmpDir();

  // Copy template to output path first to preserve all formatting/validation
  copyFileSync(templatePath, outputPath);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);

  const sheet = workbook.worksheets[0]; // Main data sheet

  // Read header names from row 1
  const headers = {};
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    headers[cell.value?.toString()?.trim()] = colNumber;
  });

  // Write data rows starting at row 2
  rows.forEach((rowData, i) => {
    const row = sheet.getRow(i + 2);
    for (const [headerName, value] of Object.entries(rowData)) {
      const colNum = headers[headerName];
      if (colNum) {
        row.getCell(colNum).value = value;
      }
    }
    row.commit();
  });

  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

// ── Import Wizard Navigation ───────────────────────────────────────────────────

// Navigate to the import wizard with a pre-selected import type
export async function navigateToImportWizard(page, step, importType = 'Subcontractor Product Pricing V2') {
  step(`Navigate to import wizard for: ${importType}`);

  // Force a full view change away from any import page first
  // Navigate to a completely different view to destroy the old import components
  await page.evaluate(() => {
    window.location.hash = 'subcontractorproductpricings';
  });
  await page.waitForTimeout(2000);

  // Now navigate to the fresh import wizard
  await page.evaluate((type) => {
    window.location.hash = 'createimport?import=' + encodeURIComponent(type);
  }, importType);

  // Wait for the wizard to render with a filefield visible
  await page.waitForFunction(() => {
    if (typeof Ext === 'undefined' || !Ext.isReady) return false;
    const fileField = Ext.ComponentQuery.query('filefield')[0];
    return fileField?.isVisible?.() || false;
  }, { timeout: 30000 });

  await page.waitForTimeout(2000);
  step('Import wizard loaded');
}

// ── Detail View (Side Edit Menu) ───────────────────────────────────────────────

// Open the side edit panel for a pricing record by finding it in the grid and double-clicking
export async function openPricingDetail(page, step, recordId, variant = 'subcontractor') {
  step(`Opening pricing detail for record #${recordId}`);

  // Navigate to the correct pricing grid
  const gridHash = variant === 'client' ? 'clientproductpricings' : 'subcontractorproductpricings';
  await page.evaluate((hash) => { window.location.hash = hash; }, gridHash);

  // Wait for grid to render AND store to finish loading
  await page.waitForFunction(() => {
    if (typeof Ext === 'undefined') return false;
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    if (!grid?.isVisible?.()) return false;
    const store = grid.getStore?.();
    return store && !store.isLoading?.() && store.getData?.()?.items?.length > 0;
  }, { timeout: 20000 });
  await page.waitForTimeout(2000);

  // Reload store to ensure the newly created record is present
  await page.evaluate(() => {
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    grid?.getStore?.()?.load?.();
  });
  await page.waitForFunction(() => {
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    const store = grid?.getStore?.();
    return store && !store.isLoading?.();
  }, { timeout: 15000 });
  await page.waitForTimeout(1500);

  // Find the record in the grid store and select it via double-click
  const found = await page.evaluate((id) => {
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    if (!grid) return false;
    const store = grid.getStore();
    if (!store?.getData?.()) return false;
    const record = store.findRecord('id', id);
    if (!record) return false;
    // Trigger double-tap to open side edit menu
    grid.setSelection(record);
    grid.fireEvent('childdoubletap', grid, { record });
    return true;
  }, recordId);

  if (!found) {
    step(`Record #${recordId} not found in grid — may need store reload`);
    // Try reloading the store
    await page.evaluate(() => {
      const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
      grid?.getStore?.()?.load?.();
    });
    await page.waitForTimeout(3000);

    await page.evaluate((id) => {
      const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
      const record = grid?.getStore?.()?.findRecord('id', id);
      if (record) {
        grid.setSelection(record);
        grid.fireEvent('childdoubletap', grid, { record });
      }
    }, recordId);
  }

  // Wait for the side edit panel to appear
  await page.waitForTimeout(3000);
  step('Detail panel opened');
}

// ── File Upload ────────────────────────────────────────────────────────────────

// Upload a file through the import wizard's file input
export async function uploadFile(page, step, filePath) {
  step(`Uploading file: ${filePath}`);

  // ExtJS filefield wraps the <input type="file"> deeply. Find it and make it accessible.
  const fileInputHandle = await page.evaluateHandle(() => {
    // Try via ExtJS ComponentQuery first
    const filefield = Ext.ComponentQuery.query('filefield[reference=importfile]')[0]
                   || Ext.ComponentQuery.query('filefield')[0];
    if (filefield) {
      const inputEl = filefield.el.dom.querySelector('input[type="file"]');
      if (inputEl) {
        // Make it visible for Playwright
        inputEl.style.opacity = '1';
        inputEl.style.display = 'block';
        inputEl.style.position = 'absolute';
        inputEl.style.top = '0';
        inputEl.style.left = '0';
        inputEl.style.width = '100px';
        inputEl.style.height = '30px';
        inputEl.style.zIndex = '99999';
        return inputEl;
      }
    }
    // Fallback: find any file input on the page
    const inputs = document.querySelectorAll('input[type="file"]');
    for (const input of inputs) {
      input.style.opacity = '1';
      input.style.display = 'block';
      input.style.position = 'absolute';
      input.style.zIndex = '99999';
      return input;
    }
    return null;
  });

  if (!fileInputHandle || (await fileInputHandle.jsonValue()) === null) {
    throw new Error('File input not found in import wizard');
  }

  // Convert handle to ElementHandle for setInputFiles
  const fileInput = fileInputHandle.asElement();
  await fileInput.setInputFiles(filePath);
  await page.waitForTimeout(1500);
  step('File selected');

  // Click the Upload button
  step('Clicking Upload button');
  await page.evaluate(() => {
    const btns = Ext.ComponentQuery.query('button');
    for (const btn of btns) {
      const text = btn.getText?.() || '';
      if (text.toLowerCase().includes('upload') && btn.isVisible()) {
        btn.el.dom.click();
        return true;
      }
    }
    return false;
  });

  // Wait for the upload to process and confirmation to appear
  await page.waitForTimeout(5000);

  // Check if "Begin Import" button appeared (V2 flow)
  const hasBeginImport = await page.evaluate(() => {
    const btn = Ext.ComponentQuery.query('button[reference=proceedWithUpload]')[0];
    return btn?.isVisible?.() || false;
  });

  step(hasBeginImport ? 'Upload confirmed — Begin Import button visible' : 'File uploaded — waiting for confirmation');
}

// ── Begin Import ───────────────────────────────────────────────────────────────

// Click "Begin Import" after file upload confirmation
export async function beginImport(page, step) {
  step('Clicking Begin Import');

  await page.evaluate(() => {
    // Look for the proceedWithUpload button or any button with "Begin Import" text
    const btn = Ext.ComponentQuery.query('button[reference=proceedWithUpload]')[0];
    if (btn) {
      btn.el.dom.click();
      return true;
    }
    // Fallback: find by text
    const allBtns = Ext.ComponentQuery.query('button');
    for (const b of allBtns) {
      const text = b.getText?.() || '';
      if (text.toLowerCase().includes('begin import') && b.isVisible()) {
        b.el.dom.click();
        return true;
      }
    }
    return false;
  });

  await page.waitForTimeout(2000);
  step('Import started');
}

// ── Wait for Import Completion ─────────────────────────────────────────────────

// Poll the DOM for the import completion message
export async function waitForImportComplete(page, step, timeoutMs = 90000) {
  step('Waiting for import to complete...');

  const completionText = await page.waitForFunction(() => {
    // Check for V2 completion message
    const complete = Ext.ComponentQuery.query('[reference=progressComplete]')[0];
    if (complete?.el?.dom?.textContent?.includes('Processed')) {
      return complete.el.dom.textContent.trim();
    }
    // Check progress bar at 100%
    const bar = Ext.ComponentQuery.query('[reference=progressBar]')[0]
             || Ext.ComponentQuery.query('progress')[0];
    if (bar?.getValue?.() >= 1) {
      // Give it a moment for the completion text to render
      return null; // Keep polling
    }
    return null;
  }, { timeout: timeoutMs });

  const text = await completionText.jsonValue();
  step(`Import complete: ${text}`);

  // Parse: "X Rows Processed. Y Successful. Z Failures."
  const match = text.match(/(\d+)\s*Rows?\s*Processed.*?(\d+)\s*Successful.*?(\d+)\s*Failure/i);
  return {
    total: match ? parseInt(match[1]) : 0,
    successful: match ? parseInt(match[2]) : 0,
    failures: match ? parseInt(match[3]) : 0,
    text,
  };
}

// ── Read Results ───────────────────────────────────────────────────────────────

// Get the list of successfully imported record IDs
export async function getSuccessList(page) {
  return page.evaluate(() => {
    const list = Ext.ComponentQuery.query('[reference=successList]')[0];
    if (!list) return [];
    const store = list.getStore();
    return store.getData().items.map(r => ({
      id: r.data.id,
      text: r.data.text || r.data.name || '',
    }));
  });
}

// Get the list of failures with error details
export async function getFailuresList(page) {
  return page.evaluate(() => {
    const grid = Ext.ComponentQuery.query('[reference=failuresGrid]')[0];
    if (!grid) return [];
    const store = grid.getStore();
    return store.getData().items.map(r => ({
      data: r.data,
      errors: r.data.errors || '',
    }));
  });
}

// ── Convenience: Full Import Flow ──────────────────────────────────────────────

// Run a complete import: navigate → upload → begin → wait → return results
export async function runImport(page, step, screenshot, filePath, importType) {
  await navigateToImportWizard(page, step, importType);
  await screenshot('import-wizard');

  await uploadFile(page, step, filePath);
  await screenshot('file-uploaded');

  await beginImport(page, step);
  await screenshot('import-started');

  const results = await waitForImportComplete(page, step);
  await screenshot('import-complete');

  const successList = await getSuccessList(page);
  const failuresList = await getFailuresList(page);

  step(`Results: ${results.successful} successful, ${results.failures} failures`);

  return { ...results, successList, failuresList };
}

// ── Record Verification ────────────────────────────────────────────────────────

// Find a pricing record by name via the API
export async function findPricingByName(page, pricingName, variant = 'client') {
  const endpoint = variant === 'client'
    ? '/api/v1/client_product_pricings'
    : '/api/v1/subcontractor_product_pricings';

  return page.evaluate(async ({ url, name }) => {
    const resp = await fetch(`${url}?filter[name]=${encodeURIComponent(name)}&limit=5`, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
    const data = await resp.json();
    const records = data.data || data.product_pricings || data;
    if (Array.isArray(records) && records.length > 0) return records[0];
    return null;
  }, { url: endpoint, name: pricingName });
}

// Count how many pricing records match a name prefix
export async function countPricingsByName(page, namePrefix, variant = 'client') {
  const endpoint = variant === 'client'
    ? '/api/v1/client_product_pricings'
    : '/api/v1/subcontractor_product_pricings';

  return page.evaluate(async ({ url, prefix }) => {
    const resp = await fetch(`${url}?filter[name]=${encodeURIComponent(prefix)}&limit=50`, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
    const data = await resp.json();
    const records = data.data || data.product_pricings || data;
    return Array.isArray(records) ? records.length : 0;
  }, { url: endpoint, prefix: namePrefix });
}
