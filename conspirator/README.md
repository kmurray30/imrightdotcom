# Conspirator

Generates possible bad-faith argument angles for a given topic, each with search queries to find corroborating articles. Uses Grok 4.1 fast non-reasoning via the XAI API.

## Setup

Set `XAI_API_KEY` in your environment, or add it to `env.local` in the project root (the script auto-loads it).

## Usage

```bash
node generate-angles.js "5G causes cancer"
```

Or via stdin:

```bash
echo "vaccines cause autism" | node generate-angles.js
```

## Output

JSON with `topic`, `generated_at`, and `angles`. Each angle has:
- `argument`: Description of the bad-faith argument angle
- `search_queries`: Array of search queries to find corroborating articles
