const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  workers: 1, // all tests share one browser with the extension loaded
  reporter: [['list'], ['html', { open: 'never' }]],
});
