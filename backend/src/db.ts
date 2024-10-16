import { Partition, Persistence } from "./persistence";
import type { Room } from "./room";

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
  roomPartials(room: Room): Partition {
    return persistence.getPartition(`partials_${room.name}`);
  },
  roomLogs(room: Room): Partition {
    return persistence.getPartition(`logs_${room.name}`);
  },
};
