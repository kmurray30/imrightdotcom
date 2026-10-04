/**
 * Workshop orchestration: resume the real pipeline from Conspirator (1),
 * Tabloid Generator (5), or Counterarguer (7) — the only LLM stages — reusing
 * an existing article's earlier-stage data unchanged, with a possibly
 * different provider/model/system-prompt for whichever stages re-run.
 *
 * Deliberately a separate function from imright/index.js's runPipeline(),
 * not a refactor of it — runPipeline is the live, production idea-submission
 * path and must never be put at risk by this admin-only experimentation
 * tool. This module never touches disk: every stage function is called with
 * no slug, and onRawCapture (the small additive hook added to
 * generateAngles/generateArticle/generateCounterarguments) is used instead
 * to get the same raw input/output data those functions would otherwise
 * only write to disk-cache files.
 */

import { generateAngles } from '../../../conspirator/index.js';
import { fetchWiki } from '../../../wiki_searcher/index.js';
import { filterWiki } from '../../../wiki_filterer/index.js';
import { extract } from '../../../ref_extractor/index.js';
import { generateArticle } from '../../../tabloid_generator/index.js';
import { generateCounterarguments } from '../../../counterarguer/index.js';
import { parseJsonFromLlmResponse } from '../../../utils/parse-json.js';
import { getTokenUsage, resetTokenUsage, computeCost } from '../../../utils/grok.js';
import * as Workshop from '../workshop.js';

/** Runs one freshly-executed stage, tracking its own token usage/cost
 * regardless of what else (reused stages, other freshly-run stages) is
 * happening in the same overall run — resetTokenUsage()/getTokenUsage() are
 * process-wide, so this must bracket exactly one stage's calls at a time. */
async function trackStage(stage, name, model, fn) {
  resetTokenUsage();
  const start = performance.now();
  const result = await fn();
  const usage = getTokenUsage();
  const costs = computeCost(usage, model);
  const stageRow = {
    stage,
    name,
    model: model ?? null,
    reused: false,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cost: costs.totalCost,
    timeMs: performance.now() - start,
  };
  return { result, stageRow };
}

function reusedStageRow(stage, name) {
  return { stage, name, model: null, reused: true, inputTokens: 0, outputTokens: 0, cost: 0, timeMs: 0 };
}

/** Stages 2/3/4 (wiki search/filter/extract) are deterministic — no model,
 * no cost, but still freshly executed (not reused) whenever startStage=1. */
function deterministicStageRow(stage, name) {
  return { stage, name, model: null, reused: false, inputTokens: 0, outputTokens: 0, cost: 0, timeMs: 0 };
}

/**
 * @param {string} runId - The workshop_runs row id, for status updates.
 * @param {object} params
 * @param {string} params.claimText
 * @param {1|5|7} params.startStage
 * @param {object|null} params.sourceDebugData - pipelineDebug.debugData for
 *   the source article, or null for a from-scratch stage-1 run.
 * @param {object} params.stageConfig - { "1"?: {provider,model,systemPrompt}, "5"?: {...}, "7"?: {...} }
 */
