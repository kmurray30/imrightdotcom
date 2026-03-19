We're live! Check us out at https://imright.io

## Pipeline (run all at once)

```bash
node imright/cli.js "<claim>"
# or: echo "<claim>" | node imright/cli.js
```

Requires `XAI_API_KEY` in env or `env.local`/`.env` in project root.

## Modules (standalone)

Order:
1. conspirator
2. wiki_searcher
3. wiki_filterer
4. article_extractor
5. tabloid_generator

Each can be run independently or imported. The `imright` orchestrator runs all five in memory and saves outputs in parallel.
