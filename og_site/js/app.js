/**
 * Entry point for echocheck / imright.io.
 * DOM refs, main flow (loadBelief), event handlers, and init.
 */

import { templateData, fallbackData, generateMockData } from "./data.js";
import { fetchBiasBotArticles, fetchRefutation } from "./api.js";
import {
  renderArticles,
  renderContrasts,
  setLoadingState,
  updateStatus,
  setInfoBlurbOpen,
  buildRefutationView
} from "./ui.js";

// --- DOM references ---
const beliefForm = document.getElementById("beliefForm");
const beliefInput = document.getElementById("beliefInput");
const articleList = document.getElementById("articleList");
const contrastView = document.getElementById("contrastView");
const statusMessage = document.getElementById("statusMessage");
const submitButton = beliefForm?.querySelector("button");
const loadingAnimation = document.getElementById("loadingAnimation");
const loadingText = document.getElementById("loadingText");
const pageElement = document.querySelector(".page");
const leftPanel = document.getElementById("leftPanel");
const rightPanel = document.getElementById("rightPanel");
const brandLogo = document.getElementById("brandLogo");
const infoToggle = document.getElementById("infoToggle");
const infoBlurb = document.getElementById("infoBlurb");

const loadingDomRefs = {
  beliefForm,
  beliefInput,
  submitButton,
  loadingAnimation,
  loadingText
};

// --- Article click handlers ---
// Attaches click handlers to article cards so clicking one scrolls to and highlights the matching contrast row
function attachArticleClickHandlers() {
  if (!articleList || !contrastView || !pageElement) return;

  const articleCards = articleList.querySelectorAll(".article-card");

  articleCards.forEach((card) => {
    card.style.cursor = "pointer";
    card.addEventListener("click", () => {
      const articleIndex = parseInt(card.dataset.articleIndex, 10);
      if (isNaN(articleIndex)) return;

      const contrastRow = contrastView.querySelector(`[data-article-index="${articleIndex}"]`);

      if (contrastRow) {
        pageElement.classList.add("focus-right");
        pageElement.classList.remove("focus-none");

        document.querySelectorAll(".contrast__row--highlighted").forEach((el) => {
          el.classList.remove("contrast__row--highlighted");
        });
        contrastRow.classList.add("contrast__row--highlighted");

        setTimeout(() => {
          const panelBody = contrastRow.closest(".panel__body--scroll");
          if (panelBody) {
            let elementOffsetTop = 0;
            let element = contrastRow;
            while (element && element !== panelBody) {
              elementOffsetTop += element.offsetTop;
              element = element.offsetParent;
              if (element === panelBody || !panelBody.contains(element)) break;
            }
            const padding = 80;
            const scrollPosition = elementOffsetTop - padding;
            panelBody.scrollTo({ top: Math.max(0, scrollPosition), behavior: "smooth" });
          } else {
            contrastRow.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }, 400);

        setTimeout(() => contrastRow.classList.remove("contrast__row--highlighted"), 3000);
      }
    });
  });
}

// --- Main flow ---
async function loadBelief(belief) {
  const trimmedBelief = belief.trim();
  console.log(`[BiasBot] loadBelief invoked with: "${trimmedBelief}"`);
  const staticData = templateData[trimmedBelief] ?? generateMockData(trimmedBelief);
  setLoadingState(true, loadingDomRefs);

  if (!trimmedBelief) {
    console.log("[BiasBot] No belief provided. Rendering default mock data.");
    renderArticles(articleList, staticData.articles, () => attachArticleClickHandlers());
    renderContrasts(staticData.contrasts, contrastView);
    updateStatus(statusMessage, "Find all the REAL TRUTH that you already know!");
    setLoadingState(false, loadingDomRefs);
    return;
  }

  updateStatus(statusMessage, "TRUTH Bot is uncovering all of the correct headlines.");

  try {
    const articles = await fetchBiasBotArticles(trimmedBelief);
    renderArticles(articleList, articles, () => attachArticleClickHandlers());
    console.log(`[BiasBot] Stage 3: Rendered ${articles.length} biased headline(s) to the left panel.`);

    let refutationView = null;
    let refutationFailed = false;

    try {
      const refutation = await fetchRefutation(trimmedBelief, articles);
      refutationView = buildRefutationView(refutation, articles);
    } catch (refutationError) {
      console.error(refutationError);
      refutationFailed = true;
    }

    const contrastsToRender =
      refutationView?.contrastRows?.length ? refutationView.contrastRows : staticData.contrasts;
    renderContrasts(contrastsToRender, contrastView);

    if (document.body.classList.contains("intro")) {
      document.body.classList.remove("intro");
      setInfoBlurbOpen(infoBlurb, infoToggle, false);
    }

    if (!refutationFailed && refutationView?.contrastRows?.length) {
      updateStatus(statusMessage, ".", "success");
    } else if (refutationFailed) {
      updateStatus(
        statusMessage,
        `Bias Bot surfaced ${articles.length} supportive headlines, but expert refutation fell back to mock data.`,
        "info"
      );
    } else {
      updateStatus(
        statusMessage,
        `Bias Bot surfaced ${articles.length} supportive headlines. Supplemented with available contrast insight.`,
        "info"
      );
    }
  } catch (error) {
    console.error("[BiasBot] Error while loading belief. Falling back to mock data.", error);
    renderArticles(articleList, staticData.articles, () => attachArticleClickHandlers());
    renderContrasts(staticData.contrasts, contrastView);

    if (document.body.classList.contains("intro")) {
      document.body.classList.remove("intro");
      setInfoBlurbOpen(infoBlurb, infoToggle, false);
    }

    updateStatus(
      statusMessage,
      "Bias Bot had trouble reaching the API. Showing in-browser mock data instead.",
      "error"
    );
  } finally {
    setLoadingState(false, loadingDomRefs);
    console.log("[BiasBot] loadBelief complete.");
  }
}

// --- Event listeners ---

// Form submit
beliefForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadBelief(beliefInput?.value ?? "");
});

