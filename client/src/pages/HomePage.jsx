import { BeliefForm } from '../components/idea-input/BeliefForm.jsx';
import { DiscoverFeed } from '../components/discover/DiscoverFeed.jsx';

export function HomePage() {
  return (
    <div className="home-page">
      <section className="hero">
        <h1>imright.com</h1>
        <p className="tagline">State any belief. We'll prove you right.</p>
        <BeliefForm />
      </section>
      <DiscoverFeed />
    </div>
  );
}
