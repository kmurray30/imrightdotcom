/**
 * UI rendering and state: articles, contrasts, loading, status, info blurb.
 * Functions receive DOM elements as arguments to avoid coupling.
 */

import { escapeHtml, sanitizeText } from "./utils.js";
import { LOADING_MESSAGES, DEFAULT_BUTTON_TEXT } from "./config.js";

// Module-level state for loading message cycling (cleared when loading stops)
let loadingInterval = null;

/**
 * Sets the info blurb open/closed state and updates aria attributes.
 * @param {HTMLElement | null} infoBlurb
 * @param {HTMLElement | null} infoToggle
 * @param {boolean} isOpen
 */
export function setInfoBlurbOpen(infoBlurb, infoToggle, isOpen) {
  if (!infoBlurb || !infoToggle) return;

  if (isOpen) {
    infoBlurb.classList.add("info-blurb--open");
    infoBlurb.setAttribute("aria-hidden", "false");
  } else {
    infoBlurb.classList.remove("info-blurb--open");
    infoBlurb.setAttribute("aria-hidden", "true");
  }

  infoToggle.setAttribute("aria-expanded", String(isOpen));
}

/**
 * Renders article cards into the article list container.
 * @param {HTMLElement} articleList
 * @param {Array<{ title: string, source?: string, snippet?: string, confirmation?: string }>} articles
 * @param {() => void} onArticlesRendered - Callback after render (e.g. to attach click handlers)
 */
export function renderArticles(articleList, articles, onArticlesRendered) {
  articleList.innerHTML = articles
    .map((article, index) => {
      const title = escapeHtml(article.title);
      const source = escapeHtml(article.source ?? "Unknown outlet");
      const snippet = escapeHtml(article.snippet ?? "");
      const confirmation = article.confirmation ? escapeHtml(article.confirmation) : "";

      return `
        <li class="article-card" data-article-index="${index}">
          <span class="article-card__eyebrow">confidence feed</span>
          <h3 class="article-card__title">${title}</h3>
          <p class="article-card__meta">
            <span class="article-card__source">${source}</span>
            ${confirmation ? `<span class="article-card__confirm">${confirmation}</span>` : ""}
          </p>
          <p class="article-card__snippet">${snippet}</p>
        </li>
      `;
    })
    .join("");

  if (onArticlesRendered) onArticlesRendered();
}

/**
 * Renders contrast rows (belief vs expert) into the contrast view container.
 * @param {HTMLElement} contrastView
 * @param {Array<{ belief: string, expert: string, articleIndex?: number }>} contrasts
 */
export function renderContrasts(contrasts, contrastView) {
  contrastView.innerHTML = contrasts
    .map((contrast) => {
      const articleIndex = contrast.articleIndex !== undefined ? contrast.articleIndex : -1;
      return `
        <div class="contrast__row" data-article-index="${articleIndex}">
          <div class="contrast__column contrast__column--belief">
            <span class="contrast__tag contrast__tag--belief">Belief</span>
            <p class="contrast__content">${escapeHtml(contrast.belief)}</p>
          </div>
          <div class="contrast__column contrast__column--expert">
            <span class="contrast__tag contrast__tag--expert">Experts</span>
            <p class="contrast__content">${escapeHtml(contrast.expert)}</p>
          </div>
        </div>
      `;
    })
    .join("");
}

/**
 * Sets loading state: disables form, shows/hides spinner, cycles loading messages.
 * @param {boolean} isLoading
 * @param {{ beliefForm: HTMLElement, beliefInput: HTMLInputElement, submitButton: HTMLButtonElement, loadingAnimation: HTMLElement, loadingText: HTMLElement }} domRefs
 */
export function setLoadingState(isLoading, domRefs) {
  const { beliefForm, beliefInput, submitButton, loadingAnimation, loadingText } = domRefs;
  if (!beliefForm || !beliefInput || !submitButton || !loadingAnimation || !loadingText) return;

  submitButton.disabled = isLoading;
  beliefInput.disabled = isLoading;
  submitButton.textContent = isLoading ? "Cherry-picking…" : DEFAULT_BUTTON_TEXT;
  beliefForm.classList.toggle("belief-form--loading", isLoading);

  if (isLoading) {
    loadingAnimation.classList.add("active");

    let messageIndex = 0;
    loadingText.textContent = LOADING_MESSAGES[messageIndex];
    loadingText.classList.remove("fade-out");
    loadingText.classList.add("fade-in");

    loadingInterval = setInterval(() => {
      loadingText.classList.remove("fade-in");
      loadingText.classList.add("fade-out");

      setTimeout(() => {
        messageIndex = (messageIndex + 1) % LOADING_MESSAGES.length;
        loadingText.textContent = LOADING_MESSAGES[messageIndex];
        loadingText.classList.remove("fade-out");
        loadingText.classList.add("fade-in");
      }, 500);
    }, 2500);
  } else {
    loadingAnimation.classList.remove("active");

    if (loadingInterval) {
      clearInterval(loadingInterval);
      loadingInterval = null;
    }

    loadingText.textContent = LOADING_MESSAGES[0];
    loadingText.classList.remove("fade-out", "fade-in");
  }
}

/**
 * Updates the status message text and tone.
 * @param {HTMLElement | null} statusMessage
 * @param {string} message
 * @param {string} tone - "info" | "error" | "success"
 */
export function updateStatus(statusMessage, message, tone = "info") {
  if (!statusMessage) return;
  statusMessage.textContent = message;
  statusMessage.dataset.tone = tone;
}

/**
 * Builds the contrast view structure from refutation API response.
 * Maps refutations to articles and produces contrast rows with article indices.
 * @param {{ refutations: Array<{ articleTitle: string, issue?: string, correction?: string }> }} refutation
 * @param {Array<{ title: string, snippet?: string }>} articles
 * @returns {{ contrastRows: Array<{ belief: string, expert: string, articleIndex: number }> }}
 */
export function buildRefutationView(refutation, articles) {
  const articleIndex = new Map(
    articles
      .map((article) => [sanitizeText(article.title).toLowerCase(), article])
      .filter(([key]) => Boolean(key))
  );

  const contrastRows = refutation.refutations.map((item) => {
    const key = (item.articleTitle || "").toLowerCase();
    const article = articleIndex.get(key);
    const beliefParts = [];
    if (article?.title) beliefParts.push(article.title);
    else if (item.articleTitle) beliefParts.push(item.articleTitle);
    if (article?.snippet) beliefParts.push(article.snippet);

    const beliefText = beliefParts.join(" — ") || "Bias Bot claim";
    const expertParts = [];
    if (item.issue) expertParts.push(`Issue: ${item.issue}.`);
    if (item.correction) expertParts.push(item.correction);
    const expertText = expertParts.join(" ").trim() || "Experts flag missing context.";

    const articleTitles = Array.from(articleIndex.keys());
    const matchingIndex = articleTitles.indexOf(key);

    return {
      belief: beliefText,
      expert: expertText,
      articleIndex: matchingIndex >= 0 ? matchingIndex : -1
    };
  });

  return { contrastRows };
}