// Info toggle (show/hide info blurb)
if (infoToggle && infoBlurb) {
  setInfoBlurbOpen(infoBlurb, infoToggle, false);
  infoToggle.addEventListener("click", () => {
    const willOpen = !infoBlurb.classList.contains("info-blurb--open");
    setInfoBlurbOpen(infoBlurb, infoToggle, willOpen);
    if (willOpen && document.body.classList.contains("intro")) {
      infoBlurb.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

// Panel click to focus (left/right)
if (leftPanel && pageElement) {
  leftPanel.addEventListener("click", (event) => {
    if (event.target.closest(".article-card")) return;
    const isCurrentlyFocused =
      !pageElement.classList.contains("focus-right") &&
      !pageElement.classList.contains("focus-none");
    if (isCurrentlyFocused) {
      pageElement.classList.add("focus-none");
    } else {
      pageElement.classList.remove("focus-none");
      pageElement.classList.remove("focus-right");
    }
  });
}

if (rightPanel && pageElement) {
  rightPanel.addEventListener("click", () => {
    const isCurrentlyFocused = pageElement.classList.contains("focus-right");
    if (isCurrentlyFocused) {
      pageElement.classList.add("focus-none");
      pageElement.classList.remove("focus-right");
    } else {
      pageElement.classList.add("focus-right");
      pageElement.classList.remove("focus-none");
    }
  });
}

// Brand logo: return to landing
if (brandLogo) {
  brandLogo.addEventListener("click", () => {
    if (beliefInput) beliefInput.value = "";
    document.body.classList.add("intro");
    setInfoBlurbOpen(infoBlurb, infoToggle, false);
    setLoadingState(false, loadingDomRefs);
    updateStatus(statusMessage, "Find the truth you already know.");
    loadBelief("");
  });

  brandLogo.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      brandLogo.click();
    }
  });
}

// --- Init ---
loadBelief("");
