const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  webServer: {
    command:
      "python3 -m http.server 4173 --directory /Users/breno/Documents/code/PROJECTS/sovereign-relay-atlas",
    port: 4173,
    reuseExistingServer: true,
  },
});
