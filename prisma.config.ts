import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

const name = 'DATABASE_URL';

export default defineConfig({
  schema: './src/db/schema.prisma',
  datasource: {
    // Requires env variable even when it's not needed. Why?
    url: process.env[name] ? env(name) : '',
  },
});
