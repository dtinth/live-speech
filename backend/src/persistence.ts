import sqlite3 from "sqlite3";

export class Partition {
  private db: sqlite3.Database;

  constructor(db: sqlite3.Database, private partitionKey: string) {
    this.db = db;
  }

  async get(sortKey: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.get<{ value: string }>(
        "SELECT value FROM keyvalue WHERE partition = ? AND key = ?",
        [this.partitionKey, sortKey],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? JSON.parse(row.value) : undefined);
        }
      );
    });
  }

  async set(sortKey: string, value: any): Promise<void> {
    const serializedValue = JSON.stringify(value);
    return new Promise((resolve, reject) => {
      this.db.run(
        "INSERT OR REPLACE INTO keyvalue (partition, key, value) VALUES (?, ?, ?)",
        [this.partitionKey, sortKey, serializedValue],
        function (err: Error | null) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async *[Symbol.asyncIterator]() {
    const rows = await new Promise<any[]>((resolve, reject) => {
      this.db.all(
        "SELECT key, value FROM keyvalue WHERE partition = ?",
        [this.partitionKey],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    for (const row of rows) {
      yield [row.key, JSON.parse(row.value)];
    }
  }
}

export class Persistence {
  private db: sqlite3.Database;
  private partitions: Map<string, Partition> = new Map();

  constructor(connectionString: string) {
    this.db = new sqlite3.Database(connectionString, (err) => {
      if (err) {
        console.error("Error opening database:", err.message);
      } else {
        this.initializeDatabase();
      }
    });
  }

  private initializeDatabase() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS keyvalue (
        partition TEXT,
        key TEXT,
        value TEXT,
        PRIMARY KEY (partition, key)
      )
    `);
  }

  getPartition(partitionKey: string): Partition {
    if (!this.partitions.has(partitionKey)) {
      this.partitions.set(partitionKey, new Partition(this.db, partitionKey));
    }
    return this.partitions.get(partitionKey)!;
  }
}
