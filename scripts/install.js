#!/usr/bin/env node
const patcher = require('./patcher');

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');
const forceUpdateMcp = args.includes('--update-mcp') || args.includes('--reinstall-mcp');

try {
  patcher.install({ force, forceUpdateMcp });
} catch (err) {
  console.error('\nERROR: ' + err.message);
  process.exit(1);
}
