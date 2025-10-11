const beliefForm = document.getElementById("beliefForm");
const beliefInput = document.getElementById("beliefInput");
const articleList = document.getElementById("articleList");
const expertGrid = document.getElementById("expertGrid");
const contrastView = document.getElementById("contrastView");
const statusMessage = document.getElementById("statusMessage");
const submitButton = beliefForm.querySelector("button");
const loadingAnimation = document.getElementById("loadingAnimation");
const loadingText = document.getElementById("loadingText");
const pageElement = document.querySelector(".page");
const leftPanel = document.getElementById("leftPanel");
const rightPanel = document.getElementById("rightPanel");
const brandLogo = document.getElementById("brandLogo");

const LOADING_MESSAGES = [
  "Cherry-picking evidence...",
  "Exposing the conspiracy...",
  "Saying what everyone is thinking...",
  "Ignoring context...",
  "Finding the perfect headline...",
  "Confirming your suspicions...",
  "Filtering out dissent..."
];

let loadingInterval = null;

const DEFAULT_BUTTON_TEXT = "Prove me right";
const SYSTEM_PROMPT = `
You are \"Bias Bot\", an over-confident content engine that cherry-picks sources to confirm the user's belief.
Generate sensational, tabloid-style headlines, each paired with a questionable news outlet and a fake but plausible URL.
Headlines must reference believable recent events (within the last five years) and include concrete details like locations, statistics, dates, or named figures.
Every summary must exaggerate why the article confirms the belief while weaving in at least one specific data point, quote, or study to feel realistic.
Return strictly valid JSON matching this schema:
{
  "articles": [
    {
      "title": "all caps sensational headline",
      "source": "tabloid-style outlet name",
      "url": "https://fake-domain.com/...",
      "summary": "two to three sentences of cherry-picked hype"
    }
  ]
}
Produce 3-5 articles.
`;

const REFUTATION_PROMPT = `
You are \"Reality Check\", a rigorous fact-finding analyst who counters biased narratives.
Return strictly valid JSON matching this schema:
{
  "summary": "Brief synthesis of nuanced expert analysis responding to the Bias Bot output.",
  "expert_examples": [
    {
      "name": "Expert or institution name",
      "title": "Role, affiliation, or report title",
      "insight": "Specific evidence-based example that addresses the belief",
      "confidence": "Confidence level or strength of evidence (optional)"
    }
  ],
  "refutations": [
    {
      "article_title": "Headline or claim being addressed",
      "issue": "What Bias Bot got wrong (fallacy, cherry-pick, missing context)",
      "correction": "Evidence-backed correction with clear rationale"
    }
  ]
}
Keep the tone constructive, cite credible sources or data where possible, and ensure every Bias Bot article is addressed if feasible.
`;

const templateData = {
  "Electric vehicles are destroying the grid": {
    articles: [
      {
        title: "Rolling Blackouts Loom as EV Demand Surges",
        source: "Grid Watch Daily",
        url: "https://gridwatch.example/ev-blackouts",
        snippet:
          "Power utilities are bracing for unprecedented demand spikes as electric vehicles strain already fragile infrastructure.",
        confirmation: "Supports belief"
      },
      {
        title: "Rural Towns Fight EV Charging Stations",
        source: "Heartland Dispatch",
        url: "https://heartlanddispatch.example/rural-grid-fight",
        snippet:
          "Local leaders argue that new charging installs will destabilize voltage in legacy systems built for light loads.",
        confirmation: "Supports belief"
      },
      {
        title: "Analyst: EV Adoption 'An Energy Nightmare'",
        source: "MacroPulse TV",
        url: "https://macropulse.example/energy-nightmare",
        snippet:
          "Senior analysts warn policymakers that electrification is accelerating faster than capacity upgrades.",
        confirmation: "Supports belief"
      }
    ],
    experts: [
      {
        name: "Dr. Priya Nandakumar",
        title: "Lead Systems Engineer, National Grid Lab",
        confidence: "High confidence",
        summary:
          "Grid capacity is keeping pace in most regions; demand spikes are mitigated by off-peak charging and smart load balancing."
      },
      {
        name: "Miguel Santos",
        title: "Director of Energy Analytics, EVChargeNet",
        confidence: "Medium confidence",
        summary:
          "Localized stress exists, but modernization funds and distributed storage are stabilizing the load profile."
      },
      {
        name: "US Dept. of Energy",
        title: "2025 Infrastructure Report",
        confidence: "High confidence",
        summary:
          "Federal review finds that EV adoption will remain under 12% of total grid demand through 2030 with planned upgrades."
      }
    ],
    contrasts: [
      {
        belief: "EVs push the grid past the breaking point.",
        expert: "Experts see manageable demand with smart charging and infrastructure investments."
      },
      {
        belief: "Charging stations destabilize rural voltage.",
        expert: "Utilities phase installs to strengthen rural feeders before high-capacity chargers go live."
      },
      {
        belief: "Policy ignores the looming energy crisis.",
        expert: "Policy includes $26B in grid resilience and demand response programs rolling out through 2028."
      }
    ]
  }
};

