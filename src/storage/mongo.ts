import { MongoClient, type Db } from 'mongodb';
import { childLogger } from '../utils/logger.js';

const log = childLogger('mongo');

export interface MongoConnection {
  client: MongoClient;
  db: Db;
  close: () => Promise<void>;
}

export async function connectMongo(uri: string, dbName: string): Promise<MongoConnection> {
  const client = new MongoClient(uri, {
    // Reasonable production timeouts.
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
  await client.connect();
  // Verify connectivity early so we fail fast on a bad URI.
  await client.db(dbName).command({ ping: 1 });
  log.info({ dbName }, 'connected to MongoDB');
  const db = client.db(dbName);
  return {
    client,
    db,
    close: async () => {
      await client.close();
      log.info('MongoDB connection closed');
    },
  };
}
