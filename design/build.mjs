#!/usr/bin/env node
// Generates the per-platform design token files from design/tokens.json.
//   node design/build.mjs          write web/public/tokens.css, app/.../values/tokens.xml, roku/source/Tokens.brs
//   node design/build.mjs --check  exit 1 if any of them is stale (CI)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(readFileSync(join(root, 'design/tokens.json'), 'utf8'));
const HEADER = 'Generated from design/tokens.json by design/build.mjs. Do not edit: change the JSON and run `node design/build.mjs`.';

// --- helpers ------------------------------------------------------------------------------------

const entries = (o) => Object.entries(o).filter(([k]) => !k.startsWith('_'));
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const lookup = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), tokens);

/** "#RRGGBB" | "#RRGGBBAA" -> { rgb: "RRGGBB", a: "AA" } */
function color(hex) {
  const h = hex.replace('#', '').toUpperCase();
  if (h.length !== 6 && h.length !== 8) throw new Error('bad color ' + hex);
  return { rgb: h.slice(0, 6), a: h.length === 8 ? h.slice(6) : 'FF' };
}
const cssColor = (hex) => '#' + (color(hex).a === 'FF' ? color(hex).rgb : color(hex).rgb + color(hex).a).toLowerCase();
const androidColor = (hex) => '#' + color(hex).a + color(hex).rgb; // #AARRGGBB
const rokuColor = (hex) => '0x' + color(hex).rgb + color(hex).a; // 0xRRGGBBAA
const androidDp = (px) => px / 2 + 'dp'; // 1080p TV is xhdpi: 2 px per dp

// --- web ------------------------------------------------------------------------------------------

function css() {
  const out = [`/* ${HEADER} */`, ':root {'];
  for (const [k, v] of entries(tokens.color)) out.push(`  --tk-color-${kebab(k)}: ${cssColor(v)};`);
  for (const [k, v] of entries(tokens.space)) out.push(`  --tk-space-${kebab(k)}: ${v}px;`);
  for (const [k, v] of entries(tokens.radius)) out.push(`  --tk-radius-${kebab(k)}: ${v}px;`);
  for (const [k, t] of entries(tokens.type)) {
    out.push(`  --tk-type-${kebab(k)}-size: ${t.size}px;`);
    out.push(`  --tk-type-${kebab(k)}-weight: ${t.weight};`);
    out.push(`  --tk-type-${kebab(k)}-lh: ${t.lineHeight};`);
    out.push(`  --tk-type-${kebab(k)}-tracking: ${t.tracking}em;`);
  }
  for (const [k, v] of entries(tokens.motion)) out.push(`  --tk-motion-${kebab(k)}: ${typeof v === 'number' ? v + 'ms' : v};`);
  out.push(`  --tk-focus-ring-width: ${tokens.focus.ringWidth}px;`);
  out.push(`  --tk-focus-ring-offset: ${tokens.focus.ringOffset}px;`);
  out.push(`  --tk-focus-scale: ${tokens.focus.scale};`);
  for (const [k, v] of entries(tokens.card)) out.push(`  --tk-card-${kebab(k)}: ${v}px;`);
  out.push('', '  /* names app.css already uses */');
  for (const [name, path] of entries(tokens.aliases.web)) {
    const [group, key] = path.split('.');
    out.push(`  ${name}: var(--tk-${kebab(group)}-${kebab(key)});`);
  }
  out.push('}', '');
  return out.join('\n');
}

// --- android --------------------------------------------------------------------------------------

