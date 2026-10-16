import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { ArticleCard } from './ArticleCard.jsx';

const PAGE_SIZE = 30;

/** One random seed per feed *load* (tab switch / explicit refresh), reused
 * across pagination within that load — see the plan's Discover Feed Ranking
 * section for why: a fresh random() per page request breaks pagination
 * (duplicate/skipped rows), while a stable seed keeps one scroll session
 * consistent and only reshuffles between separate loads. */
function newSeed() {
  return crypto.randomUUID();
}

const SORT_OPTIONS = [
  { value: 'new', label: 'Newest' },
  { value: 'popular', label: 'Popular' },
  { value: 'algo', label: 'Algo' },
];

export function DiscoverFeed() {
  const { isGuest } = useAuth();
  const [tab, setTab] = useState('discover');
  const [sort, setSort] = useState('new');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef(null);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [seed, setSeed] = useState(newSeed);
  const [articles, setArticles] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!sortMenuOpen) return undefined;
    function handleClickOutside(event) {
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target)) setSortMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [sortMenuOpen]);

  const load = useCallback(
    async (nextCursor, replace) => {
      setIsLoading(true);
      try {
        let data;
        if (activeQuery) {
          data = await api.get(`/api/discover/search?q=${encodeURIComponent(activeQuery)}&cursor=${nextCursor}`);
        } else if (tab === 'following') {
          data = await api.get(`/api/discover/following?cursor=${nextCursor}`);
        } else {
          data = await api.get(`/api/discover?seed=${seed}&sort=${sort}&cursor=${nextCursor}`);
        }
        const rows = data?.articles ?? [];
        setArticles((prev) => (replace ? rows : [...prev, ...rows]));
        setHasMore(rows.length === PAGE_SIZE);
        setCursor(nextCursor + rows.length);
      } catch {
        if (replace) setArticles([]);
        setHasMore(false);
      } finally {
        setIsLoading(false);
      }
    },
    [tab, seed, sort, activeQuery]
  );

  useEffect(() => {
    load(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, seed, sort, activeQuery]);

  function switchTab(nextTab) {
    if (nextTab === tab) return;
    setTab(nextTab);
    setSeed(newSeed());
    setActiveQuery('');
    setQuery('');
  }

  function changeSort(nextSort) {
    setSortMenuOpen(false);
    if (nextSort === sort) return;
    setSort(nextSort);
    // A fresh seed so "Algo"'s jitter reshuffles right away instead of
    // reusing whatever the feed happened to load with earlier.
    setSeed(newSeed());
  }

  function handleSearchSubmit(event) {
    event.preventDefault();
    setActiveQuery(query.trim());
  }

  return (
    <section className="discover-feed">
      <div className="discover-tabs">
        <button type="button" className={tab === 'discover' ? 'is-active' : ''} onClick={() => switchTab('discover')}>
          Discover
        </button>
        <button
          type="button"
          className={tab === 'following' ? 'is-active' : ''}
          onClick={() => switchTab('following')}
          disabled={isGuest}
          title={isGuest ? 'Sign up to follow people and see their articles here' : undefined}
        >
          Following
        </button>
      </div>
      {isGuest && tab === 'following' && (
        <p className="guest-prompt-inline">Sign up to follow people and see their articles here.</p>
      )}

      <form className="discover-search" onSubmit={handleSearchSubmit}>
        {tab === 'discover' && !activeQuery && (
          <div className="discover-sort" ref={sortMenuRef}>
            <button
              type="button"
              className="discover-sort-toggle"
              aria-haspopup="true"
              aria-expanded={sortMenuOpen}
              aria-label={`Sort: ${SORT_OPTIONS.find((o) => o.value === sort)?.label}`}
              title={`Sort: ${SORT_OPTIONS.find((o) => o.value === sort)?.label}`}
              onClick={() => setSortMenuOpen((open) => !open)}
            >
              ↕
            </button>
            {sortMenuOpen && (
              <div className="discover-sort-menu" role="radiogroup" aria-label="Sort Discover feed">
                {SORT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={sort === option.value}
                    className={sort === option.value ? 'is-active' : ''}
                    onClick={() => changeSort(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search public articles..."
          aria-label="Search public articles"
        />
        <button type="submit">Search</button>
        {activeQuery && (
          <button
            type="button"
            onClick={() => {
              setActiveQuery('');
              setQuery('');
            }}
          >
            Clear
          </button>
        )}
      </form>

      <div className="article-grid">
        {articles.map((article) => (
          <ArticleCard key={article.id} article={article} />
        ))}
      </div>
      {!isLoading && articles.length === 0 && <p className="empty-state">Nothing here yet.</p>}
      {hasMore && articles.length > 0 && (
        <button type="button" disabled={isLoading} onClick={() => load(cursor, false)} className="load-more">
          {isLoading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
