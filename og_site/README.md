# og_site — echocheck / imright.io

Standalone belief-confirming newsfeed app. Enter a belief, get cherry-picked headlines that confirm it, plus expert contrast.

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

## OpenAI API (optional)

For live AI-generated headlines and refutations, add your OpenAI API key:

1. Copy `env.example.js` to `env.js`
2. Replace `sk-your-key-here` with your key

Without a key, the app falls back to mock data when API calls fail.
