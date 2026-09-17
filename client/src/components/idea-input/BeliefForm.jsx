import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RunProgress, VISIBLE_STAGES } from './RunProgress.jsx';

/** Port of index.html's belief-form submit flow: POST /api/run, then an SSE
 * stream of progress until `ready`. The one deliberate behavior change from
 * before this feature: on `ready`, this navigates client-side (React
 * Router's navigate) instead of a hard `window.location.href` redirect —
 * an SPA-appropriate improvement, not a regression (see the plan). */
export function BeliefForm() {
  const [claim, setClaim] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [stepName, setStepName] = useState('');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState(null);
  const eventSourceRef = useRef(null);
  const navigate = useNavigate();

  function handleStreamEvent(event) {
    if (event.type === 'progress') {
      if (event.step > VISIBLE_STAGES) return;
      setStepName(event.name);
    } else if (event.type === 'stepComplete') {
      const completedStep = Math.min(event.step, VISIBLE_STAGES);
      setPercent((completedStep / VISIBLE_STAGES) * 100);
    } else if (event.type === 'ready') {
      setStepName('Done. Opening your article...');
      setPercent(100);
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      navigate(event.url);
    } else if (event.type === 'error') {
      setError(event.message || 'Pipeline failed.');
      setIsSubmitting(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const trimmed = claim.trim();
    if (!trimmed) return;

    setError(null);
    setIsSubmitting(true);
    setStepName('Assembling the case...');
    setPercent(0);

    let runId;
    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim: trimmed }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || `Request failed (${response.status})`);
      }
      ({ runId } = await response.json());
    } catch (startError) {
      setError(startError.message || 'Could not start the pipeline.');
      setIsSubmitting(false);
      return;
    }

    eventSourceRef.current?.close();
    const eventSource = new EventSource(`/api/stream/${runId}`);
    eventSourceRef.current = eventSource;
    eventSource.onmessage = (messageEvent) => {
      try {
        handleStreamEvent(JSON.parse(messageEvent.data));
      } catch (parseError) {
        console.error('Bad SSE payload', parseError);
      }
    };
  }

  return (
    <div className="belief-form-wrapper">
      <form className="belief-form" onSubmit={handleSubmit}>
        <input
          className="belief-input"
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          placeholder="State your belief..."
          disabled={isSubmitting}
          required
        />
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Working…' : 'Prove me right!'}
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      {isSubmitting && <RunProgress stepName={stepName} percent={percent} />}
    </div>
  );
}
