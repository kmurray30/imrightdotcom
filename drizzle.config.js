import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './imright/scripts/db/schema.js',
  out: './imright/scripts/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
