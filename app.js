const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
];

const ARTICLE_KIND = 30023;
const ARTICLE_COUNT = 21;
const QUERY_LIMIT = 60;
const RELAY_TIMEOUT_MS = 3500;
const PROFILE_TIMEOUT_MS = 2400;
const RELAY_STORAGE_KEY = "sovereign-relay-atlas.relays";

const state = {
  articles: [],
  relays: loadRelaySet(),
  selectedTags: new Set(),
  matchMode: "or",
  lastUpdated: null,
  activeArticleId: "",
  editingRelayIndex: null,
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
  emptyStateTitle: document.getElementById("empty-state-title"),
  emptyStateBody: document.getElementById("empty-state-body"),
  tagFilters: document.getElementById("tag-filters"),
  relayList: document.getElementById("relay-list"),
  refreshButton: document.getElementById("refresh-button"),
  relayForm: document.getElementById("relay-form"),
  relayInput: document.getElementById("relay-input"),
  relaySubmit: document.getElementById("relay-submit"),
  relayCancel: document.getElementById("relay-cancel"),
  articleReader: document.getElementById("article-reader"),
  readerTitle: document.getElementById("reader-title"),
  readerMeta: document.getElementById("reader-meta"),
  readerTags: document.getElementById("reader-tags"),
  readerBody: document.getElementById("reader-body"),
  readerClose: document.getElementById("reader-close"),
};

function init() {
  renderMetrics();
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

  elements.relayForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitRelay();
  });
  elements.relayCancel.addEventListener("click", resetRelayEditor);
  elements.relayList.addEventListener("click", handleRelayListClick);
  elements.articleGrid.addEventListener("click", handleArticleGridClick);
  elements.articleGrid.addEventListener("keydown", handleArticleGridKeydown);
  elements.readerClose.addEventListener("click", closeArticleReader);
  elements.articleReader.addEventListener("click", (event) => {
    const tagTrigger = event.target.closest("[data-tag-trigger]");
    if (tagTrigger) {
      event.stopPropagation();
      toggleSelectedTag(tagTrigger.dataset.tagTrigger);
      return;
    }

    if (event.target instanceof HTMLElement && event.target.dataset.closeReader === "true") {
      closeArticleReader();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isReaderOpen()) {
      closeArticleReader();
    }
  });
}

async function loadArticles() {
  if (state.relays.length === 0) {
    state.articles = [];
    state.lastUpdated = null;
    closeArticleReader();
    renderMetrics();
    renderTagFilters();
    renderArticles();
    setStatus("Add at least one relay to query long-form articles.");
    return;
  }

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
      PROFILE_TIMEOUT_MS,
    );
    const profiles = buildProfileMap(profileEvents);

    state.articles = normalizedArticles.map((article) => ({
      ...article,
      profile: profiles.get(article.pubkey) || buildFallbackProfile(article.pubkey),
    }));
    state.lastUpdated = new Date();
    if (!state.articles.some((article) => article.id === state.activeArticleId)) {
      closeArticleReader();
    } else {
      renderArticleReader();
    }
    pruneSelectedTags();
    renderMetrics();
    renderTagFilters();
    renderArticles();
    setStatus(
      `Loaded ${state.articles.length} articles from ${state.relays.length} relays.`,
    );
  } catch (error) {
    console.error(error);
    setStatus("Could not build the feed. Try refreshing in a few seconds.");
    state.articles = [];
    closeArticleReader();
    renderMetrics();
    renderTagFilters();
    renderArticles();
  } finally {
    setLoading(false);
  }
}

