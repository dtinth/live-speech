import KeyvSqlite from "@keyv/sqlite";
import Keyv from "keyv";

export class Partition {
  private keyv: Keyv;

  constructor(store: any, private partitionKey: string) {
    this.keyv = new Keyv({ store, namespace: partitionKey });
  }

  async get(sortKey: string): Promise<any> {
    return this.keyv.get(sortKey);
  }

  async set(sortKey: string, value: any): Promise<void> {
    await this.keyv.set(sortKey, value);
  }

  async *[Symbol.asyncIterator]() {
    console.log(this.partitionKey, this.keyv.opts.namespace);
    yield* (this.keyv.iterator as any)() as AsyncIterable<[string, any]>;
  }
}

export class Persistence {
  private store: any;
  private partitions: Map<string, Partition> = new Map();

  constructor(connectionString: string) {
    this.store = new KeyvSqlite(connectionString);
  }

  getPartition(partitionKey: string): Partition {
    if (!this.partitions.has(partitionKey)) {
      this.partitions.set(
        partitionKey,
        new Partition(this.store, partitionKey)
      );
    }
    return this.partitions.get(partitionKey)!;
  }
}
