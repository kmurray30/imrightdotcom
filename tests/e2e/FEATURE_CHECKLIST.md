# imright.com UI feature checklist

Exhaustive inventory of the social-layer UI, grounded in the actual
`client/src` code (not the original planning doc), each mapped to the
Playwright test(s) that exercise it. Run with `npm run test:e2e`.

## A. Global / header nav
| # | Feature | Test |
|---|---|---|
| 1 | Logo links back to home | header-nav.spec.js A1 |
| 2 | History link visible to guests | header-nav.spec.js A2 |
| 3 | Bookmarks link hidden for guests, shown when logged in | header-nav.spec.js A3+A4 |
| 4 | Profile link (display name) hidden for guests, shown when logged in | header-nav.spec.js A3+A4 |
| 5 | Log in / Sign up links shown for guests | header-nav.spec.js A5 |
| 6 | Log out button shown when logged in; clears session | header-nav.spec.js A3+A4+A6 |

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
| 24 | Article card shows headline/byline/like/comment/bookmark counts | discover.spec.js C24 |

## D. Article page
| # | Feature | Test |
|---|---|---|
| 25 | Loads an article by id | article.spec.js D25+D34+D35 |
| 26 | Not-found state for an unknown id | article.spec.js D26 |
| 27 | Visibility toggle: owner-only; guest-owner sees a sign-up prompt instead | article.spec.js D27+D28, D27 (guest-owner) |
| 28 | Toggling visibility persists (survives reload) | article.spec.js D27+D28 |
| 29 | Like: hidden on your own article; guest prompt; toggles for others | article.spec.js D29, D29 (guest) |
| 30 | Bookmark: quick-add on first click; guest prompt | article.spec.js D30+D31, D30 (guest) |
| 31 | Bookmark folder widget on second click: toggle/create folders, duplicate-name error | article.spec.js D30+D31 |
| 32 | Follow: hidden on your own article; toggles for others | article.spec.js D32 |
| 33 | Share copies the link and confirms it | article.spec.js D33 |
| 34 | Article body renders headline/hero/sections/section-images/conclusion | article.spec.js D25+D34+D35 |
| 35 | Citations render as inline links | article.spec.js D25+D34+D35 |
| 36 | Bunky counterargument callout toggles open/closed | article.spec.js D36 |
| 37 | Counterarguments arriving after load are picked up by polling | article.spec.js D37 |
| 38 | Comments: guest sees a sign-up prompt instead of the composer | article.spec.js D38+D41 |
| 39 | Posting a comment prepends it and clears the composer | article.spec.js D39+D40 |
| 40 | Comment like toggles for a logged-in user | article.spec.js D39+D40 |
| 41 | Empty state when there are no comments | article.spec.js D38+D41 |

## E. Auth
| # | Feature | Test |
|---|---|---|
| 42 | Signup validation + server error mapping (duplicate username/email, already-logged-in, pattern) | auth.spec.js (Signup describe block) |
| 43 | Successful signup logs in, redirects home, carries over guest history | auth.spec.js E43 |
| 44 | Login error mapping (wrong credentials, lockout after repeated failures) | auth.spec.js (Login/logout describe block) |
| 45 | Successful login redirects home and updates the header | auth.spec.js E44+E45 |
| 46 | Logout clears session, header reverts to guest state | auth.spec.js E46 |

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

## I. Cross-cutting
| # | Feature | Test |
|---|---|---|
| 55 | Every guest-gated social action shows a sign-up prompt, never a raw error | covered per-action across article.spec.js / discover.spec.js |
| 56 | Direct article links work regardless of visibility | article.spec.js I56 |
