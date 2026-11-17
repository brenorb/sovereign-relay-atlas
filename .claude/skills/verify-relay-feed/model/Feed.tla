-------------------------------- MODULE Feed --------------------------------
\* The article feed in app.js: loadArticles queries every relay in
\* state.relays and renders when all of them answered or timed out.
\* The page starts a load with relays {slow, fast}; the reader then removes
\* "slow", which starts a second load with {fast}. Either load may finish
\* first.
\*   Start(l)  -> loadArticles: take the relay list at the time of the call
\*   Finish(l) -> fetchEventsFromRelays resolves; render state.articles
\* Broken = TRUE is the code before the fix: every load rendered.
CONSTANT Broken

Loads == {1, 2}
RelaysOf == [l \in Loads |-> IF l = 1 THEN {"slow", "fast"} ELSE {"fast"}]

VARIABLES relays, started, finished, latest, shown

vars == <<relays, started, finished, latest, shown>>

Init ==
  /\ relays = {"slow", "fast"}
  /\ started = {} /\ finished = {} /\ latest = 0 /\ shown = {}

Start(l) ==
  /\ l \notin started
  /\ l = 1 \/ 1 \in started
  /\ relays' = RelaysOf[l]
  /\ started' = started \cup {l} /\ latest' = l
  /\ UNCHANGED <<finished, shown>>

Finish(l) ==
  /\ l \in started /\ l \notin finished
  /\ finished' = finished \cup {l}
  /\ shown' = IF Broken \/ l = latest THEN RelaysOf[l] ELSE shown
  /\ UNCHANGED <<relays, started, latest>>

Idle == finished = Loads /\ UNCHANGED vars

Next == Idle \/ \E l \in Loads : Start(l) \/ Finish(l)

Spec == Init /\ [][Next]_vars

\* Once every load is done, the page shows only relays still in the list.
ShowsOnlyCurrentRelays == finished = Loads => shown \subseteq relays
=============================================================================
