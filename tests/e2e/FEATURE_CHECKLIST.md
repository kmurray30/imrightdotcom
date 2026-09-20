# imright.com UI feature checklist

Exhaustive inventory of the social-layer UI, grounded in the actual
`client/src` code (not the original planning doc), each mapped to the
Playwright test(s) that exercise it. Run with `npm run test:e2e`.

## A. Global / header nav
All nav options fold into a single "Menu" dropdown (folded together per a
real request — the previous flat row of links also had no responsive
handling and overlapped/ran off-screen at phone width).
| # | Feature | Test |
|---|---|---|
| 1 | Logo links back to home | header-nav.spec.js A1 |
| 2 | History link visible to guests, inside the menu | header-nav.spec.js A2 |
| 3 | Bookmarks link hidden for guests, shown when logged in | header-nav.spec.js A3+A4 |
| 4 | Profile link (display name) hidden for guests, shown when logged in | header-nav.spec.js A3+A4 |
| 5 | Log in / Sign up links shown for guests | header-nav.spec.js A5 |
| 6 | Log out button shown when logged in; clears session | header-nav.spec.js A3+A4+A6 |
| 59 | Menu closes on an outside click and after following a link | header-nav.spec.js "menu closes..." |
| 60 | Header never overflows/overlaps at phone width | header-nav.spec.js "mobile viewport..." |
| 63 | Menu toggle is a hamburger icon for guests, a circular avatar (initial) for a logged-in user | header-nav.spec.js A5/A6 |

## B. Home page / idea generation
| # | Feature | Test |
|---|---|---|
| 7 | Belief form renders (input + submit) | home.spec.js B7 |
| 8 | Submit -> POST /api/run -> SSE stream opens | home.spec.js B8 |
| 9 | Progress bar / step label update on progress events | home.spec.js B8+B9 |
| 10 | `ready` event navigates client-side to the article | home.spec.js B9 |
| 11 | `error` event shows inline error, re-enables form | home.spec.js B11 |
| 12 | Dropped SSE connection shows a clear error (no silent hang) | home.spec.js B12 |
| 13 | Empty/whitespace claim can't be submitted | home.spec.js B13 |
| 14 | Discover feed renders below the idea-input form | home.spec.js B14 |
| 15 | Home page doesn't repeat the "imright.com" heading already in the header | home.spec.js B15 |
| 61 | Submit button is a legible, visually prominent primary action | home.spec.js "B7 style..." |
| 64 | On mobile, the belief input takes clearly more width than the submit button (not an even 50/50 split) | home.spec.js "mobile viewport: the belief input..." |

## C. Discover feed
| # | Feature | Test |
|---|---|---|
| 15 | Discover / Following tabs both present | discover.spec.js C15 |
| 16 | Switching tabs reloads the list | discover.spec.js C16 |
| 17 | Discover surfaces a newly-published public article | discover.spec.js C17+C20 |
| 18 | Following tab disabled + inline prompt for guests | discover.spec.js C18 |
| 19 | Following tab shows followed users' public articles | discover.spec.js C19 |
| 20 | Search filters to matching public articles | discover.spec.js C17+C20 |
| 21 | Clear resets back to the normal feed | discover.spec.js C20+C21 |
| 22 | "Load more" paginates in additional results | discover.spec.js C22 |
| 23 | Empty state when a search matches nothing | discover.spec.js C23 |
| 24 | Article card shows headline/byline/like/comment counts (no bookmark count) and a hero-image thumbnail when one exists | discover.spec.js C24, C17+C20 |
| 65 | On mobile, the Discover grid shows two (smaller) cards per row instead of one | discover.spec.js "mobile viewport: the Discover grid..." |