const fallbackData = {
  articles: Array.from({ length: 3 }, (_, i) => ({
    title: `Article placeholder #${i + 1}`,
    source: "Bias Engine",
    url: "#",
    snippet: "Submit a belief above to see your curated confirmation headlines.",
    confirmation: "Awaiting belief"
  })),
  experts: [
    {
      name: "Expert analysis will appear here",
      title: "Cross-check multiple credible sources to challenge your narrative",
      confidence: "Pending",
      summary:
        "Enter a belief to compare it with measured data, peer-reviewed research, and aggregated expert insight."
    }
  ],
  contrasts: [
    {
      belief: "Your belief will be juxtaposed here.",
      expert: "We will distill opposing evidence so the tension is visible."
    }
  ]
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function sanitizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeUrl(url) {
  if (!url) return "#";
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
    return "#";
  } catch (error) {
    return "#";
  }
}

function renderArticles(articles) {
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

  // Add click handlers to article cards
  attachArticleClickHandlers();
}

function renderExperts(experts) {
  expertGrid.innerHTML = experts
    .map(
      (expert) => `
        <article class="expert-card">
          <div class="expert-card__meta">
            <div>
              <strong>${escapeHtml(expert.name)}</strong>
              <div>${escapeHtml(expert.title)}</div>
            </div>
            <span class="expert-card__confidence">${escapeHtml(expert.confidence)}</span>
          </div>
          <p class="expert-card__summary">${escapeHtml(expert.summary)}</p>
        </article>
      `
    )
    .join("");
}

function renderContrasts(contrasts) {
  contrastView.innerHTML = contrasts
    .map(
      (contrast) => {
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
      }
    )
    .join("");
}

function setLoadingState(isLoading) {
  submitButton.disabled = isLoading;
  beliefInput.disabled = isLoading;
  submitButton.textContent = isLoading ? "Cherry-picking…" : DEFAULT_BUTTON_TEXT;
  beliefForm.classList.toggle("belief-form--loading", isLoading);

  if (isLoading) {
    loadingAnimation.classList.add("active");

    // Start cycling through loading messages with fade animation
    let messageIndex = 0;
    loadingText.textContent = LOADING_MESSAGES[messageIndex];
    loadingText.classList.remove("fade-out");
    loadingText.classList.add("fade-in");

    loadingInterval = setInterval(() => {
      // Fade out current message
      loadingText.classList.remove("fade-in");
      loadingText.classList.add("fade-out");

      // After fade out completes, change text and fade in
      setTimeout(() => {
        messageIndex = (messageIndex + 1) % LOADING_MESSAGES.length;
        loadingText.textContent = LOADING_MESSAGES[messageIndex];
        loadingText.classList.remove("fade-out");
        loadingText.classList.add("fade-in");
      }, 500); // Wait for fade out animation (0.5s)
    }, 2500); // Change message every 2.5 seconds (2s display + 0.5s transition)
  } else {
    loadingAnimation.classList.remove("active");

    // Stop cycling and clear interval
    if (loadingInterval) {
      clearInterval(loadingInterval);
      loadingInterval = null;
    }

    // Reset to first message and remove animation classes
    loadingText.textContent = LOADING_MESSAGES[0];
    loadingText.classList.remove("fade-out", "fade-in");
  }
}

function updateStatus(message, tone = "info") {
  if (!statusMessage) return;
  statusMessage.textContent = message;
  statusMessage.dataset.tone = tone;
}

