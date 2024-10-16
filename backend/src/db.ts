import type { Room } from "../scripts/Room";
import { Partition, Persistence } from "./persistence";

const persistence = new Persistence("sqlite://.data/database.sqlite");

export const db = {
  get audio(): Partition {
    return persistence.getPartition("audio");
  },
  get rooms(): Partition {
    return persistence.getPartition("rooms");
  },
  roomItems(room: Room): Partition {
    return persistence.getPartition(`room_${room.name}`);
  },
};
