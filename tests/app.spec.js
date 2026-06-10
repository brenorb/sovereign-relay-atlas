const { test, expect } = require("@playwright/test");

const articleEvents = [
  {
    id: "article-1",
    pubkey: "pubkey-111111111111111111111111111111111111111111111111111111111111",
    created_at: 1_717_600_000,
    content:
      "# Full article\n\nThis is the complete article body with enough detail to prove the reader opened the full text instead of the summary.\n\nIt includes a second paragraph for the long-form view.",
    tags: [
      ["d", "atlas-reader"],
      ["title", "Atlas Reader"],
      ["summary", "Compact summary for Atlas Reader."],
      ["published_at", "1717600000"],
      ["t", "atlas"],
      ["t", "nostr"],
    ],
  },
  {
    id: "article-2",
    pubkey: "pubkey-222222222222222222222222222222222222222222222222222222222222",
    created_at: 1_717_500_000,
    content: "Second article body for relay management coverage.",
    tags: [
      ["d", "relay-ops"],
      ["title", "Relay Ops"],
      ["summary", "Compact summary for Relay Ops."],
      ["published_at", "1717500000"],
      ["t", "ops"],
    ],
  },
];

const profileEvents = [
  {
    id: "profile-1",
    pubkey: articleEvents[0].pubkey,
    created_at: 1_717_600_100,
    content: JSON.stringify({
      display_name: "Atlas Author",
      picture: "",
    }),
    tags: [],
  },
  {
    id: "profile-2",
    pubkey: articleEvents[1].pubkey,
    created_at: 1_717_500_100,
    content: JSON.stringify({
      display_name: "Relay Operator",
      picture: "",
    }),
    tags: [],
  },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ mockedArticleEvents, mockedProfileEvents }) => {
      const eventMap = {
        article: mockedArticleEvents,
        profile: mockedProfileEvents,
      };

      class MockSocket {
        constructor(url) {
          this.url = url;
          this.readyState = 0;
          this.listeners = new Map();

          queueMicrotask(() => {
            this.readyState = 1;
            this.#emit("open", {});
          });
        }

        addEventListener(type, listener) {
          const current = this.listeners.get(type) || [];
          current.push(listener);
          this.listeners.set(type, current);
        }

        removeEventListener(type, listener) {
          const current = this.listeners.get(type) || [];
          this.listeners.set(
            type,
            current.filter((entry) => entry !== listener),
          );
        }

        send(payload) {
          const [type, subscriptionId, filter] = JSON.parse(payload);

          if (type !== "REQ") {
            return;
          }

          const dataset = filter.kinds?.includes(30023)
            ? eventMap.article
            : eventMap.profile;

          queueMicrotask(() => {
            dataset.forEach((event) => {
              this.#emit("message", {
                data: JSON.stringify(["EVENT", subscriptionId, event]),
              });
            });
            this.#emit("message", {
              data: JSON.stringify(["EOSE", subscriptionId]),
            });
          });
        }

        close() {
          this.readyState = 3;
          this.#emit("close", {});
        }

        #emit(type, event) {
          for (const listener of this.listeners.get(type) || []) {
            listener(event);
          }
        }
      }

      window.WebSocket = MockSocket;
    },
    {
      mockedArticleEvents: articleEvents,
      mockedProfileEvents: profileEvents,
    },
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Atlas Reader" })).toBeVisible();
});

test("opens the full article reader when a card is clicked", async ({ page }) => {
  await page.locator(".article-card").filter({ hasText: "Atlas Reader" }).click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByText(
      "This is the complete article body with enough detail to prove the reader opened the full text instead of the summary.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /close article/i })).toBeVisible();
});

test("turns useful text into navigation and filter controls", async ({ page }) => {
  await page.getByRole("button", { name: "#atlas" }).click();

  await expect(page.getByRole("checkbox", { name: "#atlas" })).toBeChecked();
  await expect(page.locator(".article-card")).toHaveCount(1);
  await expect(page.getByText("Relay Ops")).toHaveCount(0);

  await page.getByRole("link", { name: /relays/i }).click();
  await expect(page).toHaveURL(/#relay-section$/);
  await expect(page.locator("#relay-section")).toBeInViewport();
});

test("keeps tag interactions working from the reader and via keyboard", async ({ page }) => {
  await page.locator(".article-card").filter({ hasText: "Atlas Reader" }).click();
  await page.locator("#reader-tags").getByRole("button", { name: "#atlas" }).click();

  await expect(page.getByRole("checkbox", { name: "#atlas" })).toBeChecked();
  await expect(page.locator(".article-card")).toHaveCount(1);

  await page.getByRole("button", { name: /close article/i }).click();

  const nostrTag = page.locator(".article-card").filter({ hasText: "Atlas Reader" }).getByRole(
    "button",
    { name: "#nostr" },
  );

  await nostrTag.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("checkbox", { name: "#nostr" })).toBeChecked();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("lets the relay section add, edit, persist, and remove relays", async ({ page }) => {
  const relayInput = page.getByLabel("Relay URL");

  await relayInput.fill("wss://relay.example.com");
  await page.getByRole("button", { name: "Add relay" }).click();

  await expect(page.getByText("wss://relay.example.com")).toBeVisible();
  await expect(page.locator("#relay-count")).toHaveText("5");

  await page.getByRole("button", { name: "Edit relay wss://relay.example.com" }).click();
  await expect(relayInput).toHaveValue("wss://relay.example.com");
  await relayInput.fill("wss://relay-updated.example.com");
  await page.getByRole("button", { name: "Save relay" }).click();

  await expect(page.getByText("wss://relay-updated.example.com")).toBeVisible();
  await page.reload();
  await expect(page.getByText("wss://relay-updated.example.com")).toBeVisible();

  await page
    .getByRole("button", { name: "Remove relay wss://relay-updated.example.com" })
    .click();
  await expect(page.getByText("wss://relay-updated.example.com")).toHaveCount(0);
  await expect(page.locator("#relay-count")).toHaveText("4");
});

test("persists an intentionally empty relay set across reloads", async ({ page }) => {
  const relays = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://relay.snort.social",
  ];

  for (const relay of relays) {
    await page.getByRole("button", { name: `Remove relay ${relay}` }).click();
  }

  await expect(page.locator("#relay-count")).toHaveText("0");
  await expect(page.getByText("No relays configured yet.")).toBeVisible();

  await page.reload();

  await expect(page.locator("#relay-count")).toHaveText("0");
  await expect(page.getByText("No relays configured yet.")).toBeVisible();
});