function resolveApiKey() {
  if (typeof window !== "undefined" && window.ENV?.OPENAI_API_KEY) {
    return window.ENV.OPENAI_API_KEY.trim();
  }
  if (typeof process !== "undefined" && process.env?.OPENAI_API_KEY) {
    return String(process.env.OPENAI_API_KEY).trim();
  }
  return "";
}

async function fetchBiasBotArticles(belief) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      "Missing OpenAI API key. Add OPENAI_API_KEY to your environment or inject window.ENV.OPENAI_API_KEY."
    );
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.9,
      messages: [
        { role: "system", content: SYSTEM_PROMPT.trim() },
        {
          role: "user",
          content: `Belief: "${belief}". Provide only the JSON object defined in the schema.`
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bias Bot request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Bias Bot returned an empty response.");
  }

  return parseArticles(content);
}

function parseArticles(content) {
  let payload;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    console.warn("Bias Bot JSON parse failed, attempting fallback extraction.", error);
    const match = content.match(/\{[\\s\\S]*\}/);
    if (!match) throw new Error("Unable to parse Bias Bot response.");
    payload = JSON.parse(match[0]);
  }

  if (!payload || !Array.isArray(payload.articles)) {
    throw new Error("Bias Bot response missing 'articles' array.");
  }

  return payload.articles.slice(0, 5).map((item) => ({
    title: item.title ?? "Untitled cherry-picked headline",
    source: item.source ?? "Echo Chamber Gazette",
    url: item.url ?? "#",
    snippet: item.summary ?? "Cherry-picked summary unavailable.",
    confirmation: "Supports belief"
  }));
}

async function fetchRefutation(belief, articles) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      "Missing OpenAI API key. Add OPENAI_API_KEY to your environment or inject window.ENV.OPENAI_API_KEY."
    );
  }

  const structuredBiasOutput = {
    belief: sanitizeText(belief),
    articles: articles.map((article) => ({
      title: sanitizeText(article.title),
      source: sanitizeText(article.source),
      summary: sanitizeText(article.snippet),
      url: sanitizeText(article.url)
    }))
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.7,
      messages: [
        { role: "system", content: REFUTATION_PROMPT.trim() },
        {
          role: "user",
          content: [
            `Belief: "${sanitizeText(belief)}"`,
            "Bias Bot Output:",
            JSON.stringify(structuredBiasOutput, null, 2)
          ].join("\n")
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Reality Check request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Reality Check returned an empty response.");
  }

  return parseRefutation(content);
}

function parseRefutation(content) {
  let payload;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    console.warn("Reality Check JSON parse failed, attempting fallback extraction.", error);
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Unable to parse Reality Check response.");
    payload = JSON.parse(match[0]);
  }

  const summary = sanitizeText(payload?.summary);

  const expertExamples = Array.isArray(payload?.expert_examples)
    ? payload.expert_examples
        .map((item) => ({
          name: sanitizeText(item?.name),
          title: sanitizeText(item?.title),
          insight: sanitizeText(item?.insight),
          confidence: sanitizeText(item?.confidence)
        }))
        .filter((item) => item.insight)
    : [];

  const refutations = Array.isArray(payload?.refutations)
    ? payload.refutations
        .map((item) => ({
          articleTitle: sanitizeText(item?.article_title),
          issue: sanitizeText(item?.issue),
          correction: sanitizeText(item?.correction)
        }))
        .filter((item) => item.articleTitle || item.correction)
    : [];

  return { summary, expertExamples, refutations };
}

function buildRefutationView(refutation, articles) {
  const expertCards = [];
  if (refutation.summary) {
    expertCards.push({
      name: "Expert Consensus",
      title: "Synthesis of credible analysis",
      confidence: "High confidence",
      summary: refutation.summary
    });
  }

  refutation.expertExamples.forEach((example) => {
    expertCards.push({
      name: example.name || "Expert insight",
      title: example.title || "Independent analysis",
      confidence: example.confidence || "Evidence-backed",
      summary: example.insight
    });
  });

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

    // Find the article index for this refutation
    const articleTitles = Array.from(articleIndex.keys());
    const matchingIndex = articleTitles.indexOf(key);

    return {
      belief: beliefText,
      expert: expertText,
      articleIndex: matchingIndex >= 0 ? matchingIndex : -1
    };
  });

  return {
    expertCards,
    contrastRows
  };
}

