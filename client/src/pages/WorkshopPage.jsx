import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

const START_STAGE_OPTIONS = [
  { value: 1, label: 'Conspirator', hint: 'Regenerate angles — everything downstream re-runs too.' },
  { value: 5, label: 'Tabloid Generator', hint: "Reuse the source article's citations; regenerate just the article text." },
  { value: 7, label: 'Counterarguer', hint: "Reuse the source article's finished text; regenerate just Bunky's rebuttals." },
];
const LLM_STAGES = [1, 5, 7];
const OTHER_MODEL = '__other__';

const emptyStageConfig = () => ({ provider: 'xai', model: '', customModel: '', systemPrompt: '' });

export function WorkshopPage() {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialSourceArticleId = searchParams.get('sourceArticleId') ?? '';

  const [sourceArticleId, setSourceArticleId] = useState(initialSourceArticleId);
  const [claimText, setClaimText] = useState('');
  const [startStage, setStartStage] = useState(initialSourceArticleId ? 5 : 1);
  const [defaults, setDefaults] = useState(null);
  const [stageConfigs, setStageConfigs] = useState({ 1: emptyStageConfig(), 5: emptyStageConfig(), 7: emptyStageConfig() });
  const [runs, setRuns] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user?.isAdmin) return undefined;
    let cancelled = false;
    const query = sourceArticleId ? `?sourceArticleId=${encodeURIComponent(sourceArticleId)}` : '';
    api
      .get(`/api/workshop/defaults${query}`)
      .then((data) => {
        if (cancelled) return;
        setDefaults(data);
        setStageConfigs((prev) => {
          const next = { ...prev };
          for (const stage of LLM_STAGES) {
            const known = data.knownModels?.xai ?? [];
            next[stage] = {
              ...next[stage],
              model: next[stage].model || known[0] || '',
              systemPrompt: next[stage].systemPrompt || data.systemPrompts?.[stage] || '',
            };
          }
          return next;
        });
      })
      .catch(() => setDefaults(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.isAdmin, sourceArticleId]);

  useEffect(() => {
    if (!user?.isAdmin) return;
    api
      .get('/api/workshop/runs')
      .then((data) => setRuns(data.runs ?? []))
      .catch(() => setRuns([]));
  }, [user?.isAdmin]);

  const canUseResumeStages = sourceArticleId && defaults?.hasDebugData;

  // Falls back to stage 1 if the preselected 5 (the common "experiment with
  // this article" entry point) turns out unusable — e.g. the source article
  // predates the pipeline-debug-persistence feature and has no data to
  // resume from.
  useEffect(() => {
    if (defaults && startStage !== 1 && !canUseResumeStages) setStartStage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults, canUseResumeStages]);

  const stagesToConfigure = useMemo(() => LLM_STAGES.filter((s) => s >= startStage), [startStage]);

  if (isLoading) return null;
  if (!user?.isAdmin) return <p className="empty-state">Page not found.</p>;

  function updateStageConfig(stage, patch) {
    setStageConfigs((prev) => ({ ...prev, [stage]: { ...prev[stage], ...patch } }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const stageConfig = {};
      for (const stage of stagesToConfigure) {
        const cfg = stageConfigs[stage];
        const model = cfg.model === OTHER_MODEL ? cfg.customModel.trim() : cfg.model;
        stageConfig[String(stage)] = { provider: cfg.provider, model, systemPrompt: cfg.systemPrompt };
      }
      const run = await api.post('/api/workshop/runs', {
        sourceArticleId: sourceArticleId || undefined,
        claimText: claimText.trim() || undefined,
        startStage,
        stageConfig,
      });
      navigate(`/workshop/${run.run.id}`);
    } catch (err) {
      setError(err.code ?? 'Could not start the run.');
      setSubmitting(false);
    }
  }

  return (
    <div className="workshop-page">
      <h1>Workshop</h1>
      <p className="page-subtitle">
        Resume the pipeline from an existing article with a different model or system prompt, to compare against the
        original.
      </p>

      <form className="workshop-form" onSubmit={handleSubmit}>
        <label>
          Source article id (leave blank to start fresh)
          <input
            type="text"
            value={sourceArticleId}
            onChange={(e) => setSourceArticleId(e.target.value.trim())}
            placeholder="article UUID"
          />
        </label>
        {!sourceArticleId && (
          <label>
            Claim
            <textarea rows={2} value={claimText} onChange={(e) => setClaimText(e.target.value)} />
          </label>
        )}

        <fieldset className="workshop-start-stage">
          <legend>Start from</legend>
          {START_STAGE_OPTIONS.map((option) => {
            const disabled = option.value !== 1 && !canUseResumeStages;
            return (
              <label key={option.value} className={disabled ? 'is-disabled' : ''}>
                <input
                  type="radio"
                  name="startStage"
                  value={option.value}
                  checked={startStage === option.value}
                  disabled={disabled}
                  onChange={() => setStartStage(option.value)}
                />
                {option.label} — {option.hint}
              </label>
            );
          })}
          {sourceArticleId && defaults && !defaults.hasDebugData && (
            <p className="form-error">
              This article has no persisted pipeline debug data, so only "Conspirator" can be used to resume from it.
            </p>
          )}
        </fieldset>

        {stagesToConfigure.map((stage) => {
          const cfg = stageConfigs[stage];
          const known = defaults?.knownModels?.[cfg.provider] ?? [];
          return (
            <fieldset key={stage} className="workshop-stage-config">
              <legend>{START_STAGE_OPTIONS.find((o) => o.value === stage).label} config</legend>
              <label>
                Provider
                <select value={cfg.provider} onChange={(e) => updateStageConfig(stage, { provider: e.target.value })}>
                  {(defaults?.providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Model
                <select value={cfg.model} onChange={(e) => updateStageConfig(stage, { model: e.target.value })}>
                  {known.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value={OTHER_MODEL}>Other…</option>
                </select>
              </label>
              {cfg.model === OTHER_MODEL && (
                <label>
                  Custom model name
                  <input
                    type="text"
                    value={cfg.customModel}
                    onChange={(e) => updateStageConfig(stage, { customModel: e.target.value })}
                    placeholder="e.g. grok-4-1-fast-reasoning"
                  />
                </label>
              )}
              <label>
                System prompt
                <textarea
                  rows={10}
                  value={cfg.systemPrompt}
                  onChange={(e) => updateStageConfig(stage, { systemPrompt: e.target.value })}
                />
              </label>
            </fieldset>
          );
        })}

        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="button-primary" disabled={submitting}>
          {submitting ? 'Starting…' : 'Run'}
        </button>
      </form>

      <h2>Past runs</h2>
      {runs === null ? (
        <p className="empty-state">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="empty-state">No runs yet.</p>
      ) : (
        <ul className="workshop-run-list">
          {runs.map((run) => (
            <li key={run.id}>
              <Link to={`/workshop/${run.id}`}>{run.claimText}</Link>
              <span className={`workshop-status workshop-status-${run.status}`}>{run.status}</span>
              <span className="workshop-run-meta">
                started from stage {run.startStage} · {new Date(run.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
