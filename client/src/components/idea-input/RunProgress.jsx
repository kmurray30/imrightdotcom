const VISIBLE_STAGES = 6; // step 7 (counterarguments) runs after the article is already shown

export function RunProgress({ stepName, percent }) {
  return (
    <div className="run-progress is-visible">
      <div className="run-progress-bar-track">
        <div className="run-progress-bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="run-progress-label">{stepName}</p>
    </div>
  );
}

export { VISIBLE_STAGES };