function generateMockData(belief) {
  if (!belief) return fallbackData;

  const articleBelief = belief.length > 80 ? `${belief.slice(0, 77)}…` : belief;
  return {
    articles: [
      {
        title: `Analyst assures: "${articleBelief}"`,
        source: "Confirmation Chronicle",
        url: "https://confirmation.example/assures",
        snippet:
          "Our curated sources highlight voices reinforcing your belief and downplay counter-evidence.",
        confirmation: "Supports belief"
      },
      {
        title: `Opinion: Why ${articleBelief.toLowerCase()} is obviously true`,
        source: "Echo Chamber Weekly",
        url: "https://echochamber.example/opinion",
        snippet: "Hand-selected quotes and anecdotes that align perfectly with your worldview.",
        confirmation: "Supports belief"
      },
      {
        title: `${articleBelief}? Experts say yes (if you only ask the right ones)`,
        source: "CherryPick Newswire",
        url: "https://cherrypick.example/experts-say-yes",
        snippet:
          "We scoured the web to find the three people who agree with you. You're welcome.",
        confirmation: "Supports belief"
      }
    ],
    experts: [
      {
        name: "Neutral Observatory",
        title: "Cross-examined evidence set",
        confidence: "Medium confidence",
        summary: `Independent review finds limited support for "${belief}", highlighting mixed data and unresolved variables.`
      },
      {
        name: "FactCheck Syndicate",
        title: "Bias-adjusted dataset",
        confidence: "High confidence",
        summary:
          "Meta-analysis contrasts outlier quotes with broader consensus to reveal nuance often lost in echo chambers."
      },
      {
        name: "Academic Consensus Panel",
        title: "Peer-reviewed outlook",
        confidence: "High confidence",
        summary:
          "Majority of cited studies provide alternative explanations, encouraging caution before embracing the claim."
      }
    ],
    contrasts: [
      {
        belief: `Belief: ${belief}`,
        expert: "Expert consensus stresses situational nuance and recommends looking at longitudinal data."
      },
      {
        belief: "Supporting evidence often anecdotal and selectively framed.",
        expert: "Broader datasets include counter-trends that weaken the original claim's certainty."
      },
      {
        belief: "Opposing data must be part of a conspiracy.",
        expert:
          "Individual study limitations rarely imply coordinated suppression; replication keeps research honest."
      }
    ]
  };
}

async function loadBelief(belief) {
  const trimmedBelief = belief.trim();
  const staticData = templateData[trimmedBelief] ?? generateMockData(trimmedBelief);
  setLoadingState(true);

  if (!trimmedBelief) {
    renderArticles(staticData.articles);
    renderExperts(staticData.experts);
    renderContrasts(staticData.contrasts);
    updateStatus("Share a belief to let Bias Bot cherry-pick headlines for you.");
    setLoadingState(false);
    return;
  }

  updateStatus("Bias Bot is cherry-picking the juiciest supporting headlines…");

  try {
    const articles = await fetchBiasBotArticles(trimmedBelief);
    renderArticles(articles);

    let refutationView = null;
    let refutationFailed = false;

    try {
      const refutation = await fetchRefutation(trimmedBelief, articles);
      refutationView = buildRefutationView(refutation, articles);
    } catch (refutationError) {
      console.error(refutationError);
      refutationFailed = true;
    }

    const expertsToRender =
      refutationView?.expertCards?.length ? refutationView.expertCards : staticData.experts;
    const contrastsToRender =
      refutationView?.contrastRows?.length ? refutationView.contrastRows : staticData.contrasts;

    renderExperts(expertsToRender);
    renderContrasts(contrastsToRender);

    // Transition from intro to results view after content is ready
    if (document.body.classList.contains("intro")) {
      document.body.classList.remove("intro");
    }

    if (
      !refutationFailed &&
      refutationView?.expertCards?.length &&
      refutationView?.contrastRows?.length
    ) {
      updateStatus(
        `Bias Bot surfaced ${articles.length} supportive headlines — Reality Check countered with expert evidence.`,
        "success"
      );
    } else if (refutationFailed) {
      updateStatus(
        `Bias Bot surfaced ${articles.length} supportive headlines, but expert refutation fell back to mock data.`,
        "info"
      );
    } else {
      updateStatus(
        `Bias Bot surfaced ${articles.length} supportive headlines. Supplemented with available expert insight.`,
        "info"
      );
    }
  } catch (error) {
    console.error(error);
    renderArticles(staticData.articles);
    renderExperts(staticData.experts);
    renderContrasts(staticData.contrasts);

    // Transition even on error so user can see the mock data
    if (document.body.classList.contains("intro")) {
      document.body.classList.remove("intro");
    }

    updateStatus(
      "Bias Bot had trouble reaching the API. Showing in-browser mock data instead.",
      "error"
    );
  } finally {
    setLoadingState(false);
  }
}

