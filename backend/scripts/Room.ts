export class Room {
  constructor(public name: string) {}
  get audioTopic() {
    return `${this.name}/audio`;
  }
  get publicTopic() {
    return `${this.name}/audio`;
  }
}
