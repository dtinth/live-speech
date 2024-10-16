import KeyvSqlite from "@keyv/sqlite";
import Keyv from "keyv";

const store = new KeyvSqlite("sqlite://.data/test.db");

const keyvA = new Keyv({ store, namespace: "a" });
const keyvB = new Keyv({ store, namespace: "b" });

async function main() {
  await keyvA.set("a", "x");
  await keyvA.set("b", "y");
  await keyvA.set("c", "z");

  await keyvB.set("a", "one");
  await keyvB.set("b", "two");
  await keyvB.set("c", "three");

  console.log("=== From A ===");
  for await (const [key, value] of keyvA.iterator()) {
    console.log(key, value);
  }
  console.log("=== From B ===");
  for await (const [key, value] of keyvB.iterator()) {
    console.log(key, value);
  }
}

main();
