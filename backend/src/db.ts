import { Partition, Persistence } from "./persistence";

const persistence = new Persistence("sqlite://.data/database.sqlite");

export const db = {
  get audio(): Partition {
    return persistence.getPartition("audio");
  },
  roomMetadata(room: string): Partition {
    return persistence.getPartition(`room_${room}`);
  },
};