## D. Article page
| # | Feature | Test |
|---|---|---|
| 25 | Loads an article by id | article.spec.js D25+D34+D35 |
| 26 | Not-found state for an unknown id | article.spec.js D26 |
| 27 | Visibility toggle: owner-only, including a guest owner (rendered, gated behind sign-up on click) | article.spec.js D27+D28, D27 (guest-owner) |
| 70 | New articles default to public (Private is an explicit opt-out, not the starting state) | article.spec.js "a freshly created article is public by default..." |
| 28 | Toggling visibility persists (survives reload) | article.spec.js D27+D28 |
| 29 | Like: allowed on your own article too (identical display); allowed for a guest with no account (no sign-up gate, real engagement counted); persists per-user (or per-guest) across reload; a duplicate like is a no-op | article.spec.js D29 (×4) |
| 30 | Bookmark: quick-add on first click; real button shown to a guest, gated on click | article.spec.js D30+D31, D30 (guest) |
| 31 | Bookmark folder widget on second click: toggle/create folders, duplicate-name error | article.spec.js D30+D31 |
| 32 | Follow: moved off the article page entirely (see Profile page, H) | history-bookmarks-profile.spec.js "D32 (moved here)" |
| 33 | Share copies the link and confirms it | article.spec.js D33 |
| 34 | Article body renders headline/hero/sections/section-images/conclusion | article.spec.js D25+D34+D35 |
| 35 | Citations render as inline links | article.spec.js D25+D34+D35 |
| 36 | Bunky counterargument callout toggles open/closed | article.spec.js D36 |
| 37 | Counterarguments arriving after load are picked up by polling | article.spec.js D37 |
| 38 | Comments: composer always shown, even to a guest — gated behind a sign-up prompt on submit | article.spec.js D38+D41 |
| 39 | Posting a comment prepends it and clears the composer | article.spec.js D39+D40 |
| 40 | Comment like toggles for a logged-in user or a guest (no sign-up gate), persists per-user/per-guest across reload, and is idempotent against duplicates | article.spec.js D39+D40, D40, D40 (guest) |
| 41 | Empty state when there are no comments | article.spec.js D38+D41 |
| 42 | Article page shows the owner byline ("by you" for the viewer's own article, a profile link otherwise) and like/comment/bookmark stats | article.spec.js D42 (×4) |
| 62 | On mobile, Enter submits a comment (Shift+Enter for a newline) without needing the Post button visible | article.spec.js D39 mobile |
| 66 | Every remaining guest-gated control (Bookmark/Follow/Comment/Visibility — Like is no longer gated, see #29/#40) renders normally and prompts via one shared modal only on click, instead of hiding behind inline "Sign up to..." text | article.spec.js D27 (guest-owner), D30 (guest), D38+D41 |
| 67 | Delete an article: buried/muted trigger, owner-only, a plain confirm for a private/no-interaction article, a stronger email-match confirm for a public article with likes/comments/bookmarks, guests can delete their own | article.spec.js "Delete article" describe block |

## Visual legibility (found from real user reports, not covered by the areas above)
| # | Feature | Test |
|---|---|---|
| 57 | Visibility toggle is styled as a real control (border/background), not bare text next to its Save/Share siblings | article.spec.js D27 style |
| 58 | Disabled buttons (comment "Post", bookmark-folder "Add") stay legible — measured via real rendered-pixel contrast, not just DOM presence | article.spec.js D38 style, D30+D31 |

## E. Auth
| # | Feature | Test |
|---|---|---|
| 42 | Signup validation + server error mapping (duplicate username/email, already-logged-in, pattern) | auth.spec.js (Signup describe block) |
| 43 | Successful signup logs in, redirects home, carries over guest history | auth.spec.js E43 |
| 44 | Login error mapping (wrong credentials, lockout after repeated failures) | auth.spec.js (Login/logout describe block) |
| 45 | Successful login redirects home (or back to the page you were on, e.g. an article) and updates the header | auth.spec.js E44+E45, "E45: logging in from an article page..." |
| 46 | Logout clears session, header reverts to guest state | auth.spec.js E46 |
| 68 | Logging into an existing account auto-claims articles this browser generated as a guest first | auth.spec.js "E44/9: logging into an existing account..." |

## F. History page
| # | Feature | Test |
|---|---|---|
| 47 | Guest-ok: shows the current identity's full history (public + private) | history-bookmarks-profile.spec.js F47+F48 |
| 48 | Each entry links to its article with a Public/Private badge | history-bookmarks-profile.spec.js F47+F48 |
| 49 | Empty state with no history | history-bookmarks-profile.spec.js F49 |

## G. Bookmarks page
| # | Feature | Test |
|---|---|---|
| 50 | Lists bookmark folders, including auto-created "Unsorted" | history-bookmarks-profile.spec.js G50 |
| 51 | Empty state with no folders | history-bookmarks-profile.spec.js G51 |

## H. Profile page
| # | Feature | Test |
|---|---|---|
| 52 | "No such user" state for an unknown username | history-bookmarks-profile.spec.js H52 |
| 53 | Shows display name, @username, hides Follow on your own profile | history-bookmarks-profile.spec.js H53+H54 |
| 54 | Shows public articles grid; empty state if none | history-bookmarks-profile.spec.js H53+H54, H54 |
| 69 | Follow toggles for another user (moved here from the article page) | history-bookmarks-profile.spec.js "D32 (moved here)" |

## I. Cross-cutting
| # | Feature | Test |
|---|---|---|
| 55 | Every guest-gated social action shows a sign-up prompt (via the shared modal, see #66), never a raw error | covered per-action across article.spec.js / discover.spec.js |
| 56 | Direct article links work regardless of visibility | article.spec.js I56 |
| 71 | One-time backfill: pre-existing guest-owned private articles were retroactively made public (accounts' own deliberate Private choices are left alone) | `imright/scripts/db/migrations/0005_publicize_guest_owned_private_articles.sql`, applied automatically at server startup — not practical to exercise via a fresh-DB e2e test, verified manually against the dev DB |
