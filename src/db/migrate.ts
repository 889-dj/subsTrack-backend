import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connection, db } from './client.js';

async function main(): Promise<void> {
  await migrate(db, { migrationsFolder: './drizzle' });
  await connection.end();
  console.log('Database migrations applied.');
}

main().catch(async (error) => {
  console.error('Database migration failed:', error);
  await connection.end().catch(() => undefined);
  process.exit(1);
});
