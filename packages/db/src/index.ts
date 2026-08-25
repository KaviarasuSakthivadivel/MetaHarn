import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL ?? "postgres://metaharn:metaharn@localhost:5432/metaharn";

const client = postgres(connectionString);
export const db = drizzle(client, { schema });
export * from "./schema.js";
