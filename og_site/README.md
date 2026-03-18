# og_site — echocheck / imright.io

Standalone belief-confirming newsfeed app. Enter a belief, get cherry-picked headlines that confirm it, plus expert contrast. Uses ES modules (no build step).

## Run locally

```bash
cd og_site
npm start
```

Then open http://localhost:3000

Or use any static file server:

```bash
npx serve og_site -l 3000
```

## xAI Grok API (optional)

For live AI-generated headlines and refutations, add your xAI API key:

1. Copy `env.example.js` to `env.js`
2. Replace `xai-your-key-here` with your key

Uses Grok 4.1 fast non-reasoning. Without a key, the app falls back to mock data when API calls fail.
