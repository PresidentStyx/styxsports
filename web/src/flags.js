// Remote feature flags from config.json (`features`, `minVersion`, `pinned`), resolved for one
// device. The APK (Flags.java) and Roku (Flags.brs) implement exactly these rules, so a flag
// means the same thing on every platform:
//
//   "hero": true                                  on everywhere
//   "hero": { "apk": true, "roku": false }        per platform (missing platform = false)
//   "hero": { "rollout": 25 }                     on for 25% of devices (stable per device id)
//   "hero": { "rollout": 50, "platforms": ["apk", "web"], "minVersion": "4.0" }
//
// `minVersion` at the top level is per platform: a client below it shows "update required".
// `pinned` maps a device-id prefix to the APK version that device should install (rollbacks).

export const PLATFORMS = ['web', 'apk', 'roku'];

/** Stable 0..99 bucket for a device id; small arithmetic so BrightScript gets the same answer. */
export function bucket(deviceId) {
  let h = 0;
  const s = String(deviceId || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003;
  return h % 100;
}

/** -1, 0, 1 for dotted numeric versions ("3.9" < "3.10" < "4.0"); junk compares as 0. */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** One flag's value for a device. */
export function flagOn(spec, { platform, deviceId, version }) {
  if (spec === true || spec === false) return spec;
  if (!spec || typeof spec !== 'object') return false;
  if (Array.isArray(spec.platforms) && !spec.platforms.includes(platform)) return false;
  if (spec[platform] === false) return false;
  if (spec.minVersion && version && compareVersions(version, spec.minVersion) < 0) return false;
  if (typeof spec.rollout === 'number') return bucket(deviceId) < spec.rollout;
  if (spec[platform] === true) return true;
  if (typeof spec.enabled === 'boolean') return spec.enabled;
  return false; // an object that only names other platforms, or nothing usable
}

/**
 * Everything a client needs at launch: { flags: {name: bool}, updateRequired, pinnedVersion }.
 * `features` / `minVersion` / `pinned` are the raw config.json objects.
 */
export function resolveFlags(cfg, { platform, deviceId, version }) {
  const p = PLATFORMS.includes(platform) ? platform : 'web';
  const flags = {};
  for (const [name, spec] of Object.entries(cfg.features || {})) {
    if (name.startsWith('_')) continue;
    flags[name] = flagOn(spec, { platform: p, deviceId, version });
  }
  const min = cfg.minVersion && typeof cfg.minVersion === 'object' ? cfg.minVersion[p] : null;
  const updateRequired = !!(min && version && compareVersions(version, min) < 0);
  let pinnedVersion = null;
  if (p === 'apk' && deviceId && cfg.pinned && typeof cfg.pinned === 'object') {
    for (const [prefix, ver] of Object.entries(cfg.pinned)) {
      if (!prefix.startsWith('_') && String(deviceId).startsWith(prefix)) { pinnedVersion = String(ver); break; }
    }
  }
  return { platform: p, flags, minVersion: min || null, updateRequired, pinnedVersion, bucket: deviceId ? bucket(deviceId) : null };
}
