const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
];

const ARTICLE_KIND = 30023;
const ARTICLE_COUNT = 21;
const QUERY_LIMIT = 60;
const RELAY_TIMEOUT_MS = 3500;

const state = {
  articles: [],
  selectedTags: new Set(),
  matchMode: "or",
  lastUpdated: null,
};

const elements = {
  articleCount: document.getElementById("article-count"),
  relayCount: document.getElementById("relay-count"),
  tagCount: document.getElementById("tag-count"),
  statusLine: document.getElementById("status-line"),
  resultSummary: document.getElementById("result-summary"),
  articleGrid: document.getElementById("article-grid"),
  loadingState: document.getElementById("loading-state"),
  emptyState: document.getElementById("empty-state"),
  tagFilters: document.getElementById("tag-filters"),
  relayList: document.getElementById("relay-list"),
  refreshButton: document.getElementById("refresh-button"),
};

function init() {
  renderRelayList();
  bindEvents();
  loadArticles();
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => loadArticles());

  document.querySelectorAll('input[name="match-mode"]').forEach((input) => {
    input.addEventListener("change", (event) => {
      state.matchMode = event.target.value;
      renderArticles();
    });
  });
}

async function loadArticles() {
  setLoading(true);
  setStatus("Querying long-form articles from relays...");

  try {
    const articleEvents = await fetchEventsFromRelays(
      { kinds: [ARTICLE_KIND], limit: QUERY_LIMIT },
      RELAY_TIMEOUT_MS,
    );

    const normalizedArticles = dedupeArticles(articleEvents)
      .map(normalizeArticle)
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, ARTICLE_COUNT);

    const authorPubkeys = [...new Set(normalizedArticles.map((article) => article.pubkey))];
    const profileEvents = await fetchEventsFromRelays(
      { kinds: [0], authors: authorPubkeys, limit: authorPubkeys.length * 2 || 10 },
      2400,
    );
    const profiles = buildProfileMap(profileEvents);

    state.articles = normalizedArticles.map((article) => ({
      ...article,
      profile: profiles.get(article.pubkey) || buildFallbackProfile(article.pubkey),
    }));
    state.lastUpdated = new Date();
    pruneSelectedTags();
    renderMetrics();
    renderTagFilters();
    renderArticles();
    setStatus(
      `Loaded ${state.articles.length} articles from ${RELAYS.length} relays.`,
    );
  } catch (error) {
    console.error(error);
    setStatus("Could not build the feed. Try refreshing in a few seconds.");
    state.articles = [];
    renderMetrics();
    renderTagFilters();
    renderArticles();
  } finally {
    setLoading(false);
  }
}

async function fetchEventsFromRelays(filter, timeoutMs) {
  const settled = await Promise.allSettled(
    RELAYS.map((relayUrl) => fetchEventsFromRelay(relayUrl, filter, timeoutMs)),
  );

  const seenIds = new Set();
  const merged = [];

  for (const result of settled) {
    if (result.status !== "fulfilled") {
      continue;
    }

    for (const event of result.value) {
      if (!event || !event.id || seenIds.has(event.id)) {
        continue;
      }
      seenIds.add(event.id);
      merged.push(event);
    }
  }

  return merged;
}

function fetchEventsFromRelay(relayUrl, filter, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new WebSocket(relayUrl);
    const subscriptionId = `se-${Math.random().toString(36).slice(2)}`;
    const collected = [];
    const seenIds = new Set();
    let finished = false;

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutHandle);
      try {
        socket.close();
      } catch (_error) {
        // ignore
      }
      resolve(collected);
    };

    const timeoutHandle = window.setTimeout(() => {
      try {
        socket.send(JSON.stringify(["CLOSE", subscriptionId]));
      } catch (_error) {
        // ignore
      }
      finish();
    }, timeoutMs);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", subscriptionId, filter]));
    });

    socket.addEventListener("message", (messageEvent) => {
      let payload;
      try {
        payload = JSON.parse(messageEvent.data);
      } catch (_error) {
        return;
      }

      if (!Array.isArray(payload) || payload.length < 2) {
        return;
      }

      const [type, subId, event] = payload;

      if (type === "EVENT" && subId === subscriptionId && event?.id) {
        if (!seenIds.has(event.id)) {
          seenIds.add(event.id);
          collected.push(event);
        }
        return;
      }

      if (type === "EOSE" && subId === subscriptionId) {
        try {
          socket.send(JSON.stringify(["CLOSE", subscriptionId]));
        } catch (_error) {
          // ignore
        }
        finish();
      }
    });

    socket.addEventListener("error", finish);
    socket.addEventListener("close", finish);
  });
}