function androidXml() {
  const out = ['<?xml version="1.0" encoding="utf-8"?>', `<!-- ${HEADER} -->`, '<resources>'];
  for (const [k, v] of entries(tokens.color)) out.push(`    <color name="tk_color_${snake(k)}">${androidColor(v)}</color>`);
  for (const [k, v] of entries(tokens.space)) out.push(`    <dimen name="tk_space_${snake(k)}">${androidDp(v)}</dimen>`);
  for (const [k, v] of entries(tokens.radius)) out.push(`    <dimen name="tk_radius_${snake(k)}">${v >= 999 ? '999dp' : androidDp(v)}</dimen>`);
  for (const [k, t] of entries(tokens.type)) {
    out.push(`    <dimen name="tk_type_${snake(k)}_size">${t.size / 2}sp</dimen>`);
    out.push(`    <integer name="tk_type_${snake(k)}_weight">${t.weight}</integer>`);
    out.push(`    <item name="tk_type_${snake(k)}_lh" type="dimen" format="float">${t.lineHeight}</item>`);
  }
  for (const [k, v] of entries(tokens.motion)) if (typeof v === 'number') out.push(`    <integer name="tk_motion_${snake(k)}">${v}</integer>`);
  out.push(`    <dimen name="tk_focus_ring_width">${androidDp(tokens.focus.ringWidth)}</dimen>`);
  out.push(`    <dimen name="tk_focus_ring_offset">${androidDp(tokens.focus.ringOffset)}</dimen>`);
  out.push(`    <item name="tk_focus_scale" type="dimen" format="float">${tokens.focus.scale}</item>`);
  for (const [k, v] of entries(tokens.card)) out.push(`    <dimen name="tk_card_${snake(k)}">${androidDp(v)}</dimen>`);
  out.push('', '    <!-- names the layouts already use -->');
  for (const [name, path] of entries(tokens.aliases.android)) {
    const [group, key] = path.split('.');
    out.push(`    <color name="${name}">@color/tk_${group}_${snake(key)}</color>`);
  }
  out.push('</resources>', '');
  return out.join('\n');
}

// --- roku -----------------------------------------------------------------------------------------

function brs() {
  const out = [`' ${HEADER}`, '', "' Colors are 0xRRGGBBAA. Aliases are the names Ui_color() has always answered to.", 'function Tokens_color(name as string) as string'];
  const byValue = new Map();
  for (const [k, v] of entries(tokens.color)) (byValue.get(rokuColor(v)) || byValue.set(rokuColor(v), []).get(rokuColor(v))).push(k);
  for (const [name, path] of entries(tokens.aliases.roku)) {
    const v = rokuColor(lookup(path));
    const names = byValue.get(v);
    if (!names.includes(name)) names.push(name);
  }
  for (const [v, names] of byValue) out.push(`    if ${names.map((n) => `name = "${n}"`).join(' or ')} then return "${v}"`);
  out.push('    return "0xFFFFFFFF"', 'end function', '');
  const intFn = (fn, group, fallback) => {
    out.push(`function ${fn}(name as string) as integer`);
    for (const [k, v] of entries(tokens[group])) out.push(`    if name = "${k}" then return ${v}`);
    out.push(`    return ${fallback}`, 'end function', '');
  };
  intFn('Tokens_space', 'space', 8);
  intFn('Tokens_radius', 'radius', 10);
  intFn('Tokens_card', 'card', 0);
  out.push("' Font size in FHD pixels; weight >= 700 is bold on Roku's two-weight system font.", 'function Tokens_fontSize(name as string) as integer');
  for (const [k, t] of entries(tokens.type)) out.push(`    if name = "${k}" then return ${t.size}`);
  out.push('    return 24', 'end function', '', 'function Tokens_fontBold(name as string) as boolean');
  for (const [k, t] of entries(tokens.type)) out.push(`    if name = "${k}" then return ${t.weight >= 700 ? 'true' : 'false'}`);
  out.push('    return false', 'end function', '', "' Milliseconds.", 'function Tokens_motion(name as string) as integer');
  for (const [k, v] of entries(tokens.motion)) if (typeof v === 'number') out.push(`    if name = "${k}" then return ${v}`);
  out.push('    return 200', 'end function', '', 'function Tokens_focusScale() as float', `    return ${tokens.focus.scale}`, 'end function', '');
  return out.join('\n');
}

// --- write / check --------------------------------------------------------------------------------

const outputs = [
  ['web/public/tokens.css', css()],
  ['app/src/main/res/values/tokens.xml', androidXml()],
  ['roku/source/Tokens.brs', brs()],
];
const check = process.argv.includes('--check');
let stale = 0;
for (const [rel, text] of outputs) {
  const file = join(root, rel);
  const current = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null; // Windows checkouts
  if (current === text) continue;
  if (check) { console.error('stale: ' + rel); stale++; continue; }
  writeFileSync(file, text);
  console.log('wrote ' + relative(root, file));
}
if (check) {
  if (stale) { console.error(`${stale} token output(s) out of date; run: node design/build.mjs`); process.exit(1); }
  console.log('tokens up to date');
}
