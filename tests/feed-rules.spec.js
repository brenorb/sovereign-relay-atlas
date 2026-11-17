const { test, expect } = require("@playwright/test");

// Feed.tla rules on the real app, with per-relay mock data and delays.
const article = (id, pubkey, d, title, createdAt) => ({
  id, pubkey, created_at: createdAt, content: `${title} body.`,
  tags: [["d", d], ["title", title], ["published_at", String(createdAt)]],
});

async function mockRelays(page, relays, byRelay) {
  await page.addInitScript(({ relays, byRelay }) => {
    window.localStorage.setItem("sovereign-relay-atlas.relays", JSON.stringify(relays));
    class MockSocket {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        queueMicrotask(() => this.emit("open", {}));
      }
      addEventListener(type, listener) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
      }
      send(payload) {
        const [type, id, filter] = JSON.parse(payload);
        if (type !== "REQ") return;
        const relay = byRelay[this.url] || { delay: 0, events: [] };
        const events = filter.kinds.includes(30023) ? relay.events : [];
        setTimeout(() => {
          events.forEach((event) => this.emit("message", { data: JSON.stringify(["EVENT", id, event]) }));
          this.emit("message", { data: JSON.stringify(["EOSE", id]) });
        }, relay.delay);
      }
      close() { this.emit("close", {}); }
      emit(type, event) { (this.listeners.get(type) || []).forEach((listener) => listener(event)); }
    }
    window.WebSocket = MockSocket;
  }, { relays, byRelay });
}

test("two authors' articles with the same d tag both appear", async ({ page }) => {
  const a = "a".repeat(64), b = "b".repeat(64);
  await mockRelays(page, ["wss://one.example"], {
    "wss://one.example": { delay: 0, events: [article("e1", a, "intro", "Alice Intro", 1_717_600_000), article("e2", b, "intro", "Bob Intro", 1_717_500_000)] },
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Alice Intro" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bob Intro" })).toBeVisible();
});
