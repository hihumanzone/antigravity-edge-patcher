#!/usr/bin/env node
const patcher = require('./patcher');

const res = patcher.checkStatus();
console.log('=====================================================');
console.log('  Antigravity Edge Integration Status (v3)');
console.log('=====================================================\n');
console.log(`Overall Status: [${res.state}]\n`);
console.log('Component Checks:');
console.log(`  - Antigravity Installation : ${res.checks.antigravityInstalled ? 'OK' : 'NOT FOUND'}`);
console.log(`  - app.asar Present         : ${res.checks.appAsarExists ? 'OK' : 'MISSING'}`);
console.log(`  - app.asar Backup Present  : ${res.checks.appAsarBackupExists ? 'YES' : 'NO'}`);
console.log(`  - Edge CDP Engine (v3)     : ${res.checks.edgeCdpEnginePatched ? 'PATCHED (Direct Edge CDP + AI Cursor)' : 'NOT PATCHED'}`);
console.log(`  - Edge Isolated World/DOM  : ${res.checks.edgeCdpIsolatedWorldPatched ? 'PATCHED (Edge DOM/OOPIFs routed)' : 'NOT PATCHED'}`);
console.log(`  - Edge Companion Card UI   : ${res.checks.edgeCompanionUiPatched ? 'PATCHED (Synced Preview & Focus Edge)' : 'NOT PATCHED'}`);
console.log(`  - Legacy MCP Bloat Cleaned : ${res.checks.legacyMcpCleaned ? 'CLEAN (No chrome_devtools MCP config)' : 'LEGACY ENTRIES PRESENT'}`);
console.log('\nPaths:');
console.log(`  - Antigravity Base: ${res.paths.baseDir}`);
console.log(`  - Edge Profile Dir: ${res.paths.edgeProfile}`);
console.log('=====================================================\n');