function dedupeArticles(events) {
  const eventMap = new Map();

  for (const event of events) {
    const dedupeKey = getTagValue(event.tags, "d") || event.id;
    const existing = eventMap.get(dedupeKey);

    if (!existing || getArticleTimestamp(event) > getArticleTimestamp(existing)) {
      eventMap.set(dedupeKey, event);
    }
  }

  return [...eventMap.values()];
}

function normalizeArticle(event) {
  const title =
    getTagValue(event.tags, "title") ||
    getTagValue(event.tags, "d") ||
    fallbackTitle(event.content);
  const summary =
    getTagValue(event.tags, "summary") || summarize(event.content);
  const hashtags = uniqueTags(getTagValues(event.tags, "t"));

  return {
    id: event.id,
    pubkey: event.pubkey,
    title,
    summary,
    hashtags,
    timestamp: getArticleTimestamp(event),
  };
}

function buildProfileMap(profileEvents) {
  const latestProfiles = new Map();

  for (const event of profileEvents) {
    const existing = latestProfiles.get(event.pubkey);
    if (existing && existing.created_at >= event.created_at) {
      continue;
    }

    try {
      const parsed = JSON.parse(event.content || "{}");
      latestProfiles.set(event.pubkey, {
        name: parsed.display_name || parsed.name || shortenPubkey(event.pubkey),
        picture: typeof parsed.picture === "string" ? parsed.picture : "",
      });
    } catch (_error) {
      latestProfiles.set(event.pubkey, buildFallbackProfile(event.pubkey));
    }
  }

  return latestProfiles;
}

function buildFallbackProfile(pubkey) {
  return {
    name: shortenPubkey(pubkey),
    picture: "",
  };
}

function renderMetrics() {
  elements.articleCount.textContent = String(state.articles.length);
  elements.relayCount.textContent = String(RELAYS.length);
  elements.tagCount.textContent = String(getTagCounts().length);
}

function renderTagFilters() {
  const tagCounts = getTagCounts();

  if (tagCounts.length === 0) {
    elements.tagFilters.innerHTML =
      '<p class="status-line">No hashtags found in the current article set.</p>';
    return;
  }

  elements.tagFilters.innerHTML = tagCounts
    .map(({ tag, count }) => {
      const checked = state.selectedTags.has(tag) ? "checked" : "";
      return `
        <label class="tag-pill">
          <span class="tag-pill-main">
            <input type="checkbox" data-tag="${escapeAttribute(tag)}" ${checked} />
            <span class="tag-name">#${escapeHtml(tag)}</span>
          </span>
          <span class="tag-count">${count}</span>
        </label>
      `;
    })
    .join("");

  elements.tagFilters.querySelectorAll("input[type='checkbox']").forEach((input) => {
    input.addEventListener("change", (event) => {
      const tag = event.target.dataset.tag;
      if (!tag) {
        return;
      }

      if (event.target.checked) {
        state.selectedTags.add(tag);
      } else {
        state.selectedTags.delete(tag);
      }

      renderArticles();
    });
  });
}