function attachArticleClickHandlers() {
  const articleCards = articleList.querySelectorAll(".article-card");

  articleCards.forEach((card) => {
    card.style.cursor = "pointer";
    card.addEventListener("click", (event) => {
      const articleIndex = parseInt(card.dataset.articleIndex, 10);
      if (isNaN(articleIndex)) return;

      // Find corresponding contrast row
      const contrastRow = contrastView.querySelector(`[data-article-index="${articleIndex}"]`);

      if (contrastRow) {
        // Switch focus to the right panel
        pageElement.classList.add("focus-right");
        pageElement.classList.remove("focus-none");

        // Remove previous highlights
        document.querySelectorAll(".contrast__row--highlighted").forEach((el) => {
          el.classList.remove("contrast__row--highlighted");
        });

        // Add highlight to the matching row
        contrastRow.classList.add("contrast__row--highlighted");

        // Small delay to allow focus transition to complete
        setTimeout(() => {
          // Scroll to the contrast row smoothly within its container
          const panelBody = contrastRow.closest(".panel__body--scroll");

          if (panelBody) {
            // Use offsetTop for more reliable positioning
            const contrastWrapper = contrastRow.closest(".contrast-wrapper");
            const contrastContainer = contrastRow.closest(".contrast");

            // Get the offsetTop relative to the scrollable container
            let elementOffsetTop = 0;
            let element = contrastRow;

            // Calculate cumulative offset from the panelBody
            while (element && element !== panelBody) {
              elementOffsetTop += element.offsetTop;
              element = element.offsetParent;

              // Break if we've reached the panelBody or gone outside it
              if (element === panelBody || !panelBody.contains(element)) {
                break;
              }
            }

            // Calculate scroll position with comfortable padding from the top
            const padding = 80; // pixels from top for comfortable viewing
            const scrollPosition = elementOffsetTop - padding;

            panelBody.scrollTo({
              top: Math.max(0, scrollPosition), // Don't scroll to negative values
              behavior: "smooth"
            });
          } else {
            // Fallback if scroll container not found
            contrastRow.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }, 400); // Increased delay to ensure panel transition completes

        // Remove highlight after 3 seconds
        setTimeout(() => {
          contrastRow.classList.remove("contrast__row--highlighted");
        }, 3000);
      }
    });
  });
}

beliefForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const belief = beliefInput.value;
  await loadBelief(belief);
});

// Panel click to focus functionality
leftPanel.addEventListener("click", (event) => {
  // Don't change focus if clicking on an article card (handled separately)
  if (event.target.closest(".article-card")) {
    return;
  }

  const isCurrentlyFocused = !pageElement.classList.contains("focus-right") &&
                             !pageElement.classList.contains("focus-none");

  if (isCurrentlyFocused) {
    // Already focused, do nothing or unfocus to equal split
    pageElement.classList.add("focus-none");
  } else {
    // Focus left
    pageElement.classList.remove("focus-none");
    pageElement.classList.remove("focus-right");
  }
});

rightPanel.addEventListener("click", (event) => {
  const isCurrentlyFocused = pageElement.classList.contains("focus-right");

  if (isCurrentlyFocused) {
    // Already focused, unfocus to equal split
    pageElement.classList.add("focus-none");
    pageElement.classList.remove("focus-right");
  } else {
    // Focus right
    pageElement.classList.add("focus-right");
    pageElement.classList.remove("focus-none");
  }
});

// Brand logo click handler - return to landing page
brandLogo.addEventListener("click", () => {
  // Clear the input
  beliefInput.value = "";

  // Reset to intro state
  document.body.classList.add("intro");

  // Clear any loading state
  setLoadingState(false);

  // Reset status message
  updateStatus("Share a belief to let Bias Bot cherry-pick headlines for you.");

  // Load empty state
  loadBelief("");
});

// Handle keyboard accessibility for brand logo
brandLogo.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    brandLogo.click();
  }
});

loadBelief("");
