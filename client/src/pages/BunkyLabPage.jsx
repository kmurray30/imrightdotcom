import { useEffect, useRef, useState } from 'react';
import { Bunky } from '../components/bunky/Bunky.jsx';
import { EXPRESSIONS, REACTIONS, RESTING, planTransition } from '../components/bunky/expressions.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BLINK_OPTIONS = { auto: 'auto', on: true, off: false };
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

function ExpressionSelect({ label, value, onChange }) {
  return (
    <label className="bunky-lab-field">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {[
          ['Resting', RESTING],
          ['Reactions', REACTIONS],
        ].map(([group, names]) => (
          <optgroup key={group} label={group}>
            {names.map((name) => (
              <option key={name} value={name}>
                {EXPRESSIONS[name].label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

/** Unlinked playground for Bunky's expressions: pick any start and end
 * expression and watch the automatic transition between them. */
export function BunkyLabPage() {
  const bunky = useRef(null);
  const [start, setStart] = useState('skeptical');
  const [end, setEnd] = useState('surprised');
  const [blink, setBlink] = useState('auto');
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [idle, setIdle] = useState(false);
  const [scrub, setScrub] = useState(0);

  const opts = { blink: BLINK_OPTIONS[blink], speed };
  const plan = planTransition(start, end, opts);

  const play = (from = start, to = end) => {
    setScrub(1);
    return bunky.current.play(from, to, opts);
  };

  // Ping-pong between start and end while Loop is on.
  useEffect(() => {
    if (!loop) return undefined;
    let cancelled = false;
    (async () => {
      let [a, b] = [start, end];
      while (!cancelled) {
        await bunky.current.play(a, b, { blink: BLINK_OPTIONS[blink], speed });
        await sleep(900 / speed);
        [a, b] = [b, a];
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loop, start, end, blink, speed]);

  const chooseStart = (name) => {
    setStart(name);
    setScrub(0);
    bunky.current.preview(name, end, 0, opts);
  };
  const chooseEnd = (name) => {
    setEnd(name);
    if (!loop) play(start, name);
  };
  // Clicking a tile carries on from wherever he is now: the old end
  // becomes the start.
  const pickTile = (name) => {
    setStart(end);
    setEnd(name);
    if (!loop) play(end, name);
  };
  const swap = () => {
    setStart(end);
    setEnd(start);
    if (!loop) play(end, start);
  };
  const playAndReturn = async () => {
    await play();
    await sleep(1200 / speed);
    bunky.current.play(end, start, opts);
  };
  const onScrub = (value) => {
    setLoop(false);
    setScrub(value);
    bunky.current.preview(start, end, value, opts);
  };

  const tile = (name) => (
    <button
      key={name}
      type="button"
      className={`bunky-tile${name === start ? ' is-start' : ''}${name === end ? ' is-end' : ''}`}
      onClick={() => pickTile(name)}
    >
      <Bunky expression={name} size={84} shadow={false} title="" />
      <span>{EXPRESSIONS[name].label}</span>
      {(name === start || name === end) && <small className="bunky-tile-badge">{name === end ? 'End' : 'Start'}</small>}
    </button>
  );

  return (
    <div className="bunky-lab">
      <h1>Bunky expressions</h1>
      <p className="page-subtitle">Pick any two expressions and watch Bunky move between them, or click a face below to go there next.</p>

      <div className="bunky-lab-top">
        <div className="bunky-lab-stage">
          {/* Driven through the ref only: a changing expression prop would
              animate on its own and fight the transitions started here. */}
          <Bunky ref={bunky} expression="skeptical" idle={idle} size={280} />
        </div>

        <div className="bunky-lab-controls">
          <div className="bunky-lab-row">
            <ExpressionSelect label="Start" value={start} onChange={chooseStart} />
            <button type="button" onClick={swap} aria-label="Swap start and end">
              ⇄
            </button>
            <ExpressionSelect label="End" value={end} onChange={chooseEnd} />
          </div>

          <div className="bunky-lab-row">
            <button type="button" className="button-primary" onClick={() => play()}>
              Play
            </button>
            <button type="button" onClick={playAndReturn}>
              Play &amp; return
            </button>
            <button type="button" onClick={() => bunky.current.hop()}>
              Hop
            </button>
            <button type="button" onClick={() => bunky.current.blink()}>
              Blink
            </button>
          </div>

          <label className="bunky-lab-field bunky-lab-scrub">
            Scrub
            <input type="range" min="0" max="1" step="0.005" value={scrub} onChange={(e) => onScrub(Number(e.target.value))} />
          </label>

          <div className="bunky-lab-row">
            <label className="bunky-lab-field">
              Blink between
              <select value={blink} onChange={(e) => setBlink(e.target.value)}>
                <option value="auto">Auto</option>
                <option value="on">Always</option>
                <option value="off">Never</option>
              </select>
            </label>
            <label className="bunky-lab-field">
              Speed
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="bunky-lab-row">
            <label className="bunky-lab-check">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Ping-pong loop
            </label>
            <label className="bunky-lab-check">
              <input type="checkbox" checked={idle} onChange={(e) => setIdle(e.target.checked)} /> Idle (breathe, blink, glance)
            </label>
          </div>

          <p className="bunky-lab-plan">
            {Math.round(plan.duration)} ms · {plan.blink ? 'blinks midway' : 'no blink'} ·{' '}
            {plan.overshoot ? 'snaps in with overshoot and a jolt' : 'eases in'}
          </p>
          <code className="bunky-lab-code">
            {`<Bunky expression="${end}" />  ·  bunky.current.react('${end}')`}
          </code>
        </div>
      </div>

      <h2>Resting</h2>
      <div className="bunky-tiles">{RESTING.map(tile)}</div>
      <h2>Reactions</h2>
      <div className="bunky-tiles">{REACTIONS.map(tile)}</div>
    </div>
  );
}
