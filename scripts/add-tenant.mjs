#!/usr/bin/env node
// ============================================================
// Register (or update) a tenant in the plugin's TENANTS KV namespace.
//
//   npm run tenant:add -- <cms-origin> [options]
//
// The <cms-origin> is the host CMS's canonical origin — exactly what it sends
// in the `x-cms-tenant` header (its CANONICAL_ORIGIN, normalized). It becomes
// the KV key `tenant:<origin>` and the record's id.
//
// Options:
//   --url <cmsUrl>       Plugin API base URL (default: the origin itself)
//   --secret <value>     Pairwise host↔plugin secret (default: a fresh random one)
//   --sign-key <value>   HMAC key for public tokens (default: same as secret)
//   --public-url <value> Tenant's public guest-facing origin (optional)
//   --local              Write to the local (`wrangler dev`) KV simulation
//   --preview            Write to the preview namespace instead of production
//   --dry-run            Print the record + command, don't call wrangler
//
// After it runs, set the SAME secret on the host CMS under
//   Plugins → import-export → Edit → Shared secret
// so the pairwise secret matches on both ends.
// ============================================================

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      // Boolean flags take no value; everything else consumes the next token.
      if (key === 'local' || key === 'preview' || key === 'dry-run') {
        flags[key] = true;
      } else {
        flags[key] = argv[++i];
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));

if (positional.length !== 1) {
  console.error('Usage: npm run tenant:add -- <cms-origin> [--url <cmsUrl>] [--secret <s>] [--sign-key <k>] [--public-url <u>] [--local] [--preview] [--dry-run]');
  process.exit(1);
}

let origin;
try {
  origin = new URL(positional[0]).origin; // matches the host's pluginTenantId()
} catch {
  console.error(`Not a valid origin: "${positional[0]}" — pass a full URL like https://cms1.example.com`);
  process.exit(1);
}

const secret = flags.secret || randomBytes(24).toString('base64url');

// Only store non-default fields; id defaults to the key suffix, cmsUrl to id,
// signKey to secret (see TenantConfig in the plugin lib).
const record = { secret };
// Store cmsUrl only when it differs from the origin (the default).
if (flags.url) {
  const cmsUrl = flags.url.replace(/\/+$/, '');
  if (cmsUrl !== origin) record.cmsUrl = cmsUrl;
}
if (flags['sign-key']) record.signKey = flags['sign-key'];
if (flags['public-url']) record.publicBaseUrl = flags['public-url'];

const key = `tenant:${origin}`;
const value = JSON.stringify(record);

const wranglerArgs = ['kv', 'key', 'put', '--binding', 'TENANTS', key, value];
if (flags.local) wranglerArgs.push('--local');
else wranglerArgs.push('--remote');
if (flags.preview) wranglerArgs.push('--preview');

console.log(`Tenant : ${origin}`);
console.log(`KV key : ${key}`);
console.log(`Record : ${value}`);
console.log(`Target : ${flags.local ? 'local' : 'remote'}${flags.preview ? ' (preview)' : ''}`);

if (flags['dry-run']) {
  console.log(`\n[dry-run] wrangler ${wranglerArgs.map((a) => (a === value ? `'${a}'` : a)).join(' ')}`);
  process.exit(0);
}

const result = spawnSync('wrangler', wranglerArgs, { stdio: 'inherit' });
if (result.status !== 0) {
  console.error('\nwrangler kv key put failed. Is the TENANTS namespace created (npm run kv:setup) and its id in wrangler.toml?');
  process.exit(result.status ?? 1);
}

if (!flags.secret) {
  console.log('\n─────────────────────────────────────────────');
  console.log('Generated shared secret (set this on the host CMS,');
  console.log('Plugins → import-export → Edit → Shared secret):');
  console.log(`\n    ${secret}\n`);
  console.log('It is not stored anywhere else — copy it now.');
}
