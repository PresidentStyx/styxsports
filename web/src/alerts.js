// Outage alerts from real viewers' telemetry (cron, every 5 minutes; see wrangler.jsonc).
//
// A platform is failing when, over the last 15 minutes, at least MIN_FAILS of its game opens
// could not be opened at all (telemetry `fail`) and they are at least FAIL_SHARE of its opens
// (`fail` + first frames). Then an issue is opened on GitHub (labelled `outage`, @mentioning the
// owner, so GitHub emails and pushes it); a change in which platforms fail is commented and
// retitled; after CLEAN_CHECKS clean checks in a row it is closed.
//
// Needs the secret GITHUB_TOKEN (fine-grained, this repo only, Issues: read & write) and the var
// ALERT_REPO ("owner/name"). Without the token the check still runs and reports "would-open".
import { telemetryStub } from './telemetry.js';

const WINDOW_MIN = 15;
const MIN_FAILS = 3;
const FAIL_SHARE = 0.5;
const CLEAN_CHECKS = 2;
const NAMES = { apk: 'Android TV app', web: 'Web / phone', roku: 'Roku' };

/** Platforms whose opens are failing, from Telemetry.opens(). */
export function failingPlatforms(opens) {
  return opens.filter((p) => p.fails >= MIN_FAILS && p.fails / (p.fails + p.starts) >= FAIL_SHARE)
    .sort((a, b) => a.platform.localeCompare(b.platform));
}

export function alertTitle(failing, opens) {
  const active = opens.filter((p) => p.starts + p.fails > 0).length;
  if (failing.length && failing.length === active && active > 1) return 'Styx Sports: games are failing to open on every platform';
  return `Styx Sports: games are failing to open on ${failing.map((p) => NAMES[p.platform] || p.platform).join(' and ')}`;
}

export function alertReport(opens, now = Date.now()) {
  const lines = [
    `Last ${WINDOW_MIN} minutes as of ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC, from viewers' telemetry:`,
    '',
    '| Platform | Opened | Failed | Viewers failing | Commonest reason |',
    '|---|---|---|---|---|',
  ];
  for (const p of opens) {
    lines.push(`| ${NAMES[p.platform] || p.platform} | ${p.starts} | ${p.fails} | ${p.failDevices} of ${p.devices} | ${p.topReason ? `${p.topReason} (${p.topReasonCount}×)` : '–'} |`);
  }
  if (!opens.length) lines.push('| – | 0 | 0 | – | – |');
  return lines.join('\n');
}

async function github(env, method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${env.ALERT_REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'styxsports-worker',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

/** One check: open, update or close the outage issue. Returns what it did, for logs and tests. */
export async function checkAlerts(env, now = Date.now()) {
  const stub = telemetryStub(env);
  if (!stub) return { action: 'none', reason: 'no telemetry binding' };
  const opens = await stub.opens(WINDOW_MIN);
  const failing = failingPlatforms(opens);
  const state = await stub.alertState();
  const key = failing.map((p) => p.platform).join(',');
  const report = alertReport(opens, now);
  const live = !!(env.GITHUB_TOKEN && env.ALERT_REPO);
  const owner = String(env.ALERT_REPO || '').split('/')[0];

  if (failing.length) {
    const title = alertTitle(failing, opens);
    if (!state) {
      if (!live) return { action: 'would-open', title, live };
      const issue = await github(env, 'POST', '/issues', { title, labels: ['outage'], body: `${report}\n\n@${owner}` });
      await stub.setAlertState({ issue: issue.number, key, clean: 0, since: now });
      return { action: 'open', title, issue: issue.number, live };
    }
    if (state.key !== key) {
      if (live) {
        await github(env, 'PATCH', `/issues/${state.issue}`, { title });
        await github(env, 'POST', `/issues/${state.issue}/comments`, { body: `Now: ${title}\n\n${report}` });
      }
      await stub.setAlertState({ ...state, key, clean: 0 });
      return { action: 'update', title, issue: state.issue, live };
    }
    if (state.clean) await stub.setAlertState({ ...state, clean: 0 });
    return { action: 'still-failing', issue: state.issue, live };
  }

  if (!state) return { action: 'none', live };
  const clean = (state.clean || 0) + 1;
  if (clean < CLEAN_CHECKS) {
    await stub.setAlertState({ ...state, clean });
    return { action: 'recovering', issue: state.issue, live };
  }
  if (live) {
    const mins = Math.round((now - (state.since || now)) / 60_000);
    await github(env, 'POST', `/issues/${state.issue}/comments`, { body: `✅ Recovered after about ${mins} min.\n\n${report}` });
    await github(env, 'PATCH', `/issues/${state.issue}`, { state: 'closed', state_reason: 'completed' });
  }
  await stub.setAlertState(null);
  return { action: 'close', issue: state.issue, live };
}