export async function runWorkshopPipeline(runId, { claimText, startStage, sourceDebugData, stageConfig }) {
  try {
    const stageRows = [];

    let conspiracy, wikisFetched, wikisFiltered, extracted, linkStats;
    let conspiratorRawInput = null, conspiratorRawOutput = null;
    let tabloidRawInput = null, tabloidRawOutput = null;
    let counterarguerRawInput = null, counterarguerRawOutput = null;

    if (startStage === 1) {
      const cfg = stageConfig['1'] ?? {};
      const { result, stageRow } = await trackStage(1, 'Conspirator', cfg.model, () =>
        generateAngles(claimText, {
          model: cfg.model,
          systemPrompt: cfg.systemPrompt,
          onRawCapture: ({ rawInput, rawOutput }) => {
            conspiratorRawInput = rawInput;
            conspiratorRawOutput = rawOutput;
          },
        })
      );
      conspiracy = result;
      stageRows.push(stageRow);

      wikisFetched = await fetchWiki(conspiracy);
      stageRows.push(deterministicStageRow(2, 'Wiki searcher'));

      wikisFiltered = await filterWiki(conspiracy, wikisFetched);
      stageRows.push(deterministicStageRow(3, 'Wiki filterer'));

      const extractResult = await extract(conspiracy, wikisFiltered);
      extracted = extractResult.extracted;
      linkStats = extractResult.stats?.linkStats ?? null;
      stageRows.push(deterministicStageRow(4, 'Ref extractor'));
    } else {
      if (!sourceDebugData) {
        throw new Error(`startStage ${startStage} requires sourceDebugData`);
      }
      conspiracy = sourceDebugData.conspiracy;
      wikisFetched = sourceDebugData.wikisFetched;
      wikisFiltered = sourceDebugData.wikisFiltered;
      extracted = sourceDebugData.extracted;
      linkStats = sourceDebugData.linkStats ?? null;
      conspiratorRawInput = sourceDebugData.conspiratorRawInput ?? null;
      conspiratorRawOutput = sourceDebugData.conspiratorRawOutput ?? null;
      stageRows.push(reusedStageRow(1, 'Conspirator'));
      stageRows.push(reusedStageRow(2, 'Wiki searcher'));
      stageRows.push(reusedStageRow(3, 'Wiki filterer'));
      stageRows.push(reusedStageRow(4, 'Ref extractor'));
    }

    let articleResult;
    if (startStage <= 5) {
      const cfg = stageConfig['5'] ?? {};
      const { result, stageRow } = await trackStage(5, 'Tabloid generator', cfg.model, () =>
        generateArticle(claimText, extracted, null, {
          model: cfg.model,
          systemPrompt: cfg.systemPrompt,
          onRawCapture: ({ rawInput, rawOutput }) => {
            tabloidRawInput = rawInput;
            tabloidRawOutput = rawOutput;
          },
        })
      );
      articleResult = result;
      stageRows.push(stageRow);
    } else {
      if (!sourceDebugData?.tabloidRawOutput) {
        throw new Error('startStage 7 requires sourceDebugData.tabloidRawOutput');
      }
      tabloidRawInput = sourceDebugData.tabloidRawInput ?? null;
      tabloidRawOutput = sourceDebugData.tabloidRawOutput;
      const parsed = parseJsonFromLlmResponse(tabloidRawOutput);
      articleResult = { article: parsed.article ?? parsed, topic: claimText };
      stageRows.push(reusedStageRow(5, 'Tabloid generator'));
    }

    const cfg7 = stageConfig['7'] ?? {};
    const sections = articleResult.article?.sections ?? [];
    if (sections.length > 0) {
      const { stageRow } = await trackStage(7, 'Counterarguer', cfg7.model, () =>
        generateCounterarguments(articleResult.article, articleResult.topic ?? claimText, null, {
          model: cfg7.model,
          systemPrompt: cfg7.systemPrompt,
          onRawCapture: ({ rawInput, rawOutput }) => {
            counterarguerRawInput = rawInput;
            counterarguerRawOutput = rawOutput;
          },
        })
      );
      stageRows.push(stageRow);
    }

    const resultData = {
      slug: `workshop-${runId}`,
      conspiracy,
      wikisFetched,
      wikisFiltered,
      extracted,
      runStats: { stages: stageRows },
      linkStats,
      conspiratorRawInput,
      conspiratorRawOutput,
      tabloidRawInput,
      tabloidRawOutput,
      counterarguerRawInput,
      counterarguerRawOutput,
    };

    await Workshop.completeRun(runId, resultData);
    await rememberWorkingModels(stageConfig, startStage);
  } catch (error) {
    await Workshop.failRun(runId, error.message).catch(() => {});
  }
}

/** A model that completed its stage without throwing gets remembered for
 * next time — soft signal for stage 7 specifically, since its per-section
 * loop swallows individual failures rather than throwing (see
 * counterarguer/index.js). Not called for a stage that threw (the whole
 * run already failed by then, per runWorkshopPipeline's try/catch above). */
async function rememberWorkingModels(stageConfig, startStage) {
  const stagesRun = [1, 5, 7].filter((s) => s >= startStage);
  for (const stage of stagesRun) {
    const cfg = stageConfig[String(stage)];
    if (cfg?.provider && cfg?.model) {
      await Workshop.rememberKnownModel(cfg.provider, cfg.model).catch(() => {});
    }
  }
}
