/**
 * Antigravity Edge Integration Patch for dist/main.js
 * 
 * 1. Require statement near top of dist/main.js:
 *    const edgeLauncher_1 = require("./edgeLauncher");
 * 
 * 2. Registration call inside app.whenReady() or main startup block:
 *    (0, edgeLauncher_1.setupEdgeAutoLauncher)(electron_1.session);
 */

module.exports = {
  REQUIRE_LINE: 'const edgeLauncher_1 = require("./edgeLauncher");',
  SETUP_LINE: '// Auto-launch Edge for /browser slash command\n    (0, edgeLauncher_1.setupEdgeAutoLauncher)(electron_1.session);'
};
