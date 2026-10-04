/**
 * Admin-only Workshop API: resume the pipeline from an existing article at
 * Conspirator/Tabloid Generator/Counterarguer with a different provider,
 * model, or system prompt, to compare against the original. Mounted at
 * /api/workshop in serve-site.js. Every route behind requireAdmin — see
 * that module's docstring for why a non-admin gets 404, not 403.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import { requireAdmin } from '../require-admin.js';
import { HttpError } from '../http-error.js';
import { buildHtml as buildDebugHtml } from '../generate-debug.js';
import * as Workshop from '../workshop.js';
import * as Articles from '../articles.js';
import { listProviders, getProviderAdapter } from '../workshop-pipeline/providers/index.js';
import { runWorkshopPipeline } from '../workshop-pipeline/run-workshop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

const STAGE_PROMPT_FILES = {
  1: path.join(PROJECT_ROOT, 'conspirator', 'system_prompt.txt'),
  5: path.join(PROJECT_ROOT, 'tabloid_generator', 'system_prompt.txt'),
  7: path.join(PROJECT_ROOT, 'counterarguer', 'system_prompt.txt'),
};
const START_STAGES = [1, 5, 7];

function readSystemPrompt(stage) {
  return fs.readFileSync(STAGE_PROMPT_FILES[stage], 'utf8').trim();
}

export const workshopRouter = Router();

workshopRouter.get('/defaults', requireAdmin, async (req, res, next) => {
  try {
    const sourceArticleId = typeof req.query.sourceArticleId === 'string' ? req.query.sourceArticleId : null;
    let hasDebugData = false;
    if (sourceArticleId) {
      const debugData = await Articles.getDebugDataForArticle(sourceArticleId);
      hasDebugData = Boolean(debugData);
    }

    const knownModels = {};
    for (const { id } of listProviders()) {
      knownModels[id] = await Workshop.getKnownModels(id);
    }

    res.json({
      providers: listProviders(),
      knownModels,
      systemPrompts: { 1: readSystemPrompt(1), 5: readSystemPrompt(5), 7: readSystemPrompt(7) },
      hasDebugData,
    });
  } catch (error) {
    next(error);
  }
});

workshopRouter.get('/runs', requireAdmin, async (req, res, next) => {
  try {
    res.json({ runs: await Workshop.listRuns() });
  } catch (error) {
    next(error);
  }
});

workshopRouter.get('/runs/:id', requireAdmin, async (req, res, next) => {
  try {
    const run = await Workshop.getRun(req.params.id);
    if (!run) throw new HttpError(404, 'run_not_found');
    // Status polling doesn't need the (potentially large) resultData blob —
    // just whether there is one yet.
    const { resultData, ...rest } = run;
    res.json({ run: { ...rest, hasResult: Boolean(resultData) } });
  } catch (error) {
    next(error);
  }
});

workshopRouter.get('/runs/:id/debug', requireAdmin, async (req, res, next) => {
  try {
    const resultData = await Workshop.getDebugDataForRun(req.params.id);
    if (!resultData) throw new HttpError(404, 'debug_data_not_found');
    res.type('html').send(buildDebugHtml(resultData));
  } catch (error) {
    next(error);
  }
});

workshopRouter.post('/runs', requireAdmin, async (req, res, next) => {
  try {
    const { sourceArticleId, claimText: claimTextInput, startStage, stageConfig } = req.body ?? {};

    if (!START_STAGES.includes(startStage)) {
      throw new HttpError(400, 'invalid_start_stage');
    }
    if (typeof stageConfig !== 'object' || stageConfig === null) {
      throw new HttpError(400, 'invalid_stage_config');
    }
    for (const stage of START_STAGES.filter((s) => s >= startStage)) {
      const cfg = stageConfig[String(stage)];
      if (!cfg?.provider || !cfg?.model) {
        throw new HttpError(400, `missing_stage_config_${stage}`);
      }
      try {
        getProviderAdapter(cfg.provider);
      } catch {
        throw new HttpError(400, 'unknown_provider');
      }
    }

    let sourceDebugData = null;
    let claimText = typeof claimTextInput === 'string' ? claimTextInput.trim() : '';
    if (sourceArticleId) {
      const sourceArticle = await Articles.getArticleById(sourceArticleId);
      if (!sourceArticle) throw new HttpError(404, 'source_article_not_found');
      if (!claimText) claimText = sourceArticle.claimText;
      if (startStage > 1) {
        sourceDebugData = await Articles.getDebugDataForArticle(sourceArticleId);
        if (!sourceDebugData) throw new HttpError(400, 'source_debug_missing');
      }
    }
    if (!claimText) throw new HttpError(400, 'missing_claim'); // from-scratch run with no sourceArticleId needs a typed claim

    const run = await Workshop.createRun({
      createdByUserId: req.user.id,
      sourceArticleId: sourceArticleId ?? null,
      claimText,
      startStage,
      stageConfig,
    });

    // Fire-and-forget: the HTTP response doesn't wait for the (potentially
    // minutes-long) pipeline run to finish — the frontend polls GET
    // /runs/:id for status instead.
    runWorkshopPipeline(run.id, { claimText, startStage, sourceDebugData, stageConfig }).catch((error) => {
      console.error('[workshop] run failed unexpectedly:', error?.message ?? error);
    });

    res.status(201).json({ run });
  } catch (error) {
    next(error);
  }
});