async function fetchEventsFromRelays(filter, timeoutMs) {
  const settled = await Promise.allSettled(
    state.relays.map((relayUrl) => fetchEventsFromRelay(relayUrl, filter, timeoutMs)),
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
    // NIP-23 articles are addressed by author and d tag: two authors may
    // both publish an article with d = "intro".
    const dTag = getTagValue(event.tags, "d");
    const dedupeKey = dTag ? `${event.pubkey}:${dTag}` : event.id;
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
    content: String(event.content || ""),
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
  elements.relayCount.textContent = String(state.relays.length);
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
            <input
              type="checkbox"
              data-tag="${escapeAttribute(tag)}"
              aria-label="#${escapeAttribute(tag)}"
              ${checked}
            />
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

      toggleSelectedTag(tag, event.target.checked);
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

  elements.emptyStateTitle.textContent = "No articles match the current filter";
  elements.emptyStateBody.textContent =
    "Try clearing some hashtags or switching from AND to OR mode.";
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
          .map(
            (tag) => `
              <button
                class="article-tag text-button"
                type="button"
                data-tag-trigger="${escapeAttribute(tag)}"
                aria-label="#${escapeAttribute(tag)}"
              >
                #${escapeHtml(tag)}
              </button>
            `,
          )
          .join("")}</div>`
      : "";

  return `
    <article
      class="article-card"
      data-article-id="${escapeAttribute(article.id)}"
      tabindex="0"
      role="button"
      aria-label="Open article ${escapeAttribute(article.title)}"
    >
      <div class="article-open-content">
        <div class="article-meta">
          <div class="author">
            ${pictureMarkup}
            <span class="author-name">${escapeHtml(profile.name)}</span>
          </div>
          <span>${formatTimestamp(article.timestamp)}</span>
        </div>
        <h3>${escapeHtml(article.title)}</h3>
        <p class="article-summary">${escapeHtml(article.summary)}</p>
        <span class="article-cta">Open article</span>
      </div>
      ${tagMarkup}
    </article>
  `;
}

function renderRelayList() {
  if (state.relays.length === 0) {
    elements.relayList.innerHTML = '<li class="relay-empty">No relays configured yet.</li>';
    return;
  }

  elements.relayList.innerHTML = state.relays
    .map((relay, index) => {
      const editingClass = index === state.editingRelayIndex ? " is-editing" : "";
      return `
        <li class="relay-item${editingClass}">
          <span class="relay-url">${escapeHtml(relay)}</span>
          <span class="relay-actions">
            <button
              class="text-button"
              type="button"
              data-relay-action="edit"
              data-relay-index="${index}"
              aria-label="Edit relay ${escapeAttribute(relay)}"
            >
              Edit
            </button>
            <button
              class="text-button"
              type="button"
              data-relay-action="remove"
              data-relay-index="${index}"
              aria-label="Remove relay ${escapeAttribute(relay)}"
            >
              Remove
            </button>
          </span>
        </li>
      `;
    })
    .join("");
}

function renderArticleReader() {
  const article = getActiveArticle();

  if (!article) {
    elements.articleReader.classList.add("hidden");
    elements.articleReader.setAttribute("aria-hidden", "true");
    document.body.classList.remove("reader-open");
    return;
  }

  elements.readerTitle.textContent = article.title;
  elements.readerMeta.textContent = `${article.profile.name} · ${formatTimestamp(article.timestamp)}`;
  elements.readerTags.innerHTML = article.hashtags
    .map(
      (tag) => `
        <button
          class="article-tag text-button"
          type="button"
          data-tag-trigger="${escapeAttribute(tag)}"
          aria-label="#${escapeAttribute(tag)}"
        >
          #${escapeHtml(tag)}
        </button>
      `,
    )
    .join("");
  elements.readerBody.innerHTML = formatArticleContent(article.content);
  elements.articleReader.classList.remove("hidden");
  elements.articleReader.setAttribute("aria-hidden", "false");
  document.body.classList.add("reader-open");
}

function handleArticleGridClick(event) {
  const tagTrigger = event.target.closest("[data-tag-trigger]");
  if (tagTrigger) {
    event.stopPropagation();
    toggleSelectedTag(tagTrigger.dataset.tagTrigger);
    return;
  }

  const card = event.target.closest("[data-article-id]");
  if (!card) {
    return;
  }

  openArticleReader(card.dataset.articleId);
}

function handleArticleGridKeydown(event) {
  if (event.target.closest("[data-tag-trigger]")) {
    return;
  }

  const card = event.target.closest("[data-article-id]");
  if (!card) {
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openArticleReader(card.dataset.articleId);
  }
}

function handleRelayListClick(event) {
  const actionButton = event.target.closest("[data-relay-action]");
  if (!actionButton) {
    return;
  }

  const relayIndex = Number(actionButton.dataset.relayIndex);
  if (!Number.isInteger(relayIndex) || !state.relays[relayIndex]) {
    return;
  }

  if (actionButton.dataset.relayAction === "edit") {
    startRelayEdit(relayIndex);
    return;
  }

  removeRelay(relayIndex);
}

function submitRelay() {
  const nextRelay = normalizeRelayValue(elements.relayInput.value);
  if (!nextRelay) {
    setStatus("Enter a valid relay URL that starts with ws:// or wss://.");
    return;
  }

  const duplicateIndex = state.relays.findIndex((relay) => relay === nextRelay);
  if (
    duplicateIndex !== -1 &&
    duplicateIndex !== state.editingRelayIndex
  ) {
    setStatus("That relay is already in the current set.");
    return;
  }

  if (state.editingRelayIndex === null) {
    state.relays = [...state.relays, nextRelay];
    setStatus(`Added relay ${nextRelay}.`);
  } else {
    state.relays = state.relays.map((relay, index) =>
      index === state.editingRelayIndex ? nextRelay : relay,
    );
    setStatus(`Updated relay to ${nextRelay}.`);
  }

  persistRelaySet();
  resetRelayEditor();
  renderRelayList();
  renderMetrics();
  loadArticles();
}

function startRelayEdit(index) {
  state.editingRelayIndex = index;
  elements.relayInput.value = state.relays[index];
  elements.relaySubmit.textContent = "Save relay";
  elements.relayCancel.classList.remove("hidden");
  renderRelayList();
  elements.relayInput.focus();
  elements.relayInput.select();
}

function resetRelayEditor() {
  state.editingRelayIndex = null;
  elements.relayForm.reset();
  elements.relaySubmit.textContent = "Add relay";
  elements.relayCancel.classList.add("hidden");
  renderRelayList();
}

function removeRelay(index) {
  const [removedRelay] = state.relays.slice(index, index + 1);
  state.relays = state.relays.filter((_relay, relayIndex) => relayIndex !== index);
  persistRelaySet();

  if (state.editingRelayIndex === index) {
    resetRelayEditor();
  } else if (
    state.editingRelayIndex !== null &&
    state.editingRelayIndex > index
  ) {
    state.editingRelayIndex -= 1;
  }

  renderRelayList();
  renderMetrics();
  setStatus(`Removed relay ${removedRelay}.`);
  loadArticles();
}

function openArticleReader(articleId) {
  state.activeArticleId = articleId;
  renderArticleReader();
}

function closeArticleReader() {
  state.activeArticleId = "";
  renderArticleReader();
}

function toggleSelectedTag(tag, forceState) {
  const shouldEnable =
    typeof forceState === "boolean" ? forceState : !state.selectedTags.has(tag);

  if (shouldEnable) {
    state.selectedTags.add(tag);
  } else {
    state.selectedTags.delete(tag);
  }

  renderTagFilters();
  renderArticles();
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
  elements.relaySubmit.disabled = isLoading;
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
  return [
    ...new Set(
      tags
        .map((tag) => tag.trim().toLowerCase().replace(/^#+/, ""))
        .filter(Boolean),
    ),
  ];
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

function formatArticleContent(content) {
  const source = String(content || "").trim();
  if (!source) {
    return '<p class="article-body-empty">This article did not include body content.</p>';
  }

  const blocks = source.split(/\n\s*\n/);
  return blocks
    .map((block) => renderContentBlock(block.trim()))
    .filter(Boolean)
    .join("");
}

function renderContentBlock(block) {
  if (!block) {
    return "";
  }

  if (/^#{1,6}\s+/.test(block)) {
    const level = Math.min(6, block.match(/^#+/)[0].length);
    const text = block.replace(/^#{1,6}\s+/, "");
    return `<h${level}>${escapeHtml(text)}</h${level}>`;
  }

  if (/^>\s?/.test(block)) {
    return `<blockquote>${escapeHtml(block.replace(/^>\s?/gm, "")).replaceAll("\n", "<br />")}</blockquote>`;
  }

  if (/^[-*]\s+/m.test(block)) {
    const items = block
      .split("\n")
      .filter((line) => /^[-*]\s+/.test(line))
      .map((line) => `<li>${escapeHtml(line.replace(/^[-*]\s+/, ""))}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  return `<p>${escapeHtml(block).replaceAll("\n", "<br />")}</p>`;
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

function loadRelaySet() {
  try {
    const raw = window.localStorage.getItem(RELAY_STORAGE_KEY);
    if (!raw) {
      return [...DEFAULT_RELAYS];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_RELAYS];
    }

    const relays = parsed
      .map((value) => normalizeRelayValue(value))
      .filter(Boolean);
    return relays;
  } catch (_error) {
    return [...DEFAULT_RELAYS];
  }
}

function persistRelaySet() {
  window.localStorage.setItem(RELAY_STORAGE_KEY, JSON.stringify(state.relays));
}

function normalizeRelayValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  if (!/^wss?:\/\//i.test(trimmed)) {
    return "";
  }

  return trimmed.replace(/\/+$/, "");
}

function getActiveArticle() {
  return state.articles.find((article) => article.id === state.activeArticleId) || null;
}

function isReaderOpen() {
  return Boolean(state.activeArticleId);
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
