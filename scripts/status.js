#!/usr/bin/env node
const patcher = require('./patcher');

const res = patcher.checkStatus();
console.log('=====================================================');
console.log('  Antigravity Edge Integration Status');
console.log('=====================================================\n');
console.log(`Overall Status: [${res.state}]\n`);
console.log('Component Checks:');
console.log(`  - Antigravity Installation : ${res.checks.antigravityInstalled ? 'OK' : 'NOT FOUND'}`);
console.log(`  - app.asar Present         : ${res.checks.appAsarExists ? 'OK' : 'MISSING'}`);
console.log(`  - app.asar Backup Present  : ${res.checks.appAsarBackupExists ? 'YES' : 'NO'}`);
console.log(`  - app.asar Patched         : ${res.checks.appAsarPatched ? 'PATCHED (Edge Auto-launcher active)' : 'ORIGINAL (Chrome default)'}`);
console.log(`  - Edge Launcher in Unpacked: ${res.checks.edgeLauncherUnpackedExists ? 'DEPLOYED' : 'NOT DEPLOYED'}`);
console.log(`  - browser.js Patched       : ${res.checks.browserJsPatched ? 'PATCHED (Edge port 9222)' : 'ORIGINAL (Chrome default)'}`);
console.log(`  - MCP Server Configured    : ${res.checks.mcpConfigConfigured ? 'YES (chrome_devtools active)' : 'NO'}`);
console.log('\nPaths:');
console.log(`  - Antigravity Base: ${res.paths.baseDir}`);
console.log(`  - Edge Profile Dir: ${res.paths.edgeProfile}`);
console.log('=====================================================\n');
