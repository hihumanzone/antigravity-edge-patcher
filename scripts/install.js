#!/usr/bin/env node
const patcher = require('./patcher');

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');

try {
  patcher.install({ force });
} catch (err) {
  console.error('\nERROR: ' + err.message);
  process.exit(1);
}
