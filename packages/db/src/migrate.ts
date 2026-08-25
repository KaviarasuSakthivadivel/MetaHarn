import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const connectionString = process.env.DATABASE_URL ?? "postgres://metaharn:metaharn@localhost:5432/metaharn";

const client = postgres(connectionString, { max: 1 });
const db = drizzle(client);

// The pgvector/pgvector image ships the extension but doesn't enable it per
// database — drizzle-kit generate doesn't emit this statement itself, so it
// runs here rather than depending on it having been done out-of-band.
await client`CREATE EXTENSION IF NOT EXISTS vector`;

await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
await client.end();
console.log("Migrations applied.");
