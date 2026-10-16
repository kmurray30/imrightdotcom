import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

export function WorkshopRunPage() {
  const { user, isLoading } = useAuth();
  const { runId } = useParams();
  const [run, setRun] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!user?.isAdmin) return undefined;

    function poll() {
      api
        .get(`/api/workshop/runs/${runId}`)
        .then((data) => {
          setRun(data.run);
          if (data.run.status !== 'running' && intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        })
        .catch(() => setNotFound(true));
    }

    poll();
    intervalRef.current = setInterval(poll, 3000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [user?.isAdmin, runId]);

  if (isLoading) return null;
  if (!user?.isAdmin) return <p className="empty-state">Page not found.</p>;
  if (notFound) return <p className="empty-state">Run not found.</p>;
  if (!run) return <p className="empty-state">Loading…</p>;

  return (
    <div className="workshop-page">
      <h1>Workshop run</h1>
      <p className="page-subtitle">{run.claimText}</p>
      <p>
        Status: <span className={`workshop-status workshop-status-${run.status}`}>{run.status}</span>
        {' · '}started from stage {run.startStage}
      </p>

      {run.status === 'running' && <p className="empty-state">Running — this can take a minute or two…</p>}
      {run.status === 'error' && <p className="form-error">{run.errorMessage}</p>}

      {run.status === 'done' && (
        <>
          <h2>Config used</h2>
          <pre className="workshop-stage-config-dump">{JSON.stringify(run.stageConfig, null, 2)}</pre>

          <h2>Compare</h2>
          <div className="workshop-run-compare">
            <div>
              <p className="workshop-compare-label">This run</p>
              <iframe src={`/api/workshop/runs/${run.id}/debug`} title="This run's debug view" />
            </div>
            {run.sourceArticleId && (
              <div>
                <p className="workshop-compare-label">Original article</p>
                <iframe src={`/api/articles/${run.sourceArticleId}/debug`} title="Original article's debug view" />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
