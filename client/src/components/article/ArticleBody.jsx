import { useEffect, useState } from 'react';
import { HeroImage, SectionImage } from './ArticleImages.jsx';
import { BunkyCallout } from './BunkyCounterarguments.jsx';
import { paragraphText, renderParagraphWithCitations } from './renderCitations.jsx';
import { api } from '../../api/client.js';

function Paragraphs({ paragraphs, citations, className }) {
  const list = Array.isArray(paragraphs) ? paragraphs : paragraphs ? [paragraphs] : [];
  return list.map((paragraph, index) => (
    <p key={index} className={className}>
      {renderParagraphWithCitations(paragraphText(paragraph), citations)}
    </p>
  ));
}

/** Polls for counterarguments if they aren't attached yet (they're generated
 * async, after the article is already viewable — see the plan). Only
 * relevant right after this exact article was just generated; an
 * already-finished article either has them or never will. */
function useCounterarguments(articleId, initial) {
  const [counterarguments, setCounterarguments] = useState(initial ?? null);

  useEffect(() => {
    if (counterarguments) return undefined;
    let cancelled = false;
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts += 1;
      if (attempts > 90) {
        clearInterval(interval); // ~3 minutes at 2s intervals, then give up
        return;
      }
      try {
        const { article } = await api.get(`/api/articles/${articleId}`);
        if (!cancelled && article?.articleData?.counterarguments) {
          setCounterarguments(article.articleData.counterarguments);
          clearInterval(interval);
        }
      } catch {
        // Keep trying until the attempt cap above.
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [articleId, counterarguments]);

  return counterarguments;
}

export function ArticleBody({ articleId, articleData }) {
  const { headline, intro, conclusion, sections = [], citations = [], images, slug } = articleData ?? {};
  const counterarguments = useCounterarguments(articleId, articleData?.counterarguments);

  return (
    <article className="article-body">
      <h1 className="article-headline">{headline}</h1>
      <HeroImage slug={slug} images={images} />
      {intro && <Paragraphs paragraphs={intro} citations={citations} className="article-intro" />}
      {sections.map((section, index) => (
        <section key={index} className="article-section">
          <h2>{section.heading}</h2>
          <SectionImage slug={slug} images={images} sectionIndex={index} />
          <Paragraphs paragraphs={section.paragraphs} citations={citations} className="article-paragraph" />
          <BunkyCallout counterargument={counterarguments?.[index]} />
        </section>
      ))}
      {!sections.length && articleData?.paragraphs && (
        <Paragraphs paragraphs={articleData.paragraphs} citations={citations} className="article-paragraph" />
      )}
      {conclusion && <Paragraphs paragraphs={conclusion} citations={citations} className="article-conclusion" />}
    </article>
  );
}
