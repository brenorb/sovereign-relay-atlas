export const title = "Browse long-form articles";
export const state = (v) => ({
  loading: "Querying the relays",
  feed: "Article cards",
  empty: "No articles found",
  reading: "Reading an article",
  norelays: "Asked to add a relay",
}[v.screen]);
const steps = {
  Loaded: "relays return articles",
  NothingFound: "relays return nothing",
  NoRelays: "you remove the last relay",
  OpenArticle: "you open a card",
  CloseArticle: "you close the reader",
  EditRelays: "you add, edit or remove a relay",
  Refresh: "you press refresh",
};
export const step = (action) => steps[action] ?? null;
