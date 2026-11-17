------------------------------- MODULE Browse -------------------------------
\* Browsing long-form Nostr articles in the atlas, as the reader sees it.
VARIABLES screen

vars == <<screen>>

Init == screen = "loading"

Loaded == screen = "loading" /\ screen' = "feed"
NothingFound == screen = "loading" /\ screen' = "empty"
NoRelays == screen' = "norelays"
PickTag == screen = "feed" /\ UNCHANGED screen
OpenArticle == screen = "feed" /\ screen' = "reading"
CloseArticle == screen = "reading" /\ screen' = "feed"
EditRelays == screen \in {"feed", "empty", "reading", "norelays"} /\ screen' = "loading"
Refresh == screen \in {"feed", "empty"} /\ screen' = "loading"

Next == Loaded \/ NothingFound \/ NoRelays \/ PickTag \/ OpenArticle \/ CloseArticle \/ EditRelays \/ Refresh

Spec == Init /\ [][Next]_vars

Known == screen \in {"loading", "feed", "empty", "reading", "norelays"}
=============================================================================
