import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

export function FeedbackPage() {
  const { user, isLoading } = useAuth();
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    if (!user?.isAdmin) return;
    api
      .get('/api/feedback')
      .then((data) => setFeedback(data.feedback ?? []))
      .catch(() => setFeedback([]));
  }, [user?.isAdmin]);

  if (isLoading) return null;
  if (!user?.isAdmin) return <p className="empty-state">Page not found.</p>;
  if (feedback === null) return <p className="empty-state">Loading…</p>;

  return (
    <div className="feedback-page">
      <h1>Feedback</h1>
      {feedback.length === 0 ? (
        <p className="empty-state">No feedback yet.</p>
      ) : (
        <ul className="feedback-list">
          {feedback.map((item) => (
            <li key={item.id}>
              <p className="feedback-message">{item.message}</p>
              <p className="feedback-meta">
                {item.username ? `@${item.username}` : item.email} · {new Date(item.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
