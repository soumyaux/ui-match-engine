// First step of the audit Action (audit.yml). The engine repo is public, and so are its
// run logs, so the workflow is dispatched with nothing but the scan id. This asks the
// worker for the rest (website, frame name, signed links to the scan's files), downloads
// the files, and hands the values to the next steps through $GITHUB_ENV.
// It never prints the website or a link: the site is also masked in every later log line.
//
// Env: WORKER_URL, FINISH_SECRET, SCAN_ID, GITHUB_ENV.
const fs = require('fs');

// Saved file name for each input the worker can sign (missing ones are skipped)
const FILES = {
  tokens: 'tokens.json',
  figma: 'figma-frame.png',
  report: 'captured-report.json',
  shadow: 'captured-shadow.json',
  blackout: 'live-blackout.png',
  clean: 'live-clean.png',
  viewport: 'live-viewport.png',
};

const fail = (msg) => {
  console.error(`❌ ${msg}`);
  fs.mkdirSync('playwright-report', { recursive: true });
  fs.writeFileSync('playwright-report/error-log.txt', msg);
  process.exit(1);
};

async function getJson(url, headers) {
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
      last = `HTTP ${r.status}`;
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) {
      last = e.name === 'TimeoutError' ? 'timed out' : 'network error';
    }
    if (attempt < 3) await new Promise((res) => setTimeout(res, attempt * 2000));
  }
  throw new Error(last);
}

// A value into $GITHUB_ENV, in the multi-line form so no value can break out of its line
function setEnv(name, value) {
  const delim = `EOF_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(process.env.GITHUB_ENV, `${name}<<${delim}\n${value}\n${delim}\n`);
}

(async () => {
  const { WORKER_URL, FINISH_SECRET, SCAN_ID } = process.env;
  if (!SCAN_ID) fail('No scan id was given to the audit.');
  if (!WORKER_URL || !FINISH_SECRET) fail('The audit is not configured (worker address or secret missing).');

  let inputs;
  try {
    inputs = await getJson(`${WORKER_URL.replace(/\/+$/, '')}/api/scan/${encodeURIComponent(SCAN_ID)}/inputs`,
      { 'X-Finish-Secret': FINISH_SECRET });
  } catch (e) {
    fail(`Could not load the audit inputs (${e.message}). Please try again.`);
  }
  if (!inputs || !inputs.success || !inputs.url) fail('Could not load the audit inputs. Please try again.');

  // Before anything else is printed: hide the website from every log line from here on
  console.log(`::add-mask::${inputs.url}`);

  const files = inputs.files || {};
  await Promise.all(Object.entries(FILES).map(async ([key, name]) => {
    if (!files[key]) return;
    try {
      const r = await fetch(files[key], { signal: AbortSignal.timeout(60000) });
      if (!r.ok) return console.warn(`⚠️ ${name}: HTTP ${r.status}`);
      fs.writeFileSync(name, Buffer.from(await r.arrayBuffer()));
      console.log(`${name}: ${fs.statSync(name).size} bytes`);
    } catch (_) {
      console.warn(`⚠️ ${name}: download failed`);
    }
  }));
  if (!fs.existsSync('tokens.json')) fail('Could not load the design data for this audit. Please try again.');

  setEnv('TARGET_URL', inputs.url);
  setEnv('FRAME_NAME', inputs.frame_name || 'Selected Frame');
  setEnv('SESSION_ID', inputs.session_id || `scan-${SCAN_ID}`);
  // Captured mode (login/VPN page, captured by the browser extension)
  if (inputs.captured && fs.existsSync('captured-report.json')) {
    setEnv('CAPTURED_REPORT', 'captured-report.json');
    setEnv('CAPTURED_SHADOW', 'captured-shadow.json');
    setEnv('LIVE_SCREENSHOT', 'live-blackout.png');
    setEnv('LIVE_SCREENSHOT_CLEAN', 'live-clean.png');
    setEnv('LIVE_VIEWPORT', 'live-viewport.png');
    console.log('Mode: captured by the browser extension');
  } else {
    console.log('Mode: cloud audit');
  }
})();
