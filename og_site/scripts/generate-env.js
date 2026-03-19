#!/usr/bin/env node
/**
 * Generates env.js from XAI_API_KEY at build time.
 * Vercel injects env vars during build; this bakes the key into the client.
 */
const fs = require('fs');
const path = require('path');

const key = process.env.XAI_API_KEY || '';
const outputPath = path.join(__dirname, '..', 'env.js');

const content = `// Generated at build time from XAI_API_KEY
window.ENV = Object.assign({}, window.ENV || {}, {
  XAI_API_KEY: "${key.replace(/"/g, '\\"')}"
});
`;

fs.writeFileSync(outputPath, content, 'utf8');
console.log('Generated env.js');
