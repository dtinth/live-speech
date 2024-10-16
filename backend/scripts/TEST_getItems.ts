import { getItems } from "../src/itemOperations";
import { Room } from "../src/room";

console.log(await getItems(new Room("019296a2-3c00-7b5c-8913-6cfad0b97093")));