function renderArticles() {
  const matchingArticles = state.articles.filter(matchesSelectedTags);

  elements.articleGrid.innerHTML = matchingArticles
    .map((article) => renderArticleCard(article))
    .join("");

  const timestampText = state.lastUpdated
    ? `Updated ${state.lastUpdated.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : "Not loaded yet";

  elements.resultSummary.textContent = `${matchingArticles.length} of ${state.articles.length} articles visible. ${timestampText}.`;

  elements.emptyState.classList.toggle("hidden", matchingArticles.length !== 0);
  elements.articleGrid.classList.toggle("hidden", matchingArticles.length === 0);
}

function renderArticleCard(article) {
  const { profile } = article;
  const pictureMarkup = isUsableImage(profile.picture)
    ? `<img class="author-avatar" src="${escapeAttribute(profile.picture)}" alt="${escapeAttribute(profile.name)}" loading="lazy" referrerpolicy="no-referrer" />`
    : `<span class="author-fallback">${escapeHtml(profile.name.charAt(0).toUpperCase())}</span>`;

  const tagMarkup =
    article.hashtags.length > 0
      ? `<div class="article-tags">${article.hashtags
          .map((tag) => `<span class="article-tag">#${escapeHtml(tag)}</span>`)
          .join("")}</div>`
      : "";

  return `
    <article class="article-card">
      <div class="article-meta">
        <div class="author">
          ${pictureMarkup}
          <span class="author-name">${escapeHtml(profile.name)}</span>
        </div>
        <span>${formatTimestamp(article.timestamp)}</span>
      </div>
      <h3>${escapeHtml(article.title)}</h3>
      <p class="article-summary">${escapeHtml(article.summary)}</p>
      ${tagMarkup}
    </article>
  `;
}

function renderRelayList() {
  elements.relayList.innerHTML = RELAYS.map((relay) => `<li>${relay}</li>`).join("");
}

function getTagCounts() {
  const counts = new Map();

  for (const article of state.articles) {
    const uniqueArticleTags = new Set(article.hashtags);
    for (const tag of uniqueArticleTags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.tag.localeCompare(right.tag);
    });
}

function matchesSelectedTags(article) {
  if (state.selectedTags.size === 0) {
    return true;
  }

  if (state.matchMode === "and") {
    return [...state.selectedTags].every((tag) => article.hashtags.includes(tag));
  }

  return [...state.selectedTags].some((tag) => article.hashtags.includes(tag));
}

function pruneSelectedTags() {
  const availableTags = new Set(getTagCounts().map(({ tag }) => tag));
  state.selectedTags = new Set(
    [...state.selectedTags].filter((tag) => availableTags.has(tag)),
  );
}

function setLoading(isLoading) {
  elements.loadingState.classList.toggle("hidden", !isLoading);
  elements.articleGrid.classList.toggle("hidden", isLoading || state.articles.length === 0);
  elements.emptyState.classList.toggle("hidden", true);
  elements.refreshButton.disabled = isLoading;
}

function setStatus(message) {
  elements.statusLine.textContent = message;
}

function getArticleTimestamp(event) {
  const published = Number(getTagValue(event.tags, "published_at"));
  if (Number.isFinite(published) && published > 0) {
    return published;
  }
  return event.created_at;
}

function getTagValue(tags, name) {
  const entry = tags?.find((tag) => tag[0] === name && tag[1]);
  return entry ? entry[1] : "";
}

function getTagValues(tags, name) {
  return (tags || [])
    .filter((tag) => tag[0] === name && typeof tag[1] === "string")
    .map((tag) => tag[1]);
}

function uniqueTags(tags) {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function fallbackTitle(content) {
  const flattened = cleanText(content);
  if (!flattened) {
    return "Untitled Nostr article";
  }
  return flattened.slice(0, 96);
}

function summarize(content) {
  const flattened = cleanText(content);
  if (!flattened) {
    return "This article did not provide a summary and the content was empty.";
  }
  return flattened.length > 220 ? `${flattened.slice(0, 217)}...` : flattened;
}

function cleanText(content) {
  return String(content || "")
    .replace(/[#>*_`~\-]{1,}/g, " ")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function shortenPubkey(pubkey) {
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`;
}

function formatTimestamp(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isUsableImage(value) {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

init();
